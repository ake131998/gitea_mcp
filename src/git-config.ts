import { readFile } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
import {
  type AuthScheme,
  type CandidateCredential,
  type CredentialDiscoveryResult,
  type CredentialSource,
  orderSchemesForCredentialStore,
} from "./credentials.js";

/** A single parsed git remote. `remote` is the remote name (`origin`, `upstream`, ...). */
export interface ParsedRemote {
  remote: string;
  url: string;
  host: string;
  baseUrl: string;
  owner: string;
  repo: string;
}

/** A raw `[remote "<name>"]` url entry extracted from a git config file. */
export interface RawRemote {
  name: string;
  url: string;
}

export interface DiscoverOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Options for host-scoped credential re-discovery (runtime configuration).
 * Unlike `DiscoverOptions`, a `baseUrl` is required so protocol/host can be
 * derived; `username` optionally narrows git's credential lookup to a single
 * identity.
 */
export interface DiscoverCredentialsForHostOptions {
  baseUrl: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * When set, the git credential lookup is narrowed to this identity — the
   * username is fed to `git credential fill` AND the helper-returned username
   * is strictly filtered (`returned === username`), with no fallback to other
   * identities. `undefined` means "no username filter" (git picks the
   * credential it would use for this host).
   */
  username?: string;
  /** `owner/repo` path fed to `git credential fill` (used by helpers honoring `credential.useHttpPath`). */
  repoPath?: string;
}

/**
 * Result of host-scoped discovery. `gitAvailable` is false when the git
 * binary could not be used at all (missing, failed to spawn, or timed out) —
 * in that case only the `GITEA_TOKEN` env source can yield candidates, and
 * diagnostics should guide the user to install git or set `GITEA_TOKEN`.
 */
export interface DiscoverCredentialsForHostResult {
  candidates: CandidateCredential[];
  gitAvailable: boolean;
}

/**
 * Platform-specific knobs for the three-source credential discovery. Each
 * platform keeps its own env var, git config section, source tag, and auth
 * scheme set so a Gitea env token can never be collected for a GitLab host
 * (and vice versa). The discovery pipeline itself (git subprocesses + remote
 * parsing) is shared.
 */
interface PlatformCredentialSources {
  /** Git config section holding the instance token (`[<section> "<url>"] token`). */
  configSection: "gitea" | "gitlab";
  /** Env var holding a fallback token. */
  envTokenVar: "GITEA_TOKEN" | "GITLAB_TOKEN";
  /** Env var holding a self-contained credentialed repo URL (parsed by `parseRepoUrl`). */
  envRepoUrlVar: "GITEA_REPO_URL" | "GITLAB_REPO_URL";
  /** `CredentialSource` recorded on config-token candidates. */
  configSource: CredentialSource;
  /** Scheme list for config/env token candidates. */
  tokenSchemes: AuthScheme[];
  /** Scheme list for credential-store entries returning only a username. */
  storeUsernameOnlySchemes: AuthScheme[];
  /**
   * Scheme order for credential-store entries holding a password. Gitea uses
   * the username heuristic (`orderSchemesForCredentialStore`); GitLab's API
   * documents only token headers, so it is `bearer`-only regardless of user.
   * Also applied to repo-URL candidates — their userinfo is the same
   * `user:secret` shape as a credential-store entry.
   */
  storePasswordSchemes: (username?: string) => AuthScheme[];
}

/** Gitea discovery sources — the historical behavior, unchanged. */
const GITEA_SOURCES: PlatformCredentialSources = {
  configSection: "gitea",
  envTokenVar: "GITEA_TOKEN",
  envRepoUrlVar: "GITEA_REPO_URL",
  configSource: "gitea-config",
  tokenSchemes: ["token"],
  storeUsernameOnlySchemes: ["token", "basic"],
  storePasswordSchemes: orderSchemesForCredentialStore,
};

