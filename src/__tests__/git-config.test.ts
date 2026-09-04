import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import {
  parseGitRemoteUrl,
  parseRepoUrl,
  readGitRemotes,
  parseRemotes,
  selectRemote,
  stripUrlUserInfo,
  discoverConfig,
  discoverCredentialsForHost,
  discoverGitLabConfig,
  discoverGitLabCredentialsForHost,
  resolveGitConfigPath,
} from "../git-config.js";

// ── Test doubles ──
// readFile serves non-secret content (.git/config for remotes discovery);
// execFile stands in for the git subprocesses (config get / credential fill),
// the way gitea-client tests stub global.fetch.

type ExecCall = { args: string[]; stdin?: string };

let execCalls: ExecCall[] = [];

function fakeChildFor(): ChildProcess {
  // A minimal stand-in ChildProcess: only stdin is exercised (written then ended).
  const listeners: Record<string, () => void> = {};
  return {
    stdin: {
      on: (_event: string, cb: () => void) => { listeners.error = cb; },
      end: (_data?: string) => { /* recorded by the end override below; no real pipe */ },
    },
  } as unknown as ChildProcess;
}

function mockExec(behavior: (call: ExecCall) => { code: number | "spawn-error" | "timeout"; stdout?: string }): void {
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    args: string[],
    _opts: unknown,
    callback: (err: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string) => void,
  ) => {
    const call: ExecCall = { args: args as string[] };
    execCalls.push(call);
    const stdinWriter = (data?: string) => { if (data !== undefined) call.stdin = data; };
    const result = behavior(call);
    const child = fakeChildFor();
    // Let the caller write stdin first, then deliver the outcome.
    queueMicrotask(() => {
      if (result.code === "spawn-error") {
        const err = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
        callback(err, "");
      } else if (result.code === "timeout") {
        const err = Object.assign(new Error("spawn git ETIMEDOUT"), { code: "ETIMEDOUT", killed: true });
        callback(err, "");
      } else if (result.code !== 0) {
        const err = Object.assign(new Error(`git exited ${result.code}`), { code: result.code });
        callback(err, "");
      } else {
        callback(null, result.stdout ?? "");
      }
    });
    // Expose an end() that records the stdin payload, mirroring the real API
    // shape used by execGit (`child.stdin.end(opts.stdin)`).
    (child as { stdin: { on: (e: string, cb: () => void) => void; end: (data?: string) => void } }).stdin.end =
      stdinWriter;
    return child;
  }) as never);
}

