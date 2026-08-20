import { readFile } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
import {
  type CandidateCredential,
  type CredentialDiscoveryResult,
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
 * Read the `[gitea "<url>"] token` / bare `[gitea] token` value through git's
 * own config machinery: `git config get --url=<baseUrl> gitea.token`. The
 * `--url` lookup returns the best URL-matching subsection and falls back to
 * the bare `[gitea]` section natively (git-config(1)), replicating the old
 * in-process scoped→bare matching in one call — while reading the secret via
 * git's stdout instead of a `node:fs` file read (which was the CodeQL
 * `js/file-access-to-http` source). Requires git ≥ 2.46 (`config get`).
 */
async function gitConfigTokenForUrl(
  baseUrl: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ unavailable: boolean; token?: string }> {
  const result = await execGit(["config", "get", `--url=${baseUrl}`, "gitea.token"], { cwd, env });
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
 * Ask git for the credential it would use for a host via
 * `git credential fill`: feed the credential description (key=value lines
 * terminated by a blank line) on stdin, read `username=` / `password=` from
 * stdout (git-credential(1)). This consults git's full credential machinery
 * (config chain + every configured helper — including OS keychain helpers
 * like wincred / osxkeychain / libsecret), making git the single canonical
 * parser of credential storage; the secret enters this process via
 * subprocess stdout, not a `node:fs` file read.
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
 * Build a `CandidateCredential` from a `git credential fill` result,
 * preserving the store conventions of the old in-process parser:
 * - password present → secret = password, username preserved (basic auth
 *   needs it); scheme order from `orderSchemesForCredentialStore`.
 * - username only (a helper returned just the identity — or a token stored
 *   in the username position) → secret = username, `token` scheme first.
 */
function candidateFromFill(username: string | undefined, password: string | undefined): CandidateCredential | null {
  if (password) {
    return {
      source: "credential-store",
      username,
      secret: password,
      schemes: orderSchemesForCredentialStore(username),
      status: "pending",
      nextSchemeIndex: 0,
    };
  }
  if (username) {
    return {
      source: "credential-store",
      secret: username,
      schemes: ["token", "basic"],
      status: "pending",
      nextSchemeIndex: 0,
    };
  }
  return null;
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
 * Re-run the three-source credential discovery for an explicit baseUrl.
 *
 * Sources (in priority order):
 *   1. `[gitea "<baseUrl>"] token` / bare `[gitea] token` via
 *      `git config get --url=<baseUrl> gitea.token`.
 *   2. `GITEA_TOKEN` env var.
 *   3. The credential git itself would use for the host, via
 *      `git credential fill` (config chain + credential helpers — the OS
 *      keychain unlock the store plaintext file never had).
 *
 * When `username` is provided it is fed into the fill description AND the
 * returned username is strictly filtered — no fallback to other identities.
 * When `username` is `undefined`, git picks the credential (the first
 * matching entry in store file order).
 *
 * When the git binary cannot be used (missing, spawn failure, timeout),
 * sources 1 and 3 are skipped — `GITEA_TOKEN` (anonymous when absent) is the
 * only remaining source — and `gitAvailable: false` is returned so
 * `gitea_status` can surface the guidance. In-process parsing of credential
 * files is deliberately NOT kept as a fallback: its mere presence would
 * reintroduce the file-read source of CodeQL alert #8.
 *
 * Returns candidates in an empty array when no source yields a candidate
 * (anonymous mode or an unparseable baseUrl).
 */
export async function discoverCredentialsForHost(
  options: DiscoverCredentialsForHostOptions,
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

  if (parsed) {
    // Source 1: [gitea "<baseUrl>"] token / bare [gitea] token via git config.
    const configToken = await gitConfigTokenForUrl(options.baseUrl, cwd, env);
    if (configToken.unavailable) {
      gitAvailable = false;
    } else if (configToken.token) {
      candidates.push({
        source: "gitea-config",
        secret: configToken.token,
        schemes: ["token"],
        status: "pending",
        nextSchemeIndex: 0,
      });
    }
  }

  // Source 2: GITEA_TOKEN env (always collected, regardless of host).
  const envToken = env.GITEA_TOKEN;
  if (envToken) {
    candidates.push({
      source: "env",
      secret: envToken,
      schemes: ["token"],
      status: "pending",
      nextSchemeIndex: 0,
    });
  }

  // Source 3: the credential git itself would use (git credential fill).
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
      const candidate = candidateFromFill(fill.username, fill.password);
      if (identityMatches && candidate) candidates.push(candidate);
    }
  }

  return { candidates, gitAvailable };
}

/**
 * Discover the Gitea connection config from env + the local git context.
 *
 * baseUrl: `GITEA_BASE_URL` (env) wins; otherwise derived from the selected
 *   remote (`upstream` → `origin` → first). Returns null only when neither is
 *   available — callers should treat that as "start the server unconfigured".
 *
 * candidates: collected via `discoverCredentialsForHost`, which re-runs the
 *   three-source discovery (git config token → env token → git credential
 *   helpers) for the resolved baseUrl. When no remote and no env baseUrl
 *   exist, this function returns null so the CLI can start the server in its
 *   unconfigured state.
 *
 * owner/repo: `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO` (env) win; otherwise
 * taken from the selected remote.
 */
export async function discoverConfig(options: DiscoverOptions = {}): Promise<CredentialDiscoveryResult | null> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const envBaseUrl = env.GITEA_BASE_URL;

  const gitConfigPath = await resolveGitConfigPath(cwd);
  const gitConfigContent = await readOptionalFile(gitConfigPath);
  const parsedRemotes = parseRemotes(gitConfigContent);
  const selected = selectRemote(parsedRemotes);

  const baseUrl = envBaseUrl ?? selected?.baseUrl;
  if (!baseUrl) return null;

  const repoPath = selected ? `${selected.owner}/${selected.repo}` : undefined;
  const { candidates, gitAvailable } = await discoverCredentialsForHost({
    baseUrl,
    cwd,
    env,
    repoPath,
  });

  return {
    baseUrl,
    defaultOwner: env.GITEA_DEFAULT_OWNER ?? selected?.owner,
    defaultRepo: env.GITEA_DEFAULT_REPO ?? selected?.repo,
    remote: selected?.remote,
    candidates,
    gitAvailable,
  };
}