/** GitLab discovery sources — `[gitlab]` config key, `GITLAB_TOKEN` env, Bearer schemes. */
const GITLAB_SOURCES: PlatformCredentialSources = {
  configSection: "gitlab",
  envTokenVar: "GITLAB_TOKEN",
  envRepoUrlVar: "GITLAB_REPO_URL",
  configSource: "gitlab-config",
  tokenSchemes: ["bearer"],
  storeUsernameOnlySchemes: ["bearer"],
  storePasswordSchemes: () => ["bearer"],
};

/**
 * Upper bound for one git subprocess invocation. A hung credential helper
 * (e.g. an askpass program waiting for a GUI) must never block discovery or
 * the `configure_gitea` tool indefinitely.
 */
const GIT_EXEC_TIMEOUT_MS = 10_000;

/** Outcome of one git subprocess invocation (see `execGit`). */
interface GitExecResult {
  /** false when the git binary could not be run (missing / spawn error / killed by timeout). */
  unavailable: boolean;
  /** true when git exited 0. */
  ok: boolean;
  /** Process exit code when git ran (0 on success), null when unavailable. */
  exitCode: number | null;
  /** Decoded stdout — may carry secrets for `credential fill`; never log or interpolate it into errors. */
  stdout: string;
}

/**
 * Run one git subprocess non-interactively and classify its outcome.
 *
 * - `GIT_TERMINAL_PROMPT=0` is forced: `git credential fill` may otherwise
 *   prompt on the terminal, whose stdio belongs to the MCP protocol.
 * - The `timeout` option kills a hung subprocess (SIGTERM) — classified as
 *   `unavailable` rather than an error, so discovery degrades to env-only
 *   instead of hanging (same policy as a missing git binary).
 * - A non-zero exit is a normal negative result ("git reports no value"),
 *   the subprocess equivalent of `readOptionalFile`'s ENOENT → "" mapping.
 * - SECURITY: stdout may carry the secret itself; it is returned to the
 *   caller but MUST NOT be interpolated into error messages or logs.
 */
function execGit(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
): Promise<GitExecResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        env: { ...opts.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: GIT_EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (err) {
          // Exit code (number) without a kill: git ran and reported a
          // negative result. Anything else (spawn ENOENT, EACCES, killed by
          // the timeout) means git could not be used at all.
          if (typeof err.code === "number" && !err.killed) {
            resolvePromise({ unavailable: false, ok: false, exitCode: err.code, stdout: "" });
          } else {
            resolvePromise({ unavailable: true, ok: false, exitCode: null, stdout: "" });
          }
          return;
        }
        resolvePromise({ unavailable: false, ok: true, exitCode: 0, stdout: stdout ?? "" });
      },
    );
    if (opts.stdin !== undefined && child.stdin) {
      // EPIPE here duplicates the failure already reported through the
      // execFile callback above (git exited before reading stdin); only the
      // redundant stream-level event is dropped, never the underlying error.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
    }
  });
}

/**
 * Read the `[gitea "<url>"] token` / `[gitlab "<url>"] token` value (or the
 * bare `[<section>] token` form) through git's own config machinery:
 * `git config get --url=<baseUrl> <section>.token`. The `--url` lookup
 * returns the best URL-matching subsection and falls back to the bare
 * `[<section>]` section natively (git-config(1)), while reading the
 * secret via git's stdout instead of a `node:fs` file read (which was the
 * CodeQL `js/file-access-to-http` source). Requires git ≥ 2.46 (`config get`).
 *
 * NOTE — matching is git's urlmatch, not the old exact-string section match:
 * it normalizes URLs, so e.g. a scoped section whose name carries a trailing
 * slash matches a baseUrl without one (the old in-process parser did not).
 * Exit-code caveat: on git < 2.46 the unknown `get` subcommand also exits 1 —
 * indistinguishable from "key not present" — so the config-token source fails
 * silently there (credential `fill` still works; only `[gitea]`/`[gitlab]`
 * tokens are lost). This cannot be discriminated without stderr parsing,
 * which is deliberately avoided; the requirement is documented in the README
 * instead.
 */