function mockFiles(files: Record<string, string>, dirs: string[] = []): void {
  vi.mocked(readFile).mockImplementation(async (path) => {
    const p = typeof path === "string" ? path : String(path);
    if (p in files) return files[p];
    if (dirs.includes(p)) {
      const err = new Error(`EISDIR: illegal operation on a directory, read '${p}'`) as NodeJS.ErrnoException;
      err.code = "EISDIR";
      throw err;
    }
    const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
}

/** Drive one `git config get --url=... gitea.token` and one `git credential fill` deterministically. */
function mockGit(opts: {
  configToken?: string | null; // null → exit 1 (key absent)
  configUnavailable?: boolean;
  fill?: { username?: string; password?: string } | null; // null → exit 128 (no credential)
  fillUnavailable?: boolean;
}): void {
  mockExec((call) => {
    if (call.args[0] === "config") {
      if (opts.configUnavailable) return { code: "spawn-error" };
      if (opts.configToken === null || opts.configToken === undefined) return { code: 1 };
      return { code: 0, stdout: `${opts.configToken}\n` };
    }
    if (call.args[0] === "credential" && call.args[1] === "fill") {
      if (opts.fillUnavailable) return { code: "spawn-error" };
      if (opts.fill === null || opts.fill === undefined) return { code: 128 };
      const lines = [
        ...(opts.fill.username !== undefined ? [`username=${opts.fill.username}`] : []),
        ...(opts.fill.password !== undefined ? [`password=${opts.fill.password}`] : []),
      ];
      return { code: 0, stdout: `${lines.join("\n")}\n` };
    }
    return { code: 1 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  execCalls = [];
  mockExec(() => ({ code: 1 }));
});

describe("parseGitRemoteUrl", () => {
  it("parses scp-like SSH with .git suffix", () => {
    expect(parseGitRemoteUrl("git@gitea.example:owner/repo.git", "origin")).toEqual({
      remote: "origin",
      url: "git@gitea.example:owner/repo.git",
      host: "gitea.example",
      baseUrl: "https://gitea.example",
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses scp-like SSH without .git suffix", () => {
    const r = parseGitRemoteUrl("git@gitea.example:owner/repo");
    expect(r).toMatchObject({ host: "gitea.example", owner: "owner", repo: "repo", baseUrl: "https://gitea.example" });
  });

  it("parses ssh:// protocol", () => {
    expect(parseGitRemoteUrl("ssh://git@gitea.example/owner/repo.git", "upstream")).toMatchObject({
      remote: "upstream", host: "gitea.example", baseUrl: "https://gitea.example", owner: "owner", repo: "repo",
    });
  });

  it("parses ssh:// with a port (port dropped from baseUrl)", () => {
    const r = parseGitRemoteUrl("ssh://git@gitea.example:2222/owner/repo.git");
    expect(r).toMatchObject({ host: "gitea.example", baseUrl: "https://gitea.example" });
  });

  it("parses ssh:// without a user", () => {
    const r = parseGitRemoteUrl("ssh://gitea.example/owner/repo.git");
    expect(r).toMatchObject({ host: "gitea.example", owner: "owner", repo: "repo" });
  });

  it("parses HTTPS with .git suffix", () => {
    const r = parseGitRemoteUrl("https://gitea.example/owner/repo.git");
    expect(r).toMatchObject({ host: "gitea.example", baseUrl: "https://gitea.example", owner: "owner", repo: "repo" });
  });

  it("parses HTTPS without .git suffix", () => {
    const r = parseGitRemoteUrl("https://gitea.example/owner/repo");
    expect(r).toMatchObject({ owner: "owner", repo: "repo", baseUrl: "https://gitea.example" });
  });

  it("parses HTTPS with a non-standard port (port kept in baseUrl and host)", () => {
    const r = parseGitRemoteUrl("https://gitea.example:3000/owner/repo.git");
    expect(r).toMatchObject({ host: "gitea.example:3000", baseUrl: "https://gitea.example:3000" });
  });

  it("parses HTTPS with userinfo (userinfo ignored)", () => {
    const r = parseGitRemoteUrl("https://user:pass@gitea.example/owner/repo.git");
    expect(r).toMatchObject({ host: "gitea.example", owner: "owner", repo: "repo" });
  });

  it("parses HTTP", () => {
    const r = parseGitRemoteUrl("http://gitea.example/owner/repo.git");
    expect(r).toMatchObject({ baseUrl: "http://gitea.example", host: "gitea.example" });
  });

  it("defaults the remote name to origin", () => {
    expect(parseGitRemoteUrl("git@gitea.example:owner/repo.git")!.remote).toBe("origin");
  });

  it("strips unsafe characters from owner and repo segments", () => {
    const r = parseGitRemoteUrl("https://gitea.example/o!wn/re^po.git");
    expect(r).toMatchObject({ owner: "own", repo: "repo" });
  });

  it("returns null when owner segment has no safe characters", () => {
    expect(parseGitRemoteUrl("https://gitea.example/!!!/repo.git")).toBeNull();
  });

  it("returns null for an unparseable url", () => {
    expect(parseGitRemoteUrl("not-a-valid-url")).toBeNull();
  });

  it("returns null when only host is given (no owner/repo)", () => {
    expect(parseGitRemoteUrl("https://gitea.example")).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    const r = parseGitRemoteUrl("  git@gitea.example:owner/repo.git  ");
    expect(r).toMatchObject({ owner: "owner", repo: "repo" });
  });
});

describe("readGitRemotes", () => {
  it("extracts multiple remotes with their urls", () => {
    const content = [
      '[remote "origin"]',
      "\turl = https://gitea.example/origin/repo.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[remote "upstream"]',
      "\turl = git@gitea.example:upstream/repo.git",
    ].join("\n");
    expect(readGitRemotes(content)).toEqual([
      { name: "origin", url: "https://gitea.example/origin/repo.git" },
      { name: "upstream", url: "git@gitea.example:upstream/repo.git" },
    ]);
  });

  it("takes the first url of a remote and ignores fetch/other keys", () => {
    const content = '[remote "origin"]\n\turl = https://h/o/r.git\n\turl = https://h/o2/r.git\n';
    expect(readGitRemotes(content)).toEqual([{ name: "origin", url: "https://h/o/r.git" }]);
  });

  it("skips non-url keys that appear before the url of a remote", () => {
    const content = [
      '[remote "origin"]',
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      "\turl = https://h/o/r.git",
    ].join("\n");
    expect(readGitRemotes(content)).toEqual([{ name: "origin", url: "https://h/o/r.git" }]);
  });

  it("stops collecting keys when a new non-remote section begins", () => {
    const content = [
      '[remote "origin"]',
      "\turl = https://h/o/r.git",
      '[branch "main"]',
      "\turl = should-not-be-collected",
    ].join("\n");
    expect(readGitRemotes(content)).toEqual([{ name: "origin", url: "https://h/o/r.git" }]);
  });

  it("returns an empty array when there are no remotes", () => {
    expect(readGitRemotes("")).toEqual([]);
    expect(readGitRemotes('[core]\n\trepositoryformatversion = 0\n')).toEqual([]);
  });
});

describe("parseRemotes", () => {
  it("parses valid remotes and drops unparseable ones", () => {
    const content = [
      '[remote "origin"]',
      "\turl = https://gitea.example/owner/repo.git",
      '[remote "broken"]',
      "\turl = not-a-url",
    ].join("\n");
    const r = parseRemotes(content);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ remote: "origin", owner: "owner" });
  });
});

describe("selectRemote", () => {
  const mk = (remote: string, owner = "o") => ({
    remote, owner, url: `https://h/${owner}/r`, host: "h", baseUrl: "https://h", repo: "r",
  });

  it("prefers upstream over origin", () => {
    expect(selectRemote([mk("origin"), mk("upstream")])!.remote).toBe("upstream");
  });

  it("falls back to origin when no upstream", () => {
    expect(selectRemote([mk("origin"), mk("fork")])!.remote).toBe("origin");
  });

  it("falls back to the first remote when neither upstream nor origin", () => {
    expect(selectRemote([mk("fork1"), mk("fork2")])!.remote).toBe("fork1");
  });

  it("returns null for an empty list", () => {
    expect(selectRemote([])).toBeNull();
  });
});

describe("resolveGitConfigPath", () => {
  it("returns the conventional .git/config when .git is a directory", async () => {
    mockFiles({}, ["/repo/.git"]);
    expect(await resolveGitConfigPath("/repo")).toBe("/repo/.git/config");
  });

  it("returns the conventional path when .git does not exist", async () => {
    mockFiles({});
    expect(await resolveGitConfigPath("/repo")).toBe("/repo/.git/config");
  });

  it("follows gitdir -> commondir (relative) to the shared config", async () => {
    mockFiles({
      "/wt/.git": "gitdir: /data/repo/.git/worktrees/wt\n",
      "/data/repo/.git/worktrees/wt/commondir": "../..\n",
    });
    await expect(resolveGitConfigPath("/wt")).resolves.toBe("/data/repo/.git/config");
  });

  it("follows an absolute commondir to the shared config", async () => {
    mockFiles({
      "/wt/.git": "gitdir: /private/wt\n",
      "/private/wt/commondir": "/data/repo/.git\n",
    });
    await expect(resolveGitConfigPath("/wt")).resolves.toBe("/data/repo/.git/config");
  });

  it("reads config directly from the gitdir when no commondir exists (submodule)", async () => {
    mockFiles({
      "/sub/.git": "gitdir: /data/repo/.git/modules/sub\n",
    });
    await expect(resolveGitConfigPath("/sub")).resolves.toBe("/data/repo/.git/modules/sub/config");
  });

  it("resolves a relative gitdir pointer against the cwd", async () => {
    mockFiles({
      "/work/sub/.git": "gitdir: ../.git/worktrees/sub\n",
      "/work/.git/worktrees/sub/commondir": "../..\n",
    });
    await expect(resolveGitConfigPath("/work/sub")).resolves.toBe("/work/.git/config");
  });

  it("falls back to the conventional path when the .git file has no gitdir line", async () => {
    mockFiles({ "/wt/.git": "garbage\n" });
    await expect(resolveGitConfigPath("/wt")).resolves.toBe("/wt/.git/config");
  });

  it("rethrows non-ENOENT/EISDIR filesystem errors", async () => {
    vi.mocked(readFile).mockImplementation(async () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    await expect(resolveGitConfigPath("/repo")).rejects.toThrow("EACCES");
  });
});

describe("discoverConfig", () => {
  it("returns null when there is no .git/config and no GITEA_BASE_URL", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({ cwd: "/repo", env: {} });
    expect(cfg).toBeNull();
  });

  it("reads config from the common dir when running inside a git worktree", async () => {
    mockFiles({
      "/wt/.git": "gitdir: /data/repo/.git/worktrees/wt\n",
      "/data/repo/.git/worktrees/wt/commondir": "../..\n",
      "/data/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/owner/repo.git\n',
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({ cwd: "/wt", env: {} });
    expect(cfg).toMatchObject({
      baseUrl: "https://gitea.example",
      defaultOwner: "owner",
      defaultRepo: "repo",
      remote: "origin",
    });
  });

  it("derives baseUrl/owner/repo from the upstream remote (preferred over origin)", async () => {
    mockFiles({
      "/repo/.git/config": [
        '[remote "origin"]', "\turl = https://gitea.example/origin/repo.git",
        '[remote "upstream"]', "\turl = https://gitea.example/upstream/repo.git",
      ].join("\n"),
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({ cwd: "/repo", env: {} });
    expect(cfg).toMatchObject({ defaultOwner: "upstream", remote: "upstream" });
  });

  it("falls back to the origin remote when upstream is absent", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/origin/repo.git\n',
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({ cwd: "/repo", env: {} });
    expect(cfg).toMatchObject({ defaultOwner: "origin", remote: "origin" });
  });

  it("derives an https baseUrl from an SSH remote", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = git@gitea.example:owner/repo.git\n',
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({ cwd: "/repo", env: {} });
    expect(cfg).toMatchObject({ baseUrl: "https://gitea.example" });
  });

  it("places the git-config token first in candidates", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/owner/repo.git\n',
    });
    mockGit({ configToken: "configtok", fill: null });
    const cfg = await discoverConfig({ cwd: "/repo", env: { GITEA_TOKEN: "envtok" } });
    expect(cfg!.candidates[0]).toMatchObject({ source: "gitea-config", secret: "configtok", schemes: ["token"] });
  });

  it("places GITEA_TOKEN before the git credential candidate", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/owner/repo.git\n',
    });
    mockGit({ configToken: null, fill: { username: "oauth2", password: "credtok" } });
    const cfg = await discoverConfig({ cwd: "/repo", env: { GITEA_TOKEN: "envtok" } });
    expect(cfg!.candidates[0]).toMatchObject({ source: "env", secret: "envtok" });
    expect(cfg!.candidates[1]).toMatchObject({ source: "credential-store", secret: "credtok" });
  });

  it("yields only the env candidate when git yields nothing", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/owner/repo.git\n',
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({ cwd: "/repo", env: { GITEA_TOKEN: "envtok" } });
    expect(cfg!.candidates).toHaveLength(1);
    expect(cfg!.candidates[0]).toMatchObject({ source: "env", secret: "envtok" });
  });

  it("yields zero candidates and gitAvailable=true when no source resolves", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/owner/repo.git\n',
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({ cwd: "/repo", env: {} });
    expect(cfg!.candidates).toEqual([]);
    expect(cfg!.gitAvailable).toBe(true);
  });

  it("reports gitAvailable=false when the git binary cannot be spawned", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/owner/repo.git\n',
    });
    mockGit({ configUnavailable: true, fillUnavailable: true });
    const cfg = await discoverConfig({ cwd: "/repo", env: {} });
    expect(cfg!.candidates).toEqual([]);
    expect(cfg!.gitAvailable).toBe(false);
  });

  it("keeps the env candidate when git is unavailable (env-only fallback)", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/owner/repo.git\n',
    });
    mockGit({ configUnavailable: true, fillUnavailable: true });
    const cfg = await discoverConfig({ cwd: "/repo", env: { GITEA_TOKEN: "envtok" } });
    expect(cfg!.candidates).toEqual([
      expect.objectContaining({ source: "env", secret: "envtok" }),
    ]);
    expect(cfg!.gitAvailable).toBe(false);
  });

  it("lets GITEA_BASE_URL override the derived baseUrl", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://internal.example/owner/repo.git\n',
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({ cwd: "/repo", env: { GITEA_BASE_URL: "https://gitea.override.example" } });
    expect(cfg).toMatchObject({ baseUrl: "https://gitea.override.example" });
    expect(cfg).toMatchObject({ defaultOwner: "owner", defaultRepo: "repo" });
  });

  it("lets GITEA_DEFAULT_OWNER/REPO override the derived values", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/owner/repo.git\n',
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: { GITEA_DEFAULT_OWNER: "myorg", GITEA_DEFAULT_REPO: "myrepo" },
    });
    expect(cfg).toMatchObject({ defaultOwner: "myorg", defaultRepo: "myrepo" });
  });

  it("rethrows non-ENOENT filesystem errors", async () => {
    vi.mocked(readFile).mockImplementation(async () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    await expect(discoverConfig({ cwd: "/repo", env: {} })).rejects.toThrow("EACCES");
  });
});

