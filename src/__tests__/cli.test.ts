import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runServer } from "../server.js";
import { discoverConfig, discoverGitLabConfig } from "../git-config.js";

vi.mock("../server.js", () => ({
  runServer: vi.fn(),
}));

vi.mock("../git-config.js", () => ({
  discoverConfig: vi.fn(),
  discoverGitLabConfig: vi.fn(),
}));

vi.mock("../skills.js", () => ({
  runInitCommand: vi.fn(),
}));

describe("cli entry point", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let savedArgv: string[];

  beforeEach(() => {
    vi.resetModules();
    savedArgv = process.argv.slice();
    process.argv = ["node", "cli.js"];
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(runServer).mockReset();
    vi.mocked(discoverConfig).mockReset();
  });

  afterEach(() => {
    process.argv = savedArgv;
    vi.restoreAllMocks();
  });

  it("starts the server UNCONFIGURED when no config can be discovered", async () => {
    vi.mocked(discoverConfig).mockResolvedValue(null);
    vi.mocked(runServer).mockResolvedValue(undefined);
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("UNCONFIGURED"));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("starts the server with the discovered baseUrl/candidates/owner/repo", async () => {
    vi.mocked(discoverConfig).mockResolvedValue({
      baseUrl: "https://gitea.example",
      candidates: [{ source: "env", secret: "tok", schemes: ["token"], status: "pending", nextSchemeIndex: 0 }],
      defaultOwner: "owner",
      defaultRepo: "repo",
      remote: "origin",
      gitAvailable: true,
    });
    vi.mocked(runServer).mockResolvedValue(undefined);
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith(
        "https://gitea.example",
        [{ source: "env", secret: "tok", schemes: ["token"], status: "pending", nextSchemeIndex: 0 }],
        "owner",
        "repo",
        undefined,
        true,
        undefined,
        undefined,
      );
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("forwards gitAvailable=false so gitea_status can surface the fallback guidance", async () => {
    vi.mocked(discoverConfig).mockResolvedValue({
      baseUrl: "https://gitea.example",
      candidates: [],
      defaultOwner: "owner",
      defaultRepo: "repo",
      remote: "origin",
      gitAvailable: false,
    });
    vi.mocked(runServer).mockResolvedValue(undefined);
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith("https://gitea.example", [], "owner", "repo", undefined, false, undefined, undefined);
    });
  });

  it("starts the server with empty candidates when discovery yields none", async () => {
    vi.mocked(discoverConfig).mockResolvedValue({
      baseUrl: "https://gitea.example",
      candidates: [],
      defaultOwner: "owner",
      defaultRepo: "repo",
      remote: "origin",
    });
    vi.mocked(runServer).mockResolvedValue(undefined);
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith("https://gitea.example", [], "owner", "repo", undefined, undefined, undefined, undefined);
    });
  });

  it("logs a fatal error and exits 1 when runServer rejects", async () => {
    vi.mocked(discoverConfig).mockResolvedValue({
      baseUrl: "https://gitea.example",
      candidates: [],
    });
    exitSpy.mockImplementation((() => undefined) as never);
    vi.mocked(runServer).mockRejectedValue(new Error("boom"));
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith("Fatal error:", expect.any(Error));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it("dispatches the init subcommand to runInitCommand without credentials", async () => {
    process.argv = ["node", "cli.js", "init", "--tool", "claude"];
    const skills = await import("../skills.js");
    vi.mocked(skills.runInitCommand).mockResolvedValue(undefined);
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(skills.runInitCommand).toHaveBeenCalledWith(["--tool", "claude"]);
    });
    expect(runServer).not.toHaveBeenCalled();
    expect(discoverConfig).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("logs a fatal error and exits 1 when runInitCommand rejects", async () => {
    process.argv = ["node", "cli.js", "init"];
    exitSpy.mockImplementation((() => undefined) as never);
    const skills = await import("../skills.js");
    vi.mocked(skills.runInitCommand).mockRejectedValue(new Error("boom"));
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith("Fatal error:", expect.any(Error));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it("prints top-level usage and exits 0 on --help", async () => {
    process.argv = ["node", "cli.js", "--help"];
    await expect(import("../cli.js")).rejects.toThrow("process.exit(0)");
    const out = outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toContain("Usage: gitea-mcp");
    expect(out).toContain("Commands:");
    expect(out).toContain("init");
    expect(out).toContain("-h, --help");
    expect(runServer).not.toHaveBeenCalled();
    expect(discoverConfig).not.toHaveBeenCalled();
  });

  it("prints top-level usage and exits 0 on -h", async () => {
    process.argv = ["node", "cli.js", "-h"];
    await expect(import("../cli.js")).rejects.toThrow("process.exit(0)");
    expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("Usage: gitea-mcp");
    expect(runServer).not.toHaveBeenCalled();
  });

  it("prints top-level usage and exits 0 on help subcommand", async () => {
    process.argv = ["node", "cli.js", "help"];
    await expect(import("../cli.js")).rejects.toThrow("process.exit(0)");
    expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("Usage: gitea-mcp");
    expect(discoverConfig).not.toHaveBeenCalled();
  });

  it("prints version and exits 0 on --version", async () => {
    process.argv = ["node", "cli.js", "--version"];
    await expect(import("../cli.js")).rejects.toThrow("process.exit(0)");
    const out = outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toMatch(/gitea-mcp \d+\.\d+\.\d+/);
    expect(runServer).not.toHaveBeenCalled();
    expect(discoverConfig).not.toHaveBeenCalled();
  });

  it("prints version and exits 0 on -V", async () => {
    process.argv = ["node", "cli.js", "-V"];
    await expect(import("../cli.js")).rejects.toThrow("process.exit(0)");
    expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toMatch(/gitea-mcp \d+\.\d+\.\d+/);
    expect(runServer).not.toHaveBeenCalled();
  });
});

describe("platform selection", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    savedEnv = { ...process.env };
    delete process.env.MCP_PLATFORM;
    delete process.env.GITLAB_BASE_URL;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_REPO_URL;
    delete process.env.GITEA_BASE_URL;
    delete process.env.GITEA_TOKEN;
    delete process.env.GITEA_REPO_URL;
    process.argv = ["node", "cli.js"];
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runServer).mockReset();
    vi.mocked(discoverConfig).mockReset();
    vi.mocked(discoverGitLabConfig).mockReset();
    // Importing cli.js starts the server branch; give both discovery mocks a
    // safe default so the module under test can resolve its imports.
    vi.mocked(discoverConfig).mockResolvedValue(null);
    vi.mocked(discoverGitLabConfig).mockResolvedValue(null);
    vi.mocked(runServer).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it("resolvePlatform defaults to gitea with no env hints", async () => {
    const { resolvePlatform } = await import("../cli.js");
    expect(resolvePlatform({})).toBe("gitea");
  });

  it("resolvePlatform auto-selects gitlab from GITLAB_* env vars", async () => {
    const { resolvePlatform } = await import("../cli.js");
    expect(resolvePlatform({ GITLAB_BASE_URL: "https://gl" })).toBe("gitlab");
    expect(resolvePlatform({ GITLAB_TOKEN: "t" })).toBe("gitlab");
  });

  it("resolvePlatform keeps gitea when both platforms' env vars are present", async () => {
    const { resolvePlatform } = await import("../cli.js");
    expect(resolvePlatform({ GITLAB_BASE_URL: "https://gl", GITEA_TOKEN: "t" })).toBe("gitea");
  });

  it("an explicit MCP_PLATFORM wins over auto-detection; invalid values throw", async () => {
    const { resolvePlatform } = await import("../cli.js");
    expect(resolvePlatform({ MCP_PLATFORM: "gitlab", GITEA_TOKEN: "t" })).toBe("gitlab");
    expect(resolvePlatform({ MCP_PLATFORM: "gitea", GITLAB_BASE_URL: "https://gl" })).toBe("gitea");
    expect(() => resolvePlatform({ MCP_PLATFORM: "sourcehut" })).toThrow(
      "Invalid MCP_PLATFORM 'sourcehut': expected 'gitea' or 'gitlab'.",
    );
  });

  it("MCP_PLATFORM=gitlab runs the GitLab discovery and passes the platform to runServer", async () => {
    process.env.MCP_PLATFORM = "gitlab";
    vi.mocked(discoverGitLabConfig).mockResolvedValue({
      baseUrl: "https://gitlab.example",
      candidates: [],
      defaultOwner: "o",
      defaultRepo: "r",
      remote: "origin",
      gitAvailable: true,
    });
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith(
        "https://gitlab.example",
        [],
        "o",
        "r",
        undefined,
        true,
        "gitlab",
        undefined,
      );
    });
    expect(discoverConfig).not.toHaveBeenCalled();
  });

  it("MCP_PLATFORM=gitlab with no discovery result starts UNCONFIGURED with GitLab guidance", async () => {
    process.env.MCP_PLATFORM = "gitlab";
    vi.mocked(discoverGitLabConfig).mockResolvedValue(null);
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith(undefined, undefined, undefined, undefined, undefined, undefined, "gitlab", undefined);
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("GITLAB_BASE_URL"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("configure_gitlab"));
  });

  it("an invalid MCP_PLATFORM exits 1 with a fatal error", async () => {
    process.env.MCP_PLATFORM = "sourcehut";
    await expect(import("../cli.js")).rejects.toThrow("process.exit(1)");
    expect(errSpy).toHaveBeenCalledWith("Fatal error:", expect.any(Error));
  });

  it("resolvePlatform recognizes the repo-URL variables on both platforms", async () => {
    const { resolvePlatform } = await import("../cli.js");
    expect(resolvePlatform({ GITEA_REPO_URL: "https://u:t@gitea.example/o/r.git" })).toBe("gitea");
    expect(resolvePlatform({ GITLAB_REPO_URL: "https://u:t@gitlab.example/o/r.git" })).toBe("gitlab");
    expect(
      resolvePlatform({ GITLAB_REPO_URL: "https://u:t@gitlab.example/o/r.git", GITEA_TOKEN: "t" }),
    ).toBe("gitea");
  });

  it("a GITLAB_REPO_URL-only process auto-selects gitlab and runs the GitLab discovery", async () => {
    process.env.GITLAB_REPO_URL = "https://u:t@gitlab.example/o/r.git";
    vi.mocked(discoverGitLabConfig).mockResolvedValue({
      baseUrl: "https://gitlab.example",
      candidates: [
        { source: "repo-url", secret: "t", schemes: ["bearer"], status: "pending", nextSchemeIndex: 0 },
      ],
      defaultOwner: "o",
      defaultRepo: "r",
      gitAvailable: true,
    });
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith(
        "https://gitlab.example",
        [{ source: "repo-url", secret: "t", schemes: ["bearer"], status: "pending", nextSchemeIndex: 0 }],
        "o",
        "r",
        undefined,
        true,
        "gitlab",
        undefined,
      );
    });
    expect(discoverConfig).not.toHaveBeenCalled();
  });

  it("the unconfigured notice names the platform's BASE_URL and REPO_URL variables", async () => {
    vi.mocked(discoverConfig).mockResolvedValue(null);
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("GITEA_BASE_URL"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("GITEA_REPO_URL"));
  });
});