async function gitConfigTokenForUrl(
  baseUrl: string,
  section: "gitea" | "gitlab",
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ unavailable: boolean; token?: string }> {
  const result = await execGit(
    ["config", "get", `--url=${baseUrl}`, `${section}.token`],
    { cwd, env },
  );
  if (result.unavailable) return { unavailable: true };
  // Exit 1 is the documented "key not present"; any other non-zero exit is
  // treated the same way (no token from this source) rather than crashing
  // the server — the candidate list in `gitea_status` makes the absence
  // visible and actionable.
  if (!result.ok) return { unavailable: false };
  const token = result.stdout.trim();
  if (!token) return { unavailable: false };
  return { unavailable: false, token };
}

/** Attributes extracted from `git credential fill` stdout. */
interface FillResult {
  unavailable: boolean;
  username?: string;
  password?: string;
}

/**
 * Validate one credential-description attribute value: git's stdin format is
 * line-oriented (`key=value\n`), so a value containing a newline/CR/NUL would
 * inject ADDITIONAL attribute lines — e.g. a `repoPath` of `x\nhost=evil\n`
 * would override the host and make `git credential fill` return the
 * credential stored for `evil` (an untrusted MCP client controls `owner`/
 * `repo`/`username` via configure_gitea; see server.ts's trust-boundary
 * notes). Reject such values outright — never silently strip.
 */
function assertCredentialAttribute(kind: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(
      `Invalid ${kind} for git credential lookup: line breaks are not allowed.`,
    );
  }
}

/**
 * Ask git for the credential it would use for a host via
 * `git credential fill`: feed the credential description (key=value lines
 * terminated by a blank line) on stdin, read `username=` / `password=` from
 * stdout (git-credential(1)). This consults git's full credential machinery
 * (config chain + every configured helper — including OS keychain helpers
 * like wincred / osxkeychain / libsecret), making git the single canonical
 * parser of credential storage; the secret enters this process via
 * subprocess stdout, not a `node:fs` file read.
 *
 * SECURITY: every attribute value is validated by `assertCredentialAttribute`
 * first — the description is line-oriented, and an embedded newline in
 * `path`/`username` (both ultimately MCP-client-controlled) could inject a
 * forged `host=` line and redirect the lookup to an arbitrary host's stored
 * credential. `protocol`/`host` come from `new URL(baseUrl)` and cannot carry
 * newlines, but are validated too (defense in depth).
 *
 * Semantics (git answers, we do not enumerate):
 * - With `username` fed on stdin, helpers are asked for that exact identity;
 *   the returned username is still strictly filtered by the caller.
 * - Without it, git returns the credential it would use — the first matching
 *   store entry in file order — not every host-matching entry.
 * - Empty values (`username=`) map to undefined; git exits non-zero when no
 *   helper can complete the credential, which maps to "no candidate" (the
 *   terminal prompt is disabled, so missing credentials cannot block).
 */
async function gitCredentialFill(input: {
  protocol: string;
  host: string;
  path?: string;
  username?: string;
}, cwd: string, env: NodeJS.ProcessEnv): Promise<FillResult> {
  assertCredentialAttribute("protocol", input.protocol);
  assertCredentialAttribute("host", input.host);
  if (input.path !== undefined) assertCredentialAttribute("path", input.path);
  if (input.username !== undefined) assertCredentialAttribute("username", input.username);
  const description = [
    `protocol=${input.protocol}`,
    `host=${input.host}`,
    ...(input.path !== undefined ? [`path=${input.path}`] : []),
    ...(input.username !== undefined ? [`username=${input.username}`] : []),
    "", // blank line terminates the credential description
  ].join("\n");
  const result = await execGit(["credential", "fill"], { cwd, env, stdin: description });
  if (result.unavailable) return { unavailable: true };
  if (!result.ok) return { unavailable: false };

  let username: string | undefined;
  let password: string | undefined;
  for (const line of result.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "username" && value !== "") username = value;
    if (key === "password" && value !== "") password = value;
  }
  return { unavailable: false, username, password };
}