describe("discoverCredentialsForHost", () => {
  it("collects git-config token, env token, and the git credential in priority order", async () => {
    mockFiles({});
    mockGit({ configToken: "configtok", fill: { username: "oauth2", password: "credtok" } });
    const { candidates } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: { GITEA_TOKEN: "envtok" },
    });
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ source: "gitea-config", secret: "configtok" });
    expect(candidates[1]).toMatchObject({ source: "env", secret: "envtok" });
    expect(candidates[2]).toMatchObject({ source: "credential-store", secret: "credtok" });
  });

  it("reads the config token via git config get --url=<baseUrl>", async () => {
    mockFiles({});
    mockGit({ configToken: "configtok", fill: null });
    await discoverCredentialsForHost({ baseUrl: "https://gitea.example", cwd: "/repo", env: {} });
    expect(execCalls[0].args).toEqual(["config", "get", "--url=https://gitea.example", "gitea.token"]);
  });

  it("feeds protocol/host/path to git credential fill on stdin", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: { username: "alice", password: "s" } });
    await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
      repoPath: "owner/repo",
    });
    const fillCall = execCalls.find((c) => c.args[0] === "credential")!;
    expect(fillCall.args).toEqual(["credential", "fill"]);
    expect(fillCall.stdin).toContain("protocol=https\n");
    expect(fillCall.stdin).toContain("host=gitea.example\n");
    expect(fillCall.stdin).toContain("path=owner/repo\n");
    expect(fillCall.stdin!.endsWith("\n\n"));
  });

  it("feeds username to git credential fill and filters the returned identity strictly", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: { username: "alice", password: "s1" } });
    const { candidates } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
      username: "bob",
    });
    const fillCall = execCalls.find((c) => c.args[0] === "credential")!;
    expect(fillCall.stdin).toContain("username=bob\n");
    // git returned alice although bob was asked — strict filter drops it.
    expect(candidates.filter((c) => c.source === "credential-store")).toHaveLength(0);
  });

  it("keeps the candidate when the returned username matches the filter", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: { username: "bob", password: "s2" } });
    const { candidates } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
      username: "bob",
    });
    expect(candidates).toEqual([
      expect.objectContaining({ source: "credential-store", secret: "s2", username: "bob" }),
    ]);
  });

  it("maps a password-only fill result to a basic-auth candidate with no username", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: { password: "pwonly" } });
    const { candidates } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
    });
    expect(candidates).toEqual([
      expect.objectContaining({ source: "credential-store", secret: "pwonly", username: undefined }),
    ]);
  });

  it("maps a username-only fill result (token stored as the username) to a token-first candidate", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: { username: "token-as-username" } });
    const { candidates } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
    });
    expect(candidates).toEqual([
      expect.objectContaining({ source: "credential-store", secret: "token-as-username", schemes: ["token", "basic"] }),
    ]);
  });

  it("still returns env token when the baseUrl is unparseable", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const { candidates, gitAvailable } = await discoverCredentialsForHost({
      baseUrl: "not-a-url",
      cwd: "/repo",
      env: { GITEA_TOKEN: "envtok" },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "env", secret: "envtok" });
    // No git call was even attempted — availability stays unknown-but-usable.
    expect(gitAvailable).toBe(true);
  });

  it("returns an empty array when git reports no credential (non-zero exit)", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const { candidates, gitAvailable } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
    });
    expect(candidates).toEqual([]);
    expect(gitAvailable).toBe(true);
  });

  it("classifies a spawn failure as git-unavailable (env-only, no crash)", async () => {
    mockFiles({});
    mockGit({ configUnavailable: true, fillUnavailable: true });
    const { candidates, gitAvailable } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: { GITEA_TOKEN: "envtok" },
    });
    expect(candidates).toEqual([expect.objectContaining({ source: "env" })]);
    expect(gitAvailable).toBe(false);
  });

  it("classifies a timeout kill as git-unavailable, not a credential miss", async () => {
    mockFiles({});
    mockExec(() => ({ code: "timeout" }));
    const { candidates, gitAvailable } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
    });
    expect(candidates).toEqual([]);
    expect(gitAvailable).toBe(false);
  });

  it("forces non-interactive git (GIT_TERMINAL_PROMPT=0) in the subprocess env", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    await discoverCredentialsForHost({ baseUrl: "https://gitea.example", cwd: "/repo", env: {} });
    const opts = vi.mocked(execFile).mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("rejects a repoPath containing a newline (stdin attribute-line injection)", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: { username: "victim", password: "stolen" } });
    // A forged `host=` line must never reach the credential description —
    // otherwise fill would return the credential stored for that host.
    await expect(
      discoverCredentialsForHost({
        baseUrl: "https://attacker.example",
        cwd: "/repo",
        env: {},
        repoPath: "x\nhost=github.com\n",
      }),
    ).rejects.toThrow("line breaks are not allowed");
    expect(execCalls.filter((c) => c.args[0] === "credential")).toHaveLength(0);
  });

  it("rejects a username containing a newline (stdin attribute-line injection)", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: { username: "victim", password: "stolen" } });
    await expect(
      discoverCredentialsForHost({
        baseUrl: "https://attacker.example",
        cwd: "/repo",
        env: {},
        username: "x\r\nhost=github.com",
      }),
    ).rejects.toThrow("line breaks are not allowed");
    expect(execCalls.filter((c) => c.args[0] === "credential")).toHaveLength(0);
  });

  it("yields no config-token candidate when git exits 0 with empty output", async () => {
    mockFiles({});
    // e.g. an empty `gitea.token` value: git succeeds but prints nothing.
    mockGit({ configToken: "", fill: null });
    const { candidates } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
    });
    expect(candidates.filter((c) => c.source === "gitea-config")).toHaveLength(0);
  });

  it("defaults cwd/env to the process when omitted", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    await discoverCredentialsForHost({ baseUrl: "https://gitea.example" });
    const opts = vi.mocked(execFile).mock.calls[0][2] as {
      cwd: string;
      env: Record<string, string>;
    };
    expect(opts.cwd).toBe(process.cwd());
    // env falls back to process.env (plus the forced non-interactive flag).
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  it("discoverConfig also defaults cwd/env when called with no options", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig();
    // discoverConfig() with no args reads the conventional .git/config path
    // of the real cwd (mocked ENOENT → no remotes) and no env baseUrl —
    // the documented "start unconfigured" outcome, without cwd/env provided.
    expect(cfg).toBeNull();
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it("omits the path attribute when no remote was selected (env baseUrl only)", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    await discoverConfig({ cwd: "/repo", env: { GITEA_BASE_URL: "https://gitea.example" } });
    const fillCall = execCalls.find((c) => c.args[0] === "credential")!;
    expect(fillCall.stdin).not.toContain("path=");
  });

  it("tolerates an undefined stdout from execFile (defensive empty-string fallback)", async () => {
    mockFiles({});
    // execFile may hand back undefined stdout in exotic paths; execGit must
    // not crash and must treat it as empty (no candidate, git still usable).
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: unknown,
      _opts: unknown,
      callback: (err: null, stdout?: string) => void,
    ) => {
      queueMicrotask(() => callback(null, undefined));
      return fakeChildFor();
    }) as never);
    const { candidates, gitAvailable } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: {},
    });
    expect(gitAvailable).toBe(true);
    expect(candidates).toEqual([]);
  });
});

