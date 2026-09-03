import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GiteaClient } from "../gitea-client.js";
import { GitLabClient } from "../gitlab-client.js";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoverCredentialsForHostOptions, DiscoverCredentialsForHostResult } from "../git-config.js";

vi.mock("../gitea-client.js", () => ({
  GiteaClient: vi.fn(),
}));
vi.mock("../gitlab-client.js", () => ({
  GitLabClient: vi.fn(),
}));

// Wrap (not replace) readFile: the default implementation delegates to the
// real one so the attachment-confinement and asset paths keep working; the
// resolve_repo test overrides it per-call.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrappedReadFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) =>
    actual.readFile(...args));
  return { ...actual, readFile: wrappedReadFile };
});

/** Same method surface server.ts wires for either client (union type). */
const CLIENT_METHODS = [
  "listIssues", "getIssue", "createIssue", "updateIssue", "deleteIssue", "searchIssues",
  "listComments", "createComment", "updateComment", "deleteComment",
  "createIssueAttachment", "listIssueAttachments", "getIssueAttachment",
  "editIssueAttachment", "deleteIssueAttachment", "createIssueCommentAttachment",
  "listLabels", "createLabel", "updateLabel", "deleteLabel",
  "addIssueLabels", "removeIssueLabel", "replaceIssueLabels", "clearIssueLabels",
  "listIssueDependencies", "addIssueDependency", "removeIssueDependency",
  "listIssueBlocks", "addIssueBlock", "removeIssueBlock", "checkIssueBlocked",
  "listMilestones", "getMilestone", "createMilestone", "updateMilestone", "deleteMilestone",
  "listMyRepos", "getCredentialStatus", "configure", "isConfigured", "getBaseUrl",
  "listTopics", "replaceTopics", "addTopic", "removeTopic",
  "listPullRequests", "getPullRequest", "createPullRequest", "updatePullRequest",
  "mergePullRequest", "isPullMerged", "listPullCommits", "listPullFiles",
  "listActionRuns", "getActionRun", "cancelActionRun", "rerunActionRun", "rerunActionRunFailedJobs",
  "listReleases", "getRelease", "getReleaseByTag", "createRelease", "updateRelease", "deleteRelease",
  "getRepo", "updateRepo",
  "listWikiPages", "getWikiPage", "createWikiPage", "updateWikiPage", "deleteWikiPage", "listWikiRevisions",
  "listProjects", "getProject",
] as const;

type MockClient = Record<string, ReturnType<typeof vi.fn>>;
let mockGitLabClient: MockClient;