/**
 * Build a `CandidateCredential` from a `git credential fill` result.
 * Scheme selection comes from the platform's `PlatformCredentialSources`:
 * - password present → secret = password, username preserved; scheme order
 *   from `storePasswordSchemes` (the Gitea username heuristic preserves the
 *   store conventions of the old in-process parser).
 * - username only (a helper returned just the identity — or a token stored
 *   in the username position) → secret = username, `storeUsernameOnlySchemes`.
 */
function candidateFromFill(
  username: string | undefined,
  password: string | undefined,
  sources: PlatformCredentialSources,
): CandidateCredential | null {
  if (password) {
    return {
      source: "credential-store",
      username,
      secret: password,
      schemes: sources.storePasswordSchemes(username),
      status: "pending",
      nextSchemeIndex: 0,
    };
  }
  if (username) {
    return {
      source: "credential-store",
      secret: username,
      schemes: sources.storeUsernameOnlySchemes,
      status: "pending",
      nextSchemeIndex: 0,
    };
  }
  return null;
}

/**
 * Build a `CandidateCredential` from a parsed repo URL (see `parseRepoUrl`).
 * Scheme selection mirrors `candidateFromFill` — the userinfo is exactly a
 * credential-store-shaped `user:secret` pair, so a `user:secret` URL follows
 * the platform's password heuristic and a token stored in the username
 * position follows the username-only scheme list.
 */
function candidateFromRepoUrl(
  parsed: ParsedRepoUrl,
  sources: PlatformCredentialSources,
): CandidateCredential | null {
  if (parsed.secret === undefined) return null;
  if (parsed.username !== undefined) {
    return {
      source: "repo-url",
      username: parsed.username,
      secret: parsed.secret,
      schemes: sources.storePasswordSchemes(parsed.username),
      status: "pending",
      nextSchemeIndex: 0,
    };
  }
  return {
    source: "repo-url",
    secret: parsed.secret,
    schemes: sources.storeUsernameOnlySchemes,
    status: "pending",
    nextSchemeIndex: 0,
  };
}

/**
 * Sanitize an owner/repo segment extracted from file content by retaining
 * only characters valid in Gitea repository names (alphanumeric, dot, dash,
 * underscore). Returns null when nothing remains, signalling the caller to
 * discard the remote. This breaks the CodeQL file-access-to-http taint chain
 * at the source rather than at the fetch call site.
 */
function sanitizeSegment(value: string): string | null {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "");
  return sanitized || null;
}

/**
 * Parse a git remote URL into host/baseUrl/owner/repo. Accepts `ssh://`, the
 * scp-like `user@host:owner/repo` form, and `http(s)://`. SSH URLs derive an
 * `https://` baseUrl because the Gitea API is served over HTTP(S); a non-standard
 * web port cannot be inferred from an SSH URL — use an HTTPS remote or GITEA_BASE_URL.
 */