describe("discoverGitLabConfig / discoverGitLabCredentialsForHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execCalls = [];
    mockExec(() => ({ code: 1 }));
  });

  it("reads the [gitlab] config key (not gitea.token) and carries the bearer scheme", async () => {
    mockFiles({});
    mockGit({ configToken: "gl-tok", fill: null });
    const { candidates } = await discoverGitLabCredentialsForHost({
      baseUrl: "https://gitlab.example",
      cwd: "/repo",
      env: {},
    });
    expect(execCalls[0].args).toEqual([
      "config",
      "get",
      "--url=https://gitlab.example",
      "gitlab.token",
    ]);
    expect(candidates).toEqual([
      { source: "gitlab-config", secret: "gl-tok", schemes: ["bearer"], status: "pending", nextSchemeIndex: 0 },
    ]);
  });

  it("collects GITLAB_TOKEN env — never GITEA_TOKEN — with bearer schemes", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const { candidates } = await discoverGitLabCredentialsForHost({
      baseUrl: "https://gitlab.example",
      cwd: "/repo",
      env: { GITLAB_TOKEN: "env-tok", GITEA_TOKEN: "gitea-tok" },
    });
    expect(candidates).toEqual([
      { source: "env", secret: "env-tok", schemes: ["bearer"], status: "pending", nextSchemeIndex: 0 },
    ]);
  });

  it("credential-store candidates carry only the bearer scheme on GitLab", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: { username: "alice", password: "pw" } });
    const { candidates } = await discoverGitLabCredentialsForHost({
      baseUrl: "https://gitlab.example",
      cwd: "/repo",
      env: {},
    });
    expect(candidates).toEqual([
      {
        source: "credential-store",
        username: "alice",
        secret: "pw",
        schemes: ["bearer"],
        status: "pending",
        nextSchemeIndex: 0,
      },
    ]);
  });

  it("discoverGitLabConfig honors GITLAB_BASE_URL and GITLAB_DEFAULT_* overrides", async () => {
    mockFiles({
      "/repo/.git/config": [
        '[remote "origin"]',
        "  url = https://gitlab.example/alice/proj.git",
        "",
      ].join("\n"),
    });
    mockGit({ configToken: null, fill: null });
    const result = await discoverGitLabConfig({
      cwd: "/repo",
      env: {
        GITLAB_BASE_URL: "https://gitlab.corp",
        GITLAB_DEFAULT_OWNER: "corp-owner",
        GITLAB_DEFAULT_REPO: "corp-repo",
        GITLAB_TOKEN: "t",
      },
    });
    expect(result).toMatchObject({
      baseUrl: "https://gitlab.corp",
      defaultOwner: "corp-owner",
      defaultRepo: "corp-repo",
    });
    expect(execCalls[0].args).toEqual([
      "config",
      "get",
      "--url=https://gitlab.corp",
      "gitlab.token",
    ]);
  });

  it("discoverGitLabConfig falls back to the selected git remote like the Gitea flow", async () => {
    mockFiles({
      "/repo/.git/config": [
        '[remote "origin"]',
        "  url = https://gitlab.example/alice/proj.git",
        "",
      ].join("\n"),
    });
    mockGit({ configToken: null, fill: null });
    const result = await discoverGitLabConfig({ cwd: "/repo", env: {} });
    expect(result).toMatchObject({
      baseUrl: "https://gitlab.example",
      defaultOwner: "alice",
      defaultRepo: "proj",
      remote: "origin",
    });
  });

  it("returns null with no remote and no GITLAB_BASE_URL (unconfigured start)", async () => {
    mockFiles({});
    const result = await discoverGitLabConfig({ cwd: "/repo", env: {} });
    expect(result).toBeNull();
  });
});