interface RegisteredTool {
  description: string;
  inputSchema: unknown;
  handler: (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
}

function registeredTools(server: { _registeredTools: Record<string, RegisteredTool> }) {
  return server._registeredTools;
}

/** The 72 GitLab-mode tools: 68 shared business tools + resolve_repo/list_my_repos + the GitLab diagnostic pair. */
const EXPECTED_GITLAB_TOOLS = [
  "list_issues", "get_issue", "create_issue", "update_issue", "delete_issue", "search_issues",
  "list_comments", "create_comment", "update_comment", "delete_comment",
  "create_issue_attachment", "list_issue_attachments", "get_issue_attachment",
  "edit_issue_attachment", "delete_issue_attachment", "create_issue_comment_attachment",
  "list_labels", "create_label", "update_label", "delete_label",
  "add_issue_labels", "remove_issue_label", "replace_issue_labels", "clear_issue_labels",
  "list_issue_dependencies", "add_issue_dependency", "remove_issue_dependency",
  "list_issue_blocks", "add_issue_block", "remove_issue_block", "check_issue_blocked",
  "list_milestones", "get_milestone", "create_milestone", "update_milestone", "delete_milestone",
  "list_topics", "replace_topics", "add_topic", "remove_topic",
  "list_pull_requests", "get_pull_request", "create_pull_request", "update_pull_request",
  "merge_pull_request", "is_pull_merged", "list_pull_commits", "list_pull_files",
  "list_action_runs", "get_action_run", "cancel_action_run",
  "rerun_action_run", "rerun_action_run_failed_jobs",
  "list_releases", "get_release", "get_release_by_tag",
  "create_release", "update_release", "delete_release",
  "update_repo",
  "list_wiki_pages", "get_wiki_page", "create_wiki_page",
  "update_wiki_page", "delete_wiki_page", "list_wiki_revisions",
  "list_projects", "get_project",
  "resolve_repo", "list_my_repos", "gitlab_status", "configure_gitlab",
];

function wireMock(instance: MockClient, impl: unknown): void {
  for (const m of CLIENT_METHODS) instance[m] = vi.fn();
  (impl as ReturnType<typeof vi.fn>).mockImplementation(function () {
    return instance;
  } as never);
}

describe("createServer in gitlab platform mode", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGitLabClient = {};
    wireMock(mockGitLabClient, GitLabClient);
  });

  it("constructs the GitLabClient with the discovered baseUrl", async () => {
    const { createServer } = await import("../server.js");
    await createServer("https://gitlab.example", undefined, undefined, undefined, undefined, undefined, "gitlab");
    expect(GitLabClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://gitlab.example" }));
  });

  it("registers the GitLab diagnostic pair and not the Gitea one", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://gl", undefined, "o", "r", undefined, undefined, "gitlab");
    const tools = Object.keys(registeredTools(server as never)).sort();
    expect(tools).toEqual([...EXPECTED_GITLAB_TOOLS].sort());
    expect(tools).not.toContain("configure_gitea");
    expect(tools).not.toContain("gitea_status");
  });

  it("business tools route to the GitLabClient", async () => {
    const { createServer } = await import("../server.js");
    mockGitLabClient.listIssues.mockResolvedValue([]);
    const server = await createServer("https://gl", undefined, "o", "r", undefined, undefined, "gitlab");
    await registeredTools(server as never)["list_issues"].handler({ state: "open" });
    expect(mockGitLabClient.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", state: "open" }),
    );
  });

  it("resolve() error guidance names the GITLAB_* env vars and configure_gitlab", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://gl", undefined, undefined, undefined, undefined, undefined, "gitlab");
    await expect(
      registeredTools(server as never)["list_issues"].handler({}),
    ).rejects.toThrow(/GITLAB_DEFAULT_OWNER\/GITLAB_DEFAULT_REPO[\s\S]*configure_gitlab/);
  });

  it("gitlab_status reports the redacted credential snapshot + session target", async () => {
    const { createServer } = await import("../server.js");
    // Note: secret redaction itself is summarizeCandidates' contract, covered
    // in credentials.test.ts; here we assert the payload composition only.
    mockGitLabClient.getCredentialStatus.mockReturnValue({
      configured: true,
      baseUrl: "https://gl",
      candidates: [
        { source: "env", schemes: ["bearer"], username: null, secretPresent: true, status: "active", lastTriedScheme: null, activeScheme: "bearer", lastError: null },
      ],
      activeIndex: 0,
      totalCandidates: 1,
    });
    const server = await createServer("https://gl", undefined, "o", "r", undefined, true, "gitlab");
    const result = await registeredTools(server as never)["gitlab_status"].handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      configured: true,
      baseUrl: "https://gl",
      owner: "o",
      repo: "r",
      gitAvailable: true,
      totalCandidates: 1,
    });
    expect(payload.candidates[0]).toMatchObject({ source: "env", secretPresent: true, activeScheme: "bearer" });
  });

  it("configure_gitlab runs the platform discovery and resets the client atomically", async () => {
    const { createServer } = await import("../server.js");
    const discovered: DiscoverCredentialsForHostResult = {
      candidates: [
        { source: "gitlab-config", secret: "gl-tok", schemes: ["bearer"], status: "pending", nextSchemeIndex: 0 },
      ],
      gitAvailable: true,
    };
    const discover = vi.fn(async (_o: DiscoverCredentialsForHostOptions) => discovered);
    mockGitLabClient.getCredentialStatus.mockReturnValue({
      configured: true,
      baseUrl: "https://gl",
      candidates: [],
      activeIndex: null,
      totalCandidates: 1,
    });
    const server = await createServer("https://gl", undefined, "o", "r", { discoverCredentials: discover }, undefined, "gitlab");
    await registeredTools(server as never)["configure_gitlab"].handler({
      base_url: "https://gitlab.example",
    });
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://gitlab.example", repoPath: "o/r" }),
    );
    expect(mockGitLabClient.configure).toHaveBeenCalledWith({
      baseUrl: "https://gitlab.example",
      candidates: discovered.candidates,
    });
  });

  it("configure_gitlab requires at least one parameter", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://gl", undefined, "o", "r", undefined, undefined, "gitlab");
    await expect(
      registeredTools(server as never)["configure_gitlab"].handler({}),
    ).rejects.toThrow("At least one of base_url, owner, repo, or username must be provided.");
  });

  it("resolve_repo errors when the git config has no parseable remote", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://gl", undefined, undefined, undefined, undefined, undefined, "gitlab");
    // Two readFile calls happen: the `.git` probe (ENOENT → conventional
    // path) and the git-config read — queue an empty payload for each so
    // parseRemotes sees a remote-less config.
    vi.mocked(readFile).mockResolvedValueOnce("" as never).mockResolvedValueOnce("" as never);
    await expect(
      registeredTools(server as never)["resolve_repo"].handler({ path: "/repo-without-remotes" }),
    ).rejects.toThrow("No parseable git remotes found");
  });

  it("registers no Gitea guide resources on GitLab (they document Gitea object shapes)", async () => {
    const { createServer } = await import("../server.js");
    const gitlabServer = await createServer("https://gl", undefined, undefined, undefined, undefined, undefined, "gitlab");
    const giteaServer = await createServer("https://g");
    const resourcesOf = (s: unknown) =>
      Object.keys((s as { _registeredResources: Record<string, unknown> })._registeredResources);
    expect(resourcesOf(gitlabServer)).toEqual([]);
    expect(resourcesOf(giteaServer)).toHaveLength(3);
  });

  it("serves the Gitea guide resources through the registered read callbacks", async () => {
    const { createServer } = await import("../server.js");
    const giteaServer = await createServer("https://g");
    const resources = (giteaServer as unknown as {
      _registeredResources: Record<
        string,
        { readCallback: () => Promise<{ contents: { uri: string; text: string }[] }> }
      >;
    })._registeredResources;
    for (const uri of Object.keys(resources)) {
      const result = await resources[uri].readCallback();
      expect(result.contents[0].uri).toBe(uri);
      // Real asset content, not the "unavailable in the current build" fallback.
      expect(result.contents[0].text.length).toBeGreaterThan(0);
      expect(result.contents[0].text).not.toContain("unavailable in the current build");
    }
  });
});