export function parseGitRemoteUrl(url: string, remote = "origin"): ParsedRemote | null {
  const u = url.trim();

  let m = u.match(/^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (m) {
    const [, host, owner, repo] = m;
    const so = sanitizeSegment(owner);
    const sr = sanitizeSegment(repo);
    if (!so || !sr) return null;
    return { remote, url: u, host, baseUrl: `https://${host}`, owner: so, repo: sr };
  }

  m = u.match(/^(https?:)\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::(\d+))?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (m) {
    const [, scheme, host, port, owner, repo] = m;
    const so = sanitizeSegment(owner);
    const sr = sanitizeSegment(repo);
    if (!so || !sr) return null;
    const baseUrl = port ? `${scheme}//${host}:${port}` : `${scheme}//${host}`;
    return { remote, url: u, host: port ? `${host}:${port}` : host, baseUrl, owner: so, repo: sr };
  }

  m = u.match(/^(?:[^@/\s]+@)?([^@:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (m) {
    const [, host, owner, repo] = m;
    const so = sanitizeSegment(owner);
    const sr = sanitizeSegment(repo);
    if (!so || !sr) return null;
    return { remote, url: u, host, baseUrl: `https://${host}`, owner: so, repo: sr };
  }

  return null;
}

/**
 * A repo URL — one self-contained git clone URL carrying username, secret,
 * instance host, owner, and repo. `baseUrl` is rebuilt with the userinfo
 * stripped (the same shape `parseGitRemoteUrl` produces), so no field of this
 * result ever contains the raw URL or the secret-carrying userinfo.
 */
export interface ParsedRepoUrl {
  /** `scheme://host[:port]` — userinfo stripped. */
  baseUrl: string;
  owner: string;
  repo: string;
  /** Username from the userinfo; undefined for `https://<token>@host` URLs. */
  username?: string;
  /**
   * The secret carried by the URL: the password when one is present, else the
   * username itself (the `https://<token>@host` convention mirrors a
   * credential-store entry whose username position holds the token).
   * Undefined for a credential-less URL — that source yields no candidate.
   */
  secret?: string;
}

/**
 * Parse a `GITEA_REPO_URL` / `GITLAB_REPO_URL` value into its connection
 * parts. Accepts the http(s) clone grammar with embedded credentials
 * (`https://<user>:<token>@<host>[:<port>]/<owner>/<repo>[.git]`); scp-like
 * and ssh-protocol shapes are rejected — the userinfo is where the secret
 * lives. Returns null for anything unparseable so a malformed value is
 * ignored instead of crashing startup. SECURITY: the raw input is never
 * thrown or echoed, and the result never carries the userinfo.
 */
export function parseRepoUrl(raw: string): ParsedRepoUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // Exactly `<owner>/<repo>[.git]` — deeper paths are not a Gitea repo URL.
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const owner = sanitizeSegment(segments[0] ?? "");
  const repo = sanitizeSegment((segments[1] ?? "").replace(/\.git$/, ""));
  if (!owner || !repo) return null;

  // URL keeps userinfo percent-encoded; the secret must be the literal value
  // the user put behind the scheme. A malformed escape cannot be decoded —
  // ignore the source rather than guess.
  let username: string | undefined;
  let secret: string | undefined;
  try {
    const u = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const p = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    if (p !== undefined) {
      username = u;
      secret = p;
    } else if (u !== undefined) {
      // Token stored in the username position (`https://<token>@host/...`) —
      // mirror the credential-store username-only convention.
      secret = u;
    }
  } catch {
    return null;
  }

  return { baseUrl: `${parsed.protocol}//${parsed.host}`, owner, repo, username, secret };
}

/**
 * Strip `user[:pass]@` userinfo from a URL so a credentialed remote never
 * reaches tool output (`resolve_repo` would otherwise echo remote urls
 * verbatim). Values that are not scheme-shaped URLs (scp-like
 * `git@host:owner/repo`) or carry no userinfo pass through unchanged.
 */
export function stripUrlUserInfo(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!parsed.username && !parsed.password) return raw;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Extract every `[remote "<name>"]` url entry from a git config file's contents. */
export function readGitRemotes(content: string): RawRemote[] {
  const remotes: RawRemote[] = [];
  let currentName: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const section = rawLine.match(/^\s*\[remote\s+"([^"]+)"\]/);
    if (section) {
      currentName = section[1];
      continue;
    }
    if (/^\s*\[[^\]]+\]/.test(rawLine)) {
      currentName = null;
      continue;
    }
    if (currentName !== null) {
      const urlMatch = rawLine.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (urlMatch) {
        remotes.push({ name: currentName, url: urlMatch[1] });
        currentName = null;
      }
    }
  }
  return remotes;
}

/** Parse all remotes in a git config file's contents, dropping unparseable urls. */
export function parseRemotes(content: string): ParsedRemote[] {
  return readGitRemotes(content)
    .map((r) => parseGitRemoteUrl(r.url, r.name))
    .filter((r): r is ParsedRemote => r !== null);
}

/** Pick the remote to derive values from: `upstream` first, then `origin`, then the first. */
export function selectRemote(remotes: ParsedRemote[]): ParsedRemote | null {
  if (remotes.length === 0) return null;
  return (
    remotes.find((r) => r.remote === "upstream") ??
    remotes.find((r) => r.remote === "origin") ??
    remotes[0]
  );
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return "";
  }
}