describe("git-config error boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execCalls = [];
    mockExec(() => ({ code: 1 }));
  });

  it("parseGitRemoteUrl returns null when an ssh remote has unsanitizable segments", () => {
    expect(parseGitRemoteUrl("ssh://git@host/@@@/###", "origin")).toBeNull();
  });

  it("parseGitRemoteUrl returns null when an https remote has unsanitizable segments", () => {
    expect(parseGitRemoteUrl("https://host/@@@/###", "origin")).toBeNull();
  });

  it("parseGitRemoteUrl returns null when an scp remote has unsanitizable segments", () => {
    expect(parseGitRemoteUrl("git@host:@@@/###", "origin")).toBeNull();
  });

  it("readOptionalFile rethrows non-ENOENT read errors (EISDIR on the config path)", async () => {
    // `.git` is a directory (normal repo) and the config path itself is a
    // directory too — the EISDIR from reading the config must propagate.
    mockFiles({}, ["/repo/.git/config"]);
    await expect(discoverConfig({ cwd: "/repo", env: { GITEA_BASE_URL: "https://gitea.example" } })).rejects.toThrow(
      /EISDIR/,
    );
  });
});

describe("parseRepoUrl", () => {
  it("parses a full credentialed URL with a port (userinfo stripped from baseUrl)", () => {
    expect(parseRepoUrl("https://alice:s3cret@gitea.example:8443/owner/repo.git")).toEqual({
      baseUrl: "https://gitea.example:8443",
      owner: "owner",
      repo: "repo",
      username: "alice",
      secret: "s3cret",
    });
  });

  it("accepts a URL without the .git suffix", () => {
    expect(parseRepoUrl("https://alice:s3cret@gitea.example/owner/repo")).toMatchObject({
      baseUrl: "https://gitea.example",
      owner: "owner",
      repo: "repo",
    });
  });

  it("normalizes the default port away in the derived baseUrl", () => {
    expect(parseRepoUrl("https://a:b@gitea.example:443/owner/repo.git")!.baseUrl).toBe("https://gitea.example");
    expect(parseRepoUrl("http://a:b@gitea.example:80/owner/repo.git")!.baseUrl).toBe("http://gitea.example");
  });

  it("decodes percent-encoded userinfo to the literal values", () => {
    const r = parseRepoUrl("https://us%21er:sec%2Fret@gitea.example/owner/repo.git");
    expect(r).toMatchObject({ username: "us!er", secret: "sec/ret" });
  });

  it("maps a token-only username (`https://<token>@host`) to a secret without username", () => {
    expect(parseRepoUrl("https://tok123@gitea.example/owner/repo.git")).toEqual({
      baseUrl: "https://gitea.example",
      owner: "owner",
      repo: "repo",
      username: undefined,
      secret: "tok123",
    });
  });

  it("returns no secret for a credential-less URL (connection info only)", () => {
    const r = parseRepoUrl("https://gitea.example/owner/repo.git");
    expect(r).toMatchObject({ baseUrl: "https://gitea.example", owner: "owner", repo: "repo" });
    expect(r!.secret).toBeUndefined();
    expect(r!.username).toBeUndefined();
  });

  it("rejects scp-like, scheme-less, non-http(s), and over-long ports", () => {
    expect(parseRepoUrl("git@gitea.example:owner/repo.git")).toBeNull();
    expect(parseRepoUrl("gitea.example/owner/repo.git")).toBeNull();
    expect(parseRepoUrl("ssh://user:pass@gitea.example/owner/repo.git")).toBeNull();
    expect(parseRepoUrl("ftp://user:pass@gitea.example/owner/repo.git")).toBeNull();
    expect(parseRepoUrl("https://user:pass@gitea.example:99999/owner/repo.git")).toBeNull();
  });

  it("rejects shapes that are not exactly <owner>/<repo>[.git]", () => {
    expect(parseRepoUrl("https://user:pass@gitea.example")).toBeNull();
    expect(parseRepoUrl("https://user:pass@gitea.example/owner")).toBeNull();
    expect(parseRepoUrl("https://user:pass@gitea.example/sub/owner/repo.git")).toBeNull();
  });

  it("rejects unsanitizable owner/repo segments", () => {
    expect(parseRepoUrl("https://user:pass@gitea.example/!!!/repo.git")).toBeNull();
    expect(parseRepoUrl("https://user:pass@gitea.example/owner/###.git")).toBeNull();
  });

  it("rejects a malformed percent escape instead of guessing", () => {
    expect(parseRepoUrl("https://user:%zz@gitea.example/owner/repo.git")).toBeNull();
  });

  it("rejects control characters in the decoded userinfo (header-injection guard)", () => {
    expect(parseRepoUrl("https://user:a%0D%0AX-Evil:@gitea.example/owner/repo.git")).toBeNull();
    expect(parseRepoUrl("https://us%0Ar:secret@gitea.example/owner/repo.git")).toBeNull();
    expect(parseRepoUrl("https://a%00b:secret@gitea.example/owner/repo.git")).toBeNull();
  });

  it("never echoes the raw input in a thrown message (it returns null instead)", () => {
    const raw = "https://alice:s3cret@gitea.example/!!!/repo.git";
    expect(() => parseRepoUrl(raw)).not.toThrow();
    expect(parseRepoUrl(raw)).toBeNull();
  });
});