describe("tool allowlist env wiring", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    savedEnv = { ...process.env };
    delete process.env.MCP_PLATFORM;
    delete process.env.MCP_TOOL_ALLOWLIST;
    delete process.env.GITLAB_BASE_URL;
    delete process.env.GITLAB_TOKEN;
    process.argv = ["node", "cli.js"];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runServer).mockReset();
    vi.mocked(discoverConfig).mockReset();
    vi.mocked(discoverGitLabConfig).mockReset();
    vi.mocked(discoverConfig).mockResolvedValue(null);
    vi.mocked(discoverGitLabConfig).mockResolvedValue(null);
    vi.mocked(runServer).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it("resolveToolAllowlist returns undefined when unset, empty, or whitespace-only", async () => {
    const { resolveToolAllowlist } = await import("../cli.js");
    expect(resolveToolAllowlist({})).toBeUndefined();
    expect(resolveToolAllowlist({ MCP_TOOL_ALLOWLIST: "" })).toBeUndefined();
    expect(resolveToolAllowlist({ MCP_TOOL_ALLOWLIST: "   " })).toBeUndefined();
    expect(resolveToolAllowlist({ MCP_TOOL_ALLOWLIST: " , " })).toBeUndefined();
    expect(resolveToolAllowlist({ MCP_TOOL_ALLOWLIST: ",," })).toBeUndefined();
  });

  it("resolveToolAllowlist splits on commas and trims entries", async () => {
    const { resolveToolAllowlist } = await import("../cli.js");
    expect(resolveToolAllowlist({ MCP_TOOL_ALLOWLIST: "list_issues" })).toEqual(["list_issues"]);
    expect(resolveToolAllowlist({ MCP_TOOL_ALLOWLIST: " list_issues ,  get_issue " })).toEqual([
      "list_issues",
      "get_issue",
    ]);
    expect(resolveToolAllowlist({ MCP_TOOL_ALLOWLIST: "list_issues,," })).toEqual(["list_issues"]);
  });

  it("forwards the parsed allowlist to runServer on the gitea platform", async () => {
    process.env.MCP_TOOL_ALLOWLIST = "list_issues, get_issue";
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ["list_issues", "get_issue"],
      );
    });
  });

  it("forwards the parsed allowlist to runServer on the gitlab platform", async () => {
    process.env.MCP_PLATFORM = "gitlab";
    process.env.MCP_TOOL_ALLOWLIST = "list_issues";
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(runServer).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "gitlab",
        ["list_issues"],
      );
    });
  });

  it("an unknown entry surfaces as Fatal error + exit 1 when runServer rejects", async () => {
    exitSpy.mockImplementation((() => undefined) as never);
    process.env.MCP_TOOL_ALLOWLIST = "no_such_tool";
    vi.mocked(runServer).mockRejectedValue(
      new Error("Invalid MCP_TOOL_ALLOWLIST entry 'no_such_tool': not a tool on the gitea platform."),
    );
    await import("../cli.js");
    await vi.waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith("Fatal error:", expect.any(Error));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