describe("GitLab-mode attachment upload (real file through the confinement choke point)", () => {
  let uploadRoot: string;
  let savedUploadRoot: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGitLabClient = {};
    wireMock(mockGitLabClient, GitLabClient);
    savedUploadRoot = process.env.GITEA_UPLOAD_ROOT;
    uploadRoot = await mkdtemp(join(tmpdir(), "gitea-mcp-upload-gl-"));
    process.env.GITEA_UPLOAD_ROOT = uploadRoot;
  });

  afterEach(async () => {
    if (savedUploadRoot === undefined) delete process.env.GITEA_UPLOAD_ROOT;
    else process.env.GITEA_UPLOAD_ROOT = savedUploadRoot;
    await rm(uploadRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("create_issue_attachment reads a real file inside the upload root and forwards it", async () => {
    const { createServer } = await import("../server.js");
    await writeFile(join(uploadRoot, "log.txt"), new Uint8Array([7, 8, 9]));
    mockGitLabClient.createIssueAttachment.mockResolvedValue({ id: 5, name: "log.txt" });
    const server = await createServer("https://gl", undefined, "o", "r", undefined, undefined, "gitlab");
    const result = await registeredTools(server as never)["create_issue_attachment"].handler({
      index: 3,
      file_path: join(uploadRoot, "log.txt"),
    });
    expect(mockGitLabClient.createIssueAttachment).toHaveBeenCalledWith(
      "o", "r", 3,
      { data: expect.any(Uint8Array), name: "log.txt" },
      undefined,
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 5, name: "log.txt" });
  });

  it("create_issue_attachment reports file-not-readable for an unreadable entry", async () => {
    const { createServer } = await import("../server.js");
    // A directory named like an allowed upload passes every confinement
    // check but fails at read time → the generic path-free error.
    await mkdir(join(uploadRoot, "weird.txt"));
    const server = await createServer("https://gl", undefined, "o", "r", undefined, undefined, "gitlab");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3,
        file_path: join(uploadRoot, "weird.txt"),
      }),
    ).rejects.toThrow("Attachment upload rejected: file not readable.");
  });
});