describe("stripUrlUserInfo", () => {
  it("strips user:pass userinfo from an https URL", () => {
    expect(stripUrlUserInfo("https://alice:s3cret@gitea.example/owner/repo.git")).toBe(
      "https://gitea.example/owner/repo.git",
    );
  });

  it("strips a username-only userinfo", () => {
    expect(stripUrlUserInfo("https://tok123@gitea.example/owner/repo.git")).toBe(
      "https://gitea.example/owner/repo.git",
    );
  });

  it("strips userinfo from an ssh:// URL and keeps a bare URL unchanged", () => {
    expect(stripUrlUserInfo("ssh://git@gitea.example/owner/repo.git")).toBe("ssh://gitea.example/owner/repo.git");
    expect(stripUrlUserInfo("https://gitea.example/owner/repo.git")).toBe("https://gitea.example/owner/repo.git");
  });

  it("passes scp-like remotes through unchanged (no scheme to parse)", () => {
    expect(stripUrlUserInfo("git@gitea.example:owner/repo.git")).toBe("git@gitea.example:owner/repo.git");
  });
});

describe("repo URL connection source (GITEA_REPO_URL / GITLAB_REPO_URL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execCalls = [];
    mockExec(() => ({ code: 1 }));
  });

  it("configures the server from GITEA_REPO_URL alone — no git remote, git unavailable", async () => {
    // No .git/config at all; git cannot run. The pure-env repo-URL source
    // must still produce a configured server (acceptance criterion 1/8).
    mockFiles({});
    mockGit({ configUnavailable: true, fillUnavailable: true });
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: { GITEA_REPO_URL: "https://alice:s3cret@gitea.example:8443/owner/repo.git" },
    });
    expect(cfg).toMatchObject({
      baseUrl: "https://gitea.example:8443",
      defaultOwner: "owner",
      defaultRepo: "repo",
      gitAvailable: false,
    });
    expect(cfg!.candidates).toEqual([
      {
        source: "repo-url",
        username: "alice",
        secret: "s3cret",
        schemes: ["basic", "token"],
        status: "pending",
        nextSchemeIndex: 0,
      },
    ]);
  });

  it("follows the username heuristic for scheme order (oauth2 → token first)", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: { GITEA_REPO_URL: "https://oauth2:s3cret@gitea.example/owner/repo.git" },
    });
    expect(cfg!.candidates[0]).toMatchObject({ source: "repo-url", schemes: ["token", "basic"] });
  });

  it("maps a token-only username to the username-only scheme list", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: { GITEA_REPO_URL: "https://tok123@gitea.example/owner/repo.git" },
    });
    expect(cfg!.candidates).toEqual([
      expect.objectContaining({ source: "repo-url", secret: "tok123", schemes: ["token", "basic"] }),
    ]);
    expect(cfg!.candidates[0].username).toBeUndefined();
  });

  it("ranks the repo-url candidate first, ahead of config token / env token / git credential", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/origin/repo.git\n',
    });
    mockGit({ configToken: "configtok", fill: { username: "alice", password: "credtok" } });
    const { candidates } = await discoverCredentialsForHost({
      baseUrl: "https://gitea.example",
      cwd: "/repo",
      env: { GITEA_TOKEN: "envtok", GITEA_REPO_URL: "https://alice:s3cret@gitea.example/owner/repo.git" },
    });
    expect(candidates.map((c) => c.source)).toEqual(["repo-url", "gitea-config", "env", "credential-store"]);
  });

  it("beats the git remote for baseUrl/owner/repo while the remote stays selected", async () => {
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://old.example/origin/repo.git\n',
    });
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: { GITEA_REPO_URL: "https://alice:s3cret@gitea.example/owner/repo.git" },
    });
    expect(cfg).toMatchObject({
      baseUrl: "https://gitea.example",
      defaultOwner: "owner",
      defaultRepo: "repo",
      remote: "origin",
    });
  });

  it("yields no repo-url candidate when GITEA_BASE_URL points at another host", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: {
        GITEA_BASE_URL: "https://other.example",
        GITEA_REPO_URL: "https://alice:s3cret@gitea.example/owner/repo.git",
      },
    });
    // The secret belongs to gitea.example and must never be attempted
    // against other.example.
    expect(cfg!.baseUrl).toBe("https://other.example");
    expect(cfg!.candidates.filter((c) => c.source === "repo-url")).toHaveLength(0);
  });

  it("drops a repo-url candidate on configure-time re-discovery for a different host", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const { candidates } = await discoverCredentialsForHost({
      baseUrl: "https://other.example",
      cwd: "/repo",
      env: { GITEA_REPO_URL: "https://alice:s3cret@gitea.example/owner/repo.git" },
    });
    expect(candidates).toEqual([]);
  });

  it("yields no repo-url candidate when the URL carries no credential (connection info only)", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    // A credential-less URL still decides the connection (baseUrl/owner/repo
    // tier above the git remote), but there is no secret in it to try — the
    // source contributes no candidate while config/env/fill stay empty too.
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: { GITEA_REPO_URL: "https://gitea.example/owner/repo.git" },
    });
    expect(cfg).toMatchObject({
      baseUrl: "https://gitea.example",
      defaultOwner: "owner",
      defaultRepo: "repo",
      gitAvailable: true,
    });
    expect(cfg!.candidates).toEqual([]);
  });

  it("lets GITEA_DEFAULT_OWNER/REPO override the repo URL's path", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: {
        GITEA_REPO_URL: "https://alice:s3cret@gitea.example/owner/repo.git",
        GITEA_DEFAULT_OWNER: "myorg",
        GITEA_DEFAULT_REPO: "myrepo",
      },
    });
    expect(cfg).toMatchObject({ defaultOwner: "myorg", defaultRepo: "myrepo" });
  });

  it("feeds the repo URL's path to git credential fill when the URL decides the connection", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    await discoverConfig({
      cwd: "/repo",
      env: { GITEA_REPO_URL: "https://alice:s3cret@gitea.example/owner/repo.git" },
    });
    const fillCall = execCalls.find((c) => c.args[0] === "credential")!;
    expect(fillCall.stdin).toContain("host=gitea.example\n");
    expect(fillCall.stdin).toContain("path=owner/repo\n");
  });

  it("ignores a malformed GITEA_REPO_URL without crashing (unconfigured start, raw value never echoed)", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    await expect(
      discoverConfig({ cwd: "/repo", env: { GITEA_REPO_URL: "git@gitea.example:owner/repo.git" } }),
    ).resolves.toBeNull();
    // A malformed value alongside a usable git remote is ignored, not fatal.
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/origin/repo.git\n',
    });
    const cfg = await discoverConfig({
      cwd: "/repo",
      env: { GITEA_REPO_URL: "not-a-url-at-all" },
    });
    expect(cfg).toMatchObject({ baseUrl: "https://gitea.example", defaultOwner: "origin" });
  });

  it("never collects GITLAB_REPO_URL on the Gitea platform (nor the reverse)", async () => {
    mockFiles({});
    mockGit({ configToken: null, fill: null });
    // Gitea discovery with a GitLab repo URL: unconfigured — the variable is
    // invisible to the Gitea pipeline.
    await expect(
      discoverConfig({ cwd: "/repo", env: { GITLAB_REPO_URL: "https://alice:s3cret@gitlab.example/owner/repo.git" } }),
    ).resolves.toBeNull();
    // ...and even with a git remote present, no repo-url candidate leaks in.
    mockFiles({
      "/repo/.git/config": '[remote "origin"]\n\turl = https://gitea.example/origin/repo.git\n',
    });
    const gitea = await discoverConfig({
      cwd: "/repo",
      env: { GITLAB_REPO_URL: "https://alice:s3cret@gitlab.example/owner/repo.git" },
    });
    expect(gitea!.candidates.filter((c) => c.source === "repo-url")).toHaveLength(0);

    // Symmetric: GitLab discovery never collects GITEA_REPO_URL.
    mockFiles({});
    await expect(
      discoverGitLabConfig({ cwd: "/repo", env: { GITEA_REPO_URL: "https://alice:s3cret@gitea.example/owner/repo.git" } }),
    ).resolves.toBeNull();
  });

  it("works symmetrically in GitLab mode with the bearer scheme", async () => {
    mockFiles({});
    mockGit({ configUnavailable: true, fillUnavailable: true });
    const cfg = await discoverGitLabConfig({
      cwd: "/repo",
      env: { GITLAB_REPO_URL: "https://alice:s3cret@gitlab.example/owner/repo.git" },
    });
    expect(cfg).toMatchObject({
      baseUrl: "https://gitlab.example",
      defaultOwner: "owner",
      defaultRepo: "repo",
      gitAvailable: false,
    });
    expect(cfg!.candidates).toEqual([
      {
        source: "repo-url",
        username: "alice",
        secret: "s3cret",
        schemes: ["bearer"],
        status: "pending",
        nextSchemeIndex: 0,
      },
    ]);
  });
});