/**
 * Resolve the absolute path to the git config file for a working directory,
 * handling both normal repositories and linked working trees (`git worktree`).
 *
 * In a normal repo `<cwd>/.git` is a directory and config lives at
 * `<cwd>/.git/config`. In a linked worktree `<cwd>/.git` is a FILE whose
 * `gitdir: <path>` line points at a private per-worktree directory; that
 * directory's `commondir` file (absolute, or relative to itself) points at the
 * shared common directory where `config` actually lives. A submodule uses the
 * same `gitdir:` pointer but has no `commondir`, so its config is read directly
 * from the pointed-to directory.
 *
 * Used for the remote-listing reads (baseUrl/owner/repo discovery and the
 * `resolve_repo` tool) — secret retrieval goes through git itself instead
 * (`gitConfigTokenForUrl` / `gitCredentialFill`), so this module never parses
 * secret-bearing file content in-process.
 *
 * When no `.git` exists at all the conventional path is returned so the caller
 * can treat the missing file as empty content.
 */
export async function resolveGitConfigPath(cwd: string): Promise<string> {
  const dotGit = join(cwd, ".git");
  const conventionalConfig = join(dotGit, "config");

  // Read .git in a single operation to avoid a TOCTOU race: a separate
  // stat + readFile would let the entry be swapped between check and use.
  // EISDIR means .git is a directory (normal repo); ENOENT means absent.
  let gitFile: string;
  try {
    gitFile = await readFile(dotGit, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EISDIR" || code === "ENOENT") return conventionalConfig;
    throw err;
  }

  // .git is a file — parse the gitdir pointer (worktree / submodule).
  const m = gitFile.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return conventionalConfig;

  const gitdir = isAbsolute(m[1]) ? m[1] : resolve(cwd, m[1]);

  const commondirRaw = await readOptionalFile(join(gitdir, "commondir"));
  const commondirTrimmed = commondirRaw.trim();
  if (commondirTrimmed) {
    const common = isAbsolute(commondirTrimmed)
      ? commondirTrimmed
      : resolve(gitdir, commondirTrimmed);
    return join(common, "config");
  }

  // Submodule (gitdir without commondir): config lives in the gitdir itself.
  return join(gitdir, "config");
}

/**
 * Re-run the four-source credential discovery for an explicit baseUrl.
 *
 * Sources (in priority order):
 *   1. `GITEA_REPO_URL` / `GITLAB_REPO_URL` — a self-contained credentialed
 *      repo URL (see `parseRepoUrl`); collected only when the URL's host
 *      matches `baseUrl`, so its secret is never attempted against another
 *      instance (e.g. after a configure-time base_url switch).
 *   2. `[gitea "<baseUrl>"] token` / bare `[gitea] token` via
 *      `git config get --url=<baseUrl> gitea.token`.
 *   3. `GITEA_TOKEN` env var.
 *   4. The credential git itself would use for the host, via
 *      `git credential fill` (config chain + credential helpers — the OS
 *      keychain unlock the store plaintext file never had).
 *
 * When `username` is provided it is fed into the fill description AND the
 * returned username is strictly filtered — no fallback to other identities.
 * When `username` is `undefined`, git picks the credential (the first
 * matching entry in store file order).
 *
 * When the git binary cannot be used (missing, spawn failure, timeout),
 * sources 2 and 4 are skipped — the env sources (`GITEA_REPO_URL`,
 * `GITEA_TOKEN`; anonymous when absent) are the only remaining sources —
 * and `gitAvailable: false` is returned so `gitea_status` can surface the
 * guidance. In-process parsing of credential files is deliberately NOT kept
 * as a fallback: its mere presence would reintroduce the file-read source of
 * CodeQL alert #8.
 *
 * Returns candidates in an empty array when no source yields a candidate
 * (anonymous mode or an unparseable baseUrl).
 */
export async function discoverCredentialsForHost(
  options: DiscoverCredentialsForHostOptions,
): Promise<DiscoverCredentialsForHostResult> {
  return discoverCredentialsForHostCore(options, GITEA_SOURCES);
}

/**
 * GitLab counterpart of `discoverCredentialsForHost`: same three-source
 * pipeline, but the config token comes from `[gitlab "<baseUrl>"] token`
 * (`git config get --url=<baseUrl> gitlab.token`), the env token from
 * `GITLAB_TOKEN`, and every candidate carries only the GitLab-documented
 * `bearer` scheme — a Gitea env/config token is never collected here.
 */
export async function discoverGitLabCredentialsForHost(
  options: DiscoverCredentialsForHostOptions,
): Promise<DiscoverCredentialsForHostResult> {
  return discoverCredentialsForHostCore(options, GITLAB_SOURCES);
}

async function discoverCredentialsForHostCore(
  options: DiscoverCredentialsForHostOptions,
  sources: PlatformCredentialSources,
): Promise<DiscoverCredentialsForHostResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  let parsed: URL | undefined;
  try {
    parsed = new URL(options.baseUrl);
  } catch {
    parsed = undefined;
  }

  const candidates: CandidateCredential[] = [];
  let gitAvailable = true;

  // Source 1: a self-contained credentialed repo URL (GITEA_REPO_URL /
  // GITLAB_REPO_URL) — the only source carrying its own identity, so it
  // outranks the stored credentials below. Collected ONLY when the URL's
  // host matches the host being discovered for: the secret belongs to that
  // instance and must never be attempted against another one (e.g. after
  // GITEA_BASE_URL or a configure-time base_url switched instances).
  if (parsed) {
    const repoUrl = parseRepoUrl(env[sources.envRepoUrlVar] ?? "");
    if (repoUrl && new URL(repoUrl.baseUrl).host === parsed.host) {
      const candidate = candidateFromRepoUrl(repoUrl, sources);
      if (candidate) candidates.push(candidate);
    }
  }

  if (parsed) {
    // Source 2: [<section> "<baseUrl>"] token / bare [<section>] token via git config.
    const configToken = await gitConfigTokenForUrl(options.baseUrl, sources.configSection, cwd, env);
    if (configToken.unavailable) {
      gitAvailable = false;
    } else if (configToken.token) {
      candidates.push({
        source: sources.configSource,
        secret: configToken.token,
        schemes: sources.tokenSchemes,
        status: "pending",
        nextSchemeIndex: 0,
      });
    }
  }

  // Source 3: <ENV>_TOKEN env (always collected, regardless of host).
  const envToken = env[sources.envTokenVar];
  if (envToken) {
    candidates.push({
      source: "env",
      secret: envToken,
      schemes: sources.tokenSchemes,
      status: "pending",
      nextSchemeIndex: 0,
    });
  }

  // Source 4: the credential git itself would use (git credential fill).
  if (parsed) {
    const fill = await gitCredentialFill(
      {
        protocol: parsed.protocol.replace(/:$/, ""),
        host: parsed.host,
        path: options.repoPath,
        username: options.username,
      },
      cwd,
      env,
    );
    if (fill.unavailable) {
      gitAvailable = false;
    } else {
      // Strict username filter — no fallback to other identities.
      const identityMatches =
        options.username === undefined || fill.username === options.username;
      const candidate = candidateFromFill(fill.username, fill.password, sources);
      if (identityMatches && candidate) candidates.push(candidate);
    }
  }

  return { candidates, gitAvailable };
}