describe("createServer default platform stays gitea", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGitLabClient = {};
    wireMock(mockGitLabClient, GitLabClient);
  });

  it("constructs a GiteaClient and registers configure_gitea when platform is omitted", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g.example");
    expect(GiteaClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://g.example" }));
    const tools = Object.keys(registeredTools(server as never));
    expect(tools).toContain("configure_gitea");
    expect(tools).toContain("gitea_status");
    expect(tools).not.toContain("configure_gitlab");
    expect(tools).not.toContain("gitlab_status");
    expect(GitLabClient).not.toHaveBeenCalled();
  });
});

describe("GitLab-mode handler smoke (every shared tool routes and serializes)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGitLabClient = {};
    wireMock(mockGitLabClient, GitLabClient);
    // One generic payload satisfies every pass-through handler; handlers only
    // JSON-serialize whatever the client returns.
    for (const m of CLIENT_METHODS) mockGitLabClient[m]?.mockResolvedValue({ ok: true });
    mockGitLabClient.listActionRuns.mockResolvedValue({ workflow_runs: [], count: 0 });
    mockGitLabClient.isPullMerged.mockResolvedValue(false);
    mockGitLabClient.getCredentialStatus.mockReturnValue({
      configured: true,
      baseUrl: "https://gl",
      candidates: [],
      activeIndex: null,
      totalCandidates: 0,
    });
  });

  it("every shared business handler resolves through the GitLabClient", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://gl", undefined, "o", "r", undefined, undefined, "gitlab");
    const tools = registeredTools(server as never);
    // configure_gitlab needs a discovery injection (covered above); the
    // status pair is covered above too. resolve_repo touches the real
    // filesystem and is platform-independent (covered by server.test.ts).
    const shared = Object.keys(tools).filter(
      (t) =>
        t !== "configure_gitlab" && t !== "gitlab_status" && t !== "resolve_repo",
    );
    const richInput = {
      owner: "o",
      repo: "r",
      index: 1,
      id: 1,
      attachment_id: 1,
      comment_id: 1,
      runId: 1,
      tag: "v1",
      pageName: "Home",
      topic: "t",
      page: 1,
      limit: 1,
      title: "t",
      body: "b",
      content: "c",
      name: "n",
      description: "d",
      color: "#ff0000",
      labels: "a",
      state: "open",
      query: "q",
      type: "issues",
      file_path: "definitely/missing/file.bin",
    };
    for (const name of shared) {
      // The two attachment-upload handlers throw at the confinement boundary
      // for the bogus path (readUploadFile) — rejecting is their covered
      // outcome; every other handler must resolve with MCP content.
      if (name === "create_issue_attachment" || name === "create_issue_comment_attachment") {
        await expect(tools[name].handler(richInput as Record<string, unknown>)).rejects.toThrow(
          /Attachment upload rejected/,
        );
      } else {
        await expect(
          tools[name].handler(richInput as Record<string, unknown>),
        ).resolves.toHaveProperty("content");
      }
    }
    expect(shared.length).toBeGreaterThan(60);
    // Every shared handler must have delegated to the mocked GitLabClient.
    const touched = CLIENT_METHODS.filter(
      (m) => (mockGitLabClient[m] as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    expect(touched.length).toBeGreaterThan(40);
  });
});
