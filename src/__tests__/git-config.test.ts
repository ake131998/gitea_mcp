import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import {
  parseGitRemoteUrl,
  readGitRemotes,
  parseRemotes,
  selectRemote,
  discoverConfig,
  discoverCredentialsForHost,
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
    const r = parseGitRemoteUrl("git@gitea.example:owner/repo.git");
    expect(r).toMatchObject({ host: "gitea.example", baseUrl: "https://gitea.example", owner: "owner", repo: "repo" });
  });

  it("parses ssh:// protocol", () => {
    const r = parseGitRemoteUrl("ssh://git@gitea.example/owner/repo");
    expect(r).toMatchObject({ host: "gitea.example", owner: "owner", repo: "repo" });
  });

  it("parses HTTPS with a non-standard port (port kept in baseUrl and host)", () => {
    const r = parseGitRemoteUrl("https://gitea.example:3000/owner/repo.git");
    expect(r).toMatchObject({ host: "gitea.example:3000", baseUrl: "https://gitea.example:3000" });
  });

  it("parses HTTPS with userinfo (userinfo ignored)", () => {
    const r = parseGitRemoteUrl("https://user:pass@gitea.example/owner/repo");
    expect(r).toMatchObject({ owner: "owner", repo: "repo" });
  });

  it("strips unsafe characters from owner and repo segments", () => {
    const r = parseGitRemoteUrl("https://gitea.example/o..w-n_r/e.git");
    expect(r).toMatchObject({ owner: "o..w-n_r", repo: "e" });
  });

  it("returns null when owner segment has no safe characters", () => {
    expect(parseGitRemoteUrl("https://gitea.example/!!/repo")).toBeNull();
  });

  it("returns null for an unparseable url", () => {
    expect(parseGitRemoteUrl("not a url")).toBeNull();
  });
});

describe("readGitRemotes", () => {
  it("extracts multiple remotes with their urls", () => {
    const remotes = readGitRemotes('[remote "origin"]\n\turl = https://g/o/r.git\n[remote "upstream"]\n\turl = https://g/u/r.git\n');
    expect(remotes).toEqual([
      { name: "origin", url: "https://g/o/r.git" },
      { name: "upstream", url: "https://g/u/r.git" },
    ]);
  });

  it("stops collecting keys when a new non-remote section begins", () => {
    const remotes = readGitRemotes('[remote "origin"]\nurl = https://g/o/r.git\n[gitea]\ntoken = x\n');
    expect(remotes).toEqual([{ name: "origin", url: "https://g/o/r.git" }]);
  });

  it("returns an empty array when there are no remotes", () => {
    expect(readGitRemotes("")).toEqual([]);
  });
});

describe("parseRemotes", () => {
  it("parses valid remotes and drops unparseable ones", () => {
    const remotes = parseRemotes('[remote "origin"]\nurl = https://g/o/r.git\n[remote "bad"]\nurl = ???\n');
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({ remote: "origin" });
  });
});

describe("selectRemote", () => {
  const mk = (name: string) => ({ remote: name, url: "", host: "h", baseUrl: "https://h", owner: "o", repo: "r" });

  it("prefers upstream over origin", () => {
    expect(selectRemote([mk("origin"), mk("upstream")])!.remote).toBe("upstream");
  });

  it("falls back to the first remote when neither upstream nor origin", () => {
    expect(selectRemote([mk("a"), mk("b")])!.remote).toBe("a");
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
    expect(await resolveGitConfigPath("/wt")).toBe("/data/repo/.git/config");
  });

  it("reads config directly from the gitdir when no commondir exists (submodule)", async () => {
    mockFiles({
      "/wt/.git": "gitdir: /data/sub/.git\n",
    });
    expect(await resolveGitConfigPath("/wt")).toBe("/data/sub/.git/config");
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
});