/**
 * Discover the Gitea connection config from env + the local git context.
 *
 * baseUrl: `GITEA_BASE_URL` (env) wins; otherwise the `GITEA_REPO_URL` repo
 *   URL's host; otherwise derived from the selected remote (`upstream` →
 *   `origin` → first). Returns null only when none is available — callers
 *   should treat that as "start the server unconfigured".
 *
 * candidates: collected via `discoverCredentialsForHost`, which re-runs the
 *   four-source discovery (repo URL → git config token → env token → git
 *   credential helpers) for the resolved baseUrl. When no remote and no env
 *   source provide a baseUrl, this function returns null so the CLI can
 *   start the server in its unconfigured state.
 *
 * owner/repo: `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO` (env) win; otherwise
 * the repo URL's path; otherwise taken from the selected remote.
 */
export async function discoverConfig(options: DiscoverOptions = {}): Promise<CredentialDiscoveryResult | null> {
  return discoverConfigCore(options, GITEA_ENV, GITEA_SOURCES);
}

/** Env-var names a platform's `discoverConfig` reads. */
interface PlatformDiscoveryEnv {
  baseUrlVar: "GITEA_BASE_URL" | "GITLAB_BASE_URL";
  /** Self-contained credentialed repo URL, parsed by `parseRepoUrl`. */
  repoUrlVar: "GITEA_REPO_URL" | "GITLAB_REPO_URL";
  defaultOwnerVar: "GITEA_DEFAULT_OWNER" | "GITLAB_DEFAULT_OWNER";
  defaultRepoVar: "GITEA_DEFAULT_REPO" | "GITLAB_DEFAULT_REPO";
}

const GITEA_ENV: PlatformDiscoveryEnv = {
  baseUrlVar: "GITEA_BASE_URL",
  repoUrlVar: "GITEA_REPO_URL",
  defaultOwnerVar: "GITEA_DEFAULT_OWNER",
  defaultRepoVar: "GITEA_DEFAULT_REPO",
};

const GITLAB_ENV: PlatformDiscoveryEnv = {
  baseUrlVar: "GITLAB_BASE_URL",
  repoUrlVar: "GITLAB_REPO_URL",
  defaultOwnerVar: "GITLAB_DEFAULT_OWNER",
  defaultRepoVar: "GITLAB_DEFAULT_REPO",
};

/**
 * GitLab counterpart of `discoverConfig`: `GITLAB_BASE_URL` /
 * `GITLAB_REPO_URL` / `GITLAB_DEFAULT_OWNER` / `GITLAB_DEFAULT_REPO` (env)
 * tier above the selected remote, and credentials come from the GitLab-only
 * sources (see `discoverGitLabCredentialsForHost`). Remote selection is
 * shared (`upstream` → `origin` → first).
 */
export async function discoverGitLabConfig(options: DiscoverOptions = {}): Promise<CredentialDiscoveryResult | null> {
  return discoverConfigCore(options, GITLAB_ENV, GITLAB_SOURCES);
}

async function discoverConfigCore(
  options: DiscoverOptions,
  platformEnv: PlatformDiscoveryEnv,
  sources: PlatformCredentialSources,
): Promise<CredentialDiscoveryResult | null> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const envBaseUrl = env[platformEnv.baseUrlVar];
  // Scalar precedence is defined in exactly one place — these expressions.
  // A repo URL is a self-contained connection, so its parts tier between the
  // explicit scalar env overrides and the git remote's derived values. A
  // malformed value parses to null here: the source is ignored, never fatal.
  const repoUrl = parseRepoUrl(env[platformEnv.repoUrlVar] ?? "");

  const gitConfigPath = await resolveGitConfigPath(cwd);
  const gitConfigContent = await readOptionalFile(gitConfigPath);
  const parsedRemotes = parseRemotes(gitConfigContent);
  const selected = selectRemote(parsedRemotes);

  const baseUrl = envBaseUrl ?? repoUrl?.baseUrl ?? selected?.baseUrl;
  if (!baseUrl) return null;

  // The credential-fill path hint follows whichever source decided the
  // connection — a repo URL's path is only meaningful on the repo URL's host.
  const repoPath =
    repoUrl && !envBaseUrl
      ? `${repoUrl.owner}/${repoUrl.repo}`
      : selected
        ? `${selected.owner}/${selected.repo}`
        : undefined;
  const { candidates, gitAvailable } = await discoverCredentialsForHostCore(
    { baseUrl, cwd, env, repoPath },
    sources,
  );

  return {
    baseUrl,
    defaultOwner: env[platformEnv.defaultOwnerVar] ?? repoUrl?.owner ?? selected?.owner,
    defaultRepo: env[platformEnv.defaultRepoVar] ?? repoUrl?.repo ?? selected?.repo,
    remote: selected?.remote,
    candidates,
    gitAvailable,
  };
}
