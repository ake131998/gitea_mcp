import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GiteaClient } from "../gitea-client.js";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../gitea-client.js", () => ({
  GiteaClient: vi.fn(),
}));

// readFile is wrapped (not replaced): the default implementation delegates to
// the real one. resolve_repo / instructions tests override it per-call with
// mockResolvedValue/mockImplementation — vi.clearAllMocks() does NOT remove
// those, so each such test MUST restore the delegate at the end via
// restoreReadFile(). The attachment-confinement tests then exercise the REAL
// readFile; realpath/stat and the temp-dir writes below always use the real
// filesystem, since readUploadFile's security behavior (symlink escape,
// canonical basename, stat-before-read) can only be asserted against the
// real fs, mirroring guidance.test.ts's real-asset reads.
const realReadFileRef = (await vi.importActual<
  typeof import("node:fs/promises")
>("node:fs/promises")).readFile;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrappedReadFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) =>
    actual.readFile(...args));
  return {
    ...actual,
    readFile: wrappedReadFile,
  };
});

import { readFile } from "node:fs/promises";

/** Restore the delegating readFile implementation after a per-test override. */
function restoreReadFile(): void {
  vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof realReadFileRef>) =>
    realReadFileRef(...args) as never);
}

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
let mockClient: MockClient;

interface RegisteredTool {
  description: string;
  handler: (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
}

function registeredTools(server: { _registeredTools: Record<string, RegisteredTool> }) {
  return server._registeredTools;
}

// Real temp-dir upload root for the attachment-confinement tests. The
// node:fs/promises mock was removed on purpose: readUploadFile's security
// behavior (realpath, symlink escape, stat-before-read) can only be asserted
// against the real filesystem, mirroring guidance.test.ts's real-asset reads.
let uploadRoot: string;
const savedUploadRoot = process.env.GITEA_UPLOAD_ROOT;

async function resetUploadRoot() {
  uploadRoot = await mkdtemp(join(tmpdir(), "gitea-mcp-upload-"));
  process.env.GITEA_UPLOAD_ROOT = uploadRoot;
}

const EXPECTED_TOOLS = [
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
  "resolve_repo", "list_my_repos", "gitea_status", "configure_gitea",
];

describe("createServer", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient = {};
    for (const m of CLIENT_METHODS) mockClient[m] = vi.fn();
    vi.mocked(GiteaClient).mockImplementation(function () { return mockClient; } as never);
  });

  it("constructs the GiteaClient with baseUrl", async () => {
    const { createServer } = await import("../server.js");
    await createServer("https://g.example");
    expect(GiteaClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://g.example" }));
  });

  it("registers all expected tools", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g");
    expect(Object.keys(registeredTools(server as never)).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("every tool has a non-empty description", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    for (const tool of Object.values(registeredTools(server as never))) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("owner/repo resolution", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient = {};
    for (const m of CLIENT_METHODS) mockClient[m] = vi.fn();
    vi.mocked(GiteaClient).mockImplementation(function () { return mockClient; } as never);
  });

  it("uses explicit owner/repo when provided", async () => {
    const { createServer } = await import("../server.js");
    mockClient.listIssues.mockResolvedValue([]);
    const server = await createServer("https://g", undefined, "defOwner", "defRepo");
    const handler = registeredTools(server as never)["list_issues"].handler;
    await handler({ owner: "o", repo: "r" });
    expect(mockClient.listIssues).toHaveBeenCalledWith(expect.objectContaining({ owner: "o", repo: "r" }));
  });

  it("falls back to defaults when owner/repo omitted", async () => {
    const { createServer } = await import("../server.js");
    mockClient.listIssues.mockResolvedValue([]);
    const server = await createServer("https://g", undefined, "defOwner", "defRepo");
    await registeredTools(server as never)["list_issues"].handler({});
    expect(mockClient.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "defOwner", repo: "defRepo" }),
    );
  });

  it("throws when neither explicit nor default owner/repo is available", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g");
    await expect(
      registeredTools(server as never)["list_issues"].handler({}),
    ).rejects.toThrow("owner and repo are required");
  });
});

describe("tool handlers", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient = {};
    for (const m of CLIENT_METHODS) mockClient[m] = vi.fn();
    vi.mocked(GiteaClient).mockImplementation(function () { return mockClient; } as never);
    await resetUploadRoot();
  });

  it("list_issues returns JSON of the client result", async () => {
    const { createServer } = await import("../server.js");
    const issues = [{ id: 1, number: 1 }];
    mockClient.listIssues.mockResolvedValue(issues);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_issues"].handler({});
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual(issues);
  });

  it("create_issue spreads owner/repo into the create params", async () => {
    const { createServer } = await import("../server.js");
    mockClient.createIssue.mockResolvedValue({ id: 2 });
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["create_issue"].handler({
      title: "Bug",
      body: "desc",
      labels: [1, 2],
    });
    expect(mockClient.createIssue).toHaveBeenCalledWith({ owner: "o", repo: "r", title: "Bug", body: "desc", labels: [1, 2] });
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 2 });
  });

  it("delete_issue deletes and returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.deleteIssue.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["delete_issue"].handler({ index: 7 });
    expect(mockClient.deleteIssue).toHaveBeenCalledWith("o", "r", 7);
    expect(result.content[0].text).toBe("Issue #7 deleted.");
  });

  it("create_comment forwards index and body", async () => {
    const { createServer } = await import("../server.js");
    mockClient.createComment.mockResolvedValue({ id: 10 });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["create_comment"].handler({ index: 3, body: "hi" });
    expect(mockClient.createComment).toHaveBeenCalledWith("o", "r", 3, "hi");
  });

  it("create_issue_attachment reads the file and forwards bytes + basename", async () => {
    const { createServer } = await import("../server.js");
    const bytes = new Uint8Array([1, 2, 3]);
    await writeFile(join(uploadRoot, "log.txt"), bytes);
    mockClient.createIssueAttachment.mockResolvedValue({ id: 5, name: "log.txt" });
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["create_issue_attachment"].handler({
      index: 3,
      file_path: join(uploadRoot, "log.txt"),
    });
    expect(mockClient.createIssueAttachment).toHaveBeenCalledWith(
      "o", "r", 3,
      { data: expect.any(Uint8Array), name: "log.txt" },
      undefined,
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 5, name: "log.txt" });
  });

  it("create_issue_attachment passes the explicit name through", async () => {
    const { createServer } = await import("../server.js");
    const bytes = new Uint8Array([1]);
    await writeFile(join(uploadRoot, "log.txt"), bytes);
    mockClient.createIssueAttachment.mockResolvedValue({ id: 6 });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["create_issue_attachment"].handler({
      index: 3,
      file_path: join(uploadRoot, "log.txt"),
      name: "renamed.txt",
    });
    expect(mockClient.createIssueAttachment).toHaveBeenCalledWith(
      "o", "r", 3,
      { data: expect.any(Uint8Array), name: "log.txt" },
      "renamed.txt",
    );
  });

  it("list_issue_attachments returns JSON of the client result", async () => {
    const { createServer } = await import("../server.js");
    const attachments = [{ id: 5, name: "log.txt" }];
    mockClient.listIssueAttachments.mockResolvedValue(attachments);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_issue_attachments"].handler({ index: 3 });
    expect(mockClient.listIssueAttachments).toHaveBeenCalledWith("o", "r", 3);
    expect(JSON.parse(result.content[0].text)).toEqual(attachments);
  });

  it("get_issue_attachment forwards index and attachment_id", async () => {
    const { createServer } = await import("../server.js");
    mockClient.getIssueAttachment.mockResolvedValue({ id: 5 });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["get_issue_attachment"].handler({ index: 3, attachment_id: 5 });
    expect(mockClient.getIssueAttachment).toHaveBeenCalledWith("o", "r", 3, 5);
  });

  it("edit_issue_attachment forwards the new name", async () => {
    const { createServer } = await import("../server.js");
    mockClient.editIssueAttachment.mockResolvedValue({ id: 5, name: "new.txt" });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["edit_issue_attachment"].handler({ index: 3, attachment_id: 5, name: "new.txt" });
    expect(mockClient.editIssueAttachment).toHaveBeenCalledWith("o", "r", 3, 5, "new.txt");
  });

  it("delete_issue_attachment deletes and returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.deleteIssueAttachment.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["delete_issue_attachment"].handler({ index: 3, attachment_id: 5 });
    expect(mockClient.deleteIssueAttachment).toHaveBeenCalledWith("o", "r", 3, 5);
    expect(result.content[0].text).toBe("Attachment #5 deleted from issue #3.");
  });

  it("create_issue_comment_attachment reads the file and forwards bytes + basename", async () => {
    const { createServer } = await import("../server.js");
    const bytes = new Uint8Array([9, 9]);
    await writeFile(join(uploadRoot, "shot.png"), bytes);
    mockClient.createIssueCommentAttachment.mockResolvedValue({ id: 7, name: "shot.png" });
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["create_issue_comment_attachment"].handler({
      comment_id: 42,
      file_path: join(uploadRoot, "shot.png"),
    });
    expect(mockClient.createIssueCommentAttachment).toHaveBeenCalledWith(
      "o", "r", 42,
      { data: expect.any(Uint8Array), name: "shot.png" },
      undefined,
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 7, name: "shot.png" });
  });

  it("remove_issue_label returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.removeIssueLabel.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["remove_issue_label"].handler({ index: 5, id: 9 });
    expect(result.content[0].text).toBe("Label #9 removed from issue #5.");
  });

  it("search_issues does not require owner/repo", async () => {
    const { createServer } = await import("../server.js");
    mockClient.searchIssues.mockResolvedValue([]);
    const server = await createServer("https://g");
    const result = await registeredTools(server as never)["search_issues"].handler({ query: "x" });
    expect(mockClient.searchIssues).toHaveBeenCalledWith({ query: "x" });
    expect(result.content[0].type).toBe("text");
  });

  it("list_my_repos forwards pagination", async () => {
    const { createServer } = await import("../server.js");
    mockClient.listMyRepos.mockResolvedValue([]);
    const server = await createServer("https://g");
    await registeredTools(server as never)["list_my_repos"].handler({ page: 2, limit: 30 });
    expect(mockClient.listMyRepos).toHaveBeenCalledWith(2, 30);
  });

  it("gitea_status returns the client credential status plus session state as JSON", async () => {
    const { createServer } = await import("../server.js");
    const status = {
      configured: true,
      baseUrl: "https://g",
      candidates: [{ source: "env", schemes: ["token"], status: "pending" }],
      activeIndex: null,
      totalCandidates: 1,
    };
    mockClient.getCredentialStatus.mockReturnValue(status);
    const server = await createServer("https://g", undefined, "owner", "repo");
    const result = await registeredTools(server as never)["gitea_status"].handler({});
    expect(mockClient.getCredentialStatus).toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ configured: true, baseUrl: "https://g", totalCandidates: 1 });
    expect(parsed).toMatchObject({ owner: "owner", repo: "repo" });
  });

  it("list_topics returns JSON of the client result", async () => {
    const { createServer } = await import("../server.js");
    mockClient.listTopics.mockResolvedValue({ topics: ["go", "mcp"] });
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_topics"].handler({});
    expect(mockClient.listTopics).toHaveBeenCalledWith(expect.objectContaining({ owner: "o", repo: "r" }));
    expect(JSON.parse(result.content[0].text)).toEqual({ topics: ["go", "mcp"] });
  });

  it("replace_topics spreads owner/repo into the replace params", async () => {
    const { createServer } = await import("../server.js");
    mockClient.replaceTopics.mockResolvedValue({ topics: ["go"] });
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["replace_topics"].handler({ topics: ["go"] });
    expect(mockClient.replaceTopics).toHaveBeenCalledWith({ owner: "o", repo: "r", topics: ["go"] });
    expect(JSON.parse(result.content[0].text)).toEqual({ topics: ["go"] });
  });

  it("add_topic forwards owner/repo/topic and returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.addTopic.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["add_topic"].handler({ topic: "go" });
    expect(mockClient.addTopic).toHaveBeenCalledWith("o", "r", "go");
    expect(result.content[0].text).toBe("Topic 'go' added to o/r.");
  });

  it("remove_topic forwards owner/repo/topic and returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.removeTopic.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["remove_topic"].handler({ topic: "go" });
    expect(mockClient.removeTopic).toHaveBeenCalledWith("o", "r", "go");
    expect(result.content[0].text).toBe("Topic 'go' removed from o/r.");
  });

  it("list_pull_requests returns JSON of the client result", async () => {
    const { createServer } = await import("../server.js");
    const pulls = [{ number: 1 }];
    mockClient.listPullRequests.mockResolvedValue(pulls);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_pull_requests"].handler({});
    expect(mockClient.listPullRequests).toHaveBeenCalledWith(expect.objectContaining({ owner: "o", repo: "r" }));
    expect(JSON.parse(result.content[0].text)).toEqual(pulls);
  });

  it("create_pull_request spreads owner/repo into the create params", async () => {
    const { createServer } = await import("../server.js");
    const pull = { number: 7 };
    mockClient.createPullRequest.mockResolvedValue(pull);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["create_pull_request"].handler({
      title: "T", head: "feature", base: "main",
    });
    expect(mockClient.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", title: "T", head: "feature", base: "main" }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual(pull);
  });

  it("get_pull_request forwards owner/repo/index and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const pull = { number: 42, title: "T" };
    mockClient.getPullRequest.mockResolvedValue(pull);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["get_pull_request"].handler({ index: 42 });
    expect(mockClient.getPullRequest).toHaveBeenCalledWith("o", "r", 42);
    expect(JSON.parse(result.content[0].text)).toEqual(pull);
  });

  it("update_pull_request spreads owner/repo into the update params", async () => {
    const { createServer } = await import("../server.js");
    mockClient.updatePullRequest.mockResolvedValue({ number: 3 });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["update_pull_request"].handler({ index: 3, state: "closed" });
    expect(mockClient.updatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", index: 3, state: "closed" }),
    );
  });

  it("merge_pull_request returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.mergePullRequest.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["merge_pull_request"].handler({ index: 9, Do: "squash" });
    expect(mockClient.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", index: 9, Do: "squash" }),
    );
    expect(result.content[0].text).toContain("merged");
  });

  it("is_pull_merged returns the merged boolean as JSON", async () => {
    const { createServer } = await import("../server.js");
    mockClient.isPullMerged.mockResolvedValue(true);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["is_pull_merged"].handler({ index: 1 });
    expect(mockClient.isPullMerged).toHaveBeenCalledWith("o", "r", 1);
    expect(JSON.parse(result.content[0].text)).toEqual({ merged: true });
  });

  it("list_pull_commits forwards owner/repo/index/pagination", async () => {
    const { createServer } = await import("../server.js");
    const commits = [{ sha: "abc" }];
    mockClient.listPullCommits.mockResolvedValue(commits);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_pull_commits"].handler({ index: 5, page: 1 });
    expect(mockClient.listPullCommits).toHaveBeenCalledWith("o", "r", 5, 1, undefined);
    expect(JSON.parse(result.content[0].text)).toEqual(commits);
  });

  it("list_pull_files forwards owner/repo/index/pagination", async () => {
    const { createServer } = await import("../server.js");
    const files = [{ filename: "a.ts" }];
    mockClient.listPullFiles.mockResolvedValue(files);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_pull_files"].handler({ index: 5 });
    expect(mockClient.listPullFiles).toHaveBeenCalledWith("o", "r", 5, undefined, undefined);
    expect(JSON.parse(result.content[0].text)).toEqual(files);
  });

  it("list_action_runs returns JSON of the client result", async () => {
    const { createServer } = await import("../server.js");
    const runs = { workflow_runs: [{ id: 1, status: "success" }], count: 1 };
    mockClient.listActionRuns.mockResolvedValue(runs);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_action_runs"].handler({ status: "failure" });
    expect(mockClient.listActionRuns).toHaveBeenCalledWith(expect.objectContaining({ owner: "o", repo: "r", status: "failure" }));
    expect(JSON.parse(result.content[0].text)).toEqual(runs);
  });

  it("get_action_run forwards owner/repo/runId and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const run = { id: 42, status: "in_progress" };
    mockClient.getActionRun.mockResolvedValue(run);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["get_action_run"].handler({ runId: 42 });
    expect(mockClient.getActionRun).toHaveBeenCalledWith("o", "r", 42);
    expect(JSON.parse(result.content[0].text)).toEqual(run);
  });

  it("cancel_action_run returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.cancelActionRun.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["cancel_action_run"].handler({ runId: 7 });
    expect(mockClient.cancelActionRun).toHaveBeenCalledWith("o", "r", 7);
    expect(result.content[0].text).toBe("Action run #7 cancelled.");
  });

  it("rerun_action_run returns the new run JSON when body present", async () => {
    const { createServer } = await import("../server.js");
    const newRun = { id: 100, status: "queued" };
    mockClient.rerunActionRun.mockResolvedValue(newRun);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["rerun_action_run"].handler({ runId: 9 });
    expect(mockClient.rerunActionRun).toHaveBeenCalledWith("o", "r", 9);
    expect(JSON.parse(result.content[0].text)).toEqual(newRun);
  });

  it("rerun_action_run returns a confirmation string when body absent", async () => {
    const { createServer } = await import("../server.js");
    mockClient.rerunActionRun.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["rerun_action_run"].handler({ runId: 9 });
    expect(result.content[0].text).toContain("rerun started");
  });

  it("rerun_action_run_failed_jobs returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.rerunActionRunFailedJobs.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["rerun_action_run_failed_jobs"].handler({ runId: 12 });
    expect(mockClient.rerunActionRunFailedJobs).toHaveBeenCalledWith("o", "r", 12);
    expect(result.content[0].text).toContain("Failed jobs rerun started");
  });

  it("list_releases returns JSON of the client result", async () => {
    const { createServer } = await import("../server.js");
    const releases = [{ id: 1, tag_name: "v1.0.0" }];
    mockClient.listReleases.mockResolvedValue(releases);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_releases"].handler({ prerelease: false });
    expect(mockClient.listReleases).toHaveBeenCalledWith(expect.objectContaining({ owner: "o", repo: "r", prerelease: false }));
    expect(JSON.parse(result.content[0].text)).toEqual(releases);
  });

  it("get_release forwards owner/repo/id and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const release = { id: 42, tag_name: "v1.2.0", name: "Title" };
    mockClient.getRelease.mockResolvedValue(release);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["get_release"].handler({ id: 42 });
    expect(mockClient.getRelease).toHaveBeenCalledWith("o", "r", 42);
    expect(JSON.parse(result.content[0].text)).toEqual(release);
  });

  it("get_release_by_tag forwards owner/repo/tag and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const release = { id: 5, tag_name: "v1.0.0" };
    mockClient.getReleaseByTag.mockResolvedValue(release);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["get_release_by_tag"].handler({ tag: "v1.0.0" });
    expect(mockClient.getReleaseByTag).toHaveBeenCalledWith("o", "r", "v1.0.0");
    expect(JSON.parse(result.content[0].text)).toEqual(release);
  });

  it("create_release forwards fields and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const release = { id: 1, tag_name: "v1.0.0" };
    mockClient.createRelease.mockResolvedValue(release);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["create_release"].handler({
      tag_name: "v1.0.0", name: "Title", body: "notes",
    });
    expect(mockClient.createRelease).toHaveBeenCalledWith(expect.objectContaining({
      owner: "o", repo: "r", tag_name: "v1.0.0", name: "Title", body: "notes",
    }));
    expect(JSON.parse(result.content[0].text)).toEqual(release);
  });

  it("update_release forwards fields and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const release = { id: 7, name: "New" };
    mockClient.updateRelease.mockResolvedValue(release);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["update_release"].handler({ id: 7, name: "New" });
    expect(mockClient.updateRelease).toHaveBeenCalledWith(expect.objectContaining({ owner: "o", repo: "r", id: 7, name: "New" }));
    expect(JSON.parse(result.content[0].text)).toEqual(release);
  });

  it("delete_release returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.deleteRelease.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["delete_release"].handler({ id: 3 });
    expect(mockClient.deleteRelease).toHaveBeenCalledWith("o", "r", 3);
    expect(result.content[0].text).toBe("Release #3 deleted.");
  });

  it("update_repo spreads owner/repo into the update params and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const repo = { id: 1, name: "r", description: "new desc" };
    mockClient.updateRepo.mockResolvedValue(repo);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["update_repo"].handler({ description: "new desc" });
    expect(mockClient.updateRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", description: "new desc" }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual(repo);
  });

  it("list_wiki_pages spreads owner/repo and returns JSON of the client result", async () => {
    const { createServer } = await import("../server.js");
    const pages = [{ title: "Home", html_url: "https://g/o/r/wiki/Home" }];
    mockClient.listWikiPages.mockResolvedValue(pages);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_wiki_pages"].handler({ page: 1, limit: 50 });
    expect(mockClient.listWikiPages).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", page: 1, limit: 50 }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual(pages);
  });

  it("get_wiki_page forwards owner/repo/pageName and returns decoded JSON", async () => {
    const { createServer } = await import("../server.js");
    const page = { title: "Home", content: "# Welcome" };
    mockClient.getWikiPage.mockResolvedValue(page);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["get_wiki_page"].handler({ pageName: "Home" });
    expect(mockClient.getWikiPage).toHaveBeenCalledWith("o", "r", "Home");
    expect(JSON.parse(result.content[0].text)).toEqual(page);
  });

  it("create_wiki_page spreads owner/repo into the create params", async () => {
    const { createServer } = await import("../server.js");
    const page = { title: "Getting-Started", content: "# Start" };
    mockClient.createWikiPage.mockResolvedValue(page);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["create_wiki_page"].handler({
      title: "Getting-Started", content: "# Start", message: "add getting started",
    });
    expect(mockClient.createWikiPage).toHaveBeenCalledWith({
      owner: "o", repo: "r", title: "Getting-Started", content: "# Start", message: "add getting started",
    });
    expect(JSON.parse(result.content[0].text)).toEqual(page);
  });

  it("update_wiki_page spreads owner/repo into the update params", async () => {
    const { createServer } = await import("../server.js");
    mockClient.updateWikiPage.mockResolvedValue({ title: "Home", content: "x" });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["update_wiki_page"].handler({ pageName: "Home", content: "x" });
    expect(mockClient.updateWikiPage).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", pageName: "Home", content: "x" }),
    );
  });

  it("delete_wiki_page deletes and returns a confirmation string", async () => {
    const { createServer } = await import("../server.js");
    mockClient.deleteWikiPage.mockResolvedValue(undefined);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["delete_wiki_page"].handler({ pageName: "Home" });
    expect(mockClient.deleteWikiPage).toHaveBeenCalledWith("o", "r", "Home");
    expect(result.content[0].text).toBe("Wiki page 'Home' deleted.");
  });

  it("list_wiki_revisions forwards owner/repo/pageName/page and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const revisions = { commits: [{ sha: "abc", message: "edit" }], count: 1 };
    mockClient.listWikiRevisions.mockResolvedValue(revisions);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_wiki_revisions"].handler({ pageName: "Home", page: 2 });
    expect(mockClient.listWikiRevisions).toHaveBeenCalledWith("o", "r", "Home", 2);
    expect(JSON.parse(result.content[0].text)).toEqual(revisions);
  });

  it("list_issue_dependencies spreads owner/repo and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const deps = [{ number: 9, title: "blocker" }];
    mockClient.listIssueDependencies.mockResolvedValue(deps);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_issue_dependencies"].handler({ index: 7, page: 1, limit: 50 });
    expect(mockClient.listIssueDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", index: 7, page: 1, limit: 50 }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual(deps);
  });

  it("check_issue_blocked delegates to the client and returns the verdict JSON", async () => {
    const { createServer } = await import("../server.js");
    const verdict = {
      index: 42,
      blocked: true,
      blockers: [{ number: 7, title: "blocker", state: "open" }],
      total_dependencies: 1,
      open_blockers: 1,
    };
    mockClient.checkIssueBlocked.mockResolvedValue(verdict);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["check_issue_blocked"].handler({ index: 42 });
    expect(mockClient.checkIssueBlocked).toHaveBeenCalledWith({ owner: "o", repo: "r", index: 42 });
    expect(JSON.parse(result.content[0].text)).toEqual(verdict);
  });

  it("add_issue_dependency maps dep_* fields into the client params", async () => {
    const { createServer } = await import("../server.js");
    const issue = { number: 7, title: "dependent" };
    mockClient.addIssueDependency.mockResolvedValue(issue);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["add_issue_dependency"].handler({
      index: 7, dep_index: 9, dep_owner: "other", dep_repo: "proj",
    });
    expect(mockClient.addIssueDependency).toHaveBeenCalledWith({
      owner: "o", repo: "r", index: 7, depIndex: 9, depOwner: "other", depRepo: "proj",
    });
    expect(JSON.parse(result.content[0].text)).toEqual(issue);
  });

  it("remove_issue_dependency maps dep_* fields and forwards undefined owner/repo", async () => {
    const { createServer } = await import("../server.js");
    const issue = { number: 7, title: "dependent" };
    mockClient.removeIssueDependency.mockResolvedValue(issue);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["remove_issue_dependency"].handler({ index: 7, dep_index: 9 });
    expect(mockClient.removeIssueDependency).toHaveBeenCalledWith({
      owner: "o", repo: "r", index: 7, depIndex: 9, depOwner: undefined, depRepo: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(issue);
  });

  it("list_issue_blocks spreads owner/repo and returns JSON", async () => {
    const { createServer } = await import("../server.js");
    const blocks = [{ number: 9, title: "blocked" }];
    mockClient.listIssueBlocks.mockResolvedValue(blocks);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_issue_blocks"].handler({ index: 7 });
    expect(mockClient.listIssueBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", index: 7 }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual(blocks);
  });

  it("add_issue_block maps dep_* fields into the client params", async () => {
    const { createServer } = await import("../server.js");
    const issue = { number: 7, title: "blocker" };
    mockClient.addIssueBlock.mockResolvedValue(issue);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["add_issue_block"].handler({ index: 7, dep_index: 9 });
    expect(mockClient.addIssueBlock).toHaveBeenCalledWith({
      owner: "o", repo: "r", index: 7, depIndex: 9, depOwner: undefined, depRepo: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(issue);
  });

  it("remove_issue_block maps dep_* fields into the client params", async () => {
    const { createServer } = await import("../server.js");
    const issue = { number: 7, title: "blocker" };
    mockClient.removeIssueBlock.mockResolvedValue(issue);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["remove_issue_block"].handler({
      index: 7, dep_index: 9, dep_owner: "other", dep_repo: "proj",
    });
    expect(mockClient.removeIssueBlock).toHaveBeenCalledWith({
      owner: "o", repo: "r", index: 7, depIndex: 9, depOwner: "other", depRepo: "proj",
    });
    expect(JSON.parse(result.content[0].text)).toEqual(issue);
  });

  it("list_projects returns an empty list", async () => {
    const { createServer } = await import("../server.js");
    mockClient.listProjects.mockResolvedValue([]);
    const server = await createServer("https://g", undefined, "o", "r");
    const result = await registeredTools(server as never)["list_projects"].handler({});
    expect(mockClient.listProjects).toHaveBeenCalledWith({ owner: "o", repo: "r" });
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  it("get_project surfaces not-found via the client", async () => {
    const { createServer } = await import("../server.js");
    mockClient.getProject.mockRejectedValue(new Error("Gitea API error (404): project not found"));
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["get_project"].handler({ id: 42 }),
    ).rejects.toThrow();
    expect(mockClient.getProject).toHaveBeenCalledWith({ owner: "o", repo: "r", id: 42 });
  });
});

describe("resolve_repo handler", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient = {};
    for (const m of CLIENT_METHODS) mockClient[m] = vi.fn();
    vi.mocked(GiteaClient).mockImplementation(function () { return mockClient; } as never);
  });

  it("parses an SSH remote and derives an https baseUrl", async () => {
    vi.mocked(readFile).mockResolvedValue('[remote "origin"]\n\turl = git@gitea.example:owner/repo.git\n');
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g");
    const result = await registeredTools(server as never)["resolve_repo"].handler({ path: "/repo" });
    expect(readFile).toHaveBeenCalledWith("/repo/.git/config", "utf-8");
    expect(JSON.parse(result.content[0].text)).toEqual({
      baseUrl: "https://gitea.example",
      owner: "owner",
      repo: "repo",
      remote: "origin",
      remote_url: "git@gitea.example:owner/repo.git",
      remotes: {
        origin: { baseUrl: "https://gitea.example", owner: "owner", repo: "repo", url: "git@gitea.example:owner/repo.git" },
      },
    });
    restoreReadFile();
  });

  it("parses an HTTPS remote URL without .git suffix", async () => {
    vi.mocked(readFile).mockResolvedValue('[remote "origin"]\n\turl = https://gitea.example/owner/repo\n');
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g");
    const result = await registeredTools(server as never)["resolve_repo"].handler({ path: "/repo" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      baseUrl: "https://gitea.example",
      owner: "owner",
      repo: "repo",
      remote: "origin",
    });
    restoreReadFile();
  });

  it("prefers the upstream remote over origin and surfaces both", async () => {
    vi.mocked(readFile).mockResolvedValue(
      '[remote "origin"]\n\turl = https://gitea.example/origin/repo.git\n[remote "upstream"]\n\turl = https://gitea.example/upstream/repo.git\n',
    );
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g");
    const result = await registeredTools(server as never)["resolve_repo"].handler({ path: "/repo" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.remote).toBe("upstream");
    expect(parsed.owner).toBe("upstream");
    expect(parsed.remote_url).toBe("https://gitea.example/upstream/repo.git");
    expect(Object.keys(parsed.remotes).sort()).toEqual(["origin", "upstream"]);
    restoreReadFile();
  });

  it("throws when no parseable remotes are found", async () => {
    vi.mocked(readFile).mockResolvedValue("");
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g");
    await expect(
      registeredTools(server as never)["resolve_repo"].handler({ path: "/repo" }),
    ).rejects.toThrow("No parseable git remotes found");
    restoreReadFile();
  });

  it("throws when the remote URL cannot be parsed", async () => {
    vi.mocked(readFile).mockResolvedValue('[remote "origin"]\n\turl = not-a-valid-url\n');
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g");
    await expect(
      registeredTools(server as never)["resolve_repo"].handler({ path: "/repo" }),
    ).rejects.toThrow("No parseable git remotes found");
    restoreReadFile();
  });

  it("follows gitdir -> commondir when run inside a git worktree", async () => {
    const files: Record<string, string> = {
      "/wt/.git": "gitdir: /data/repo/.git/worktrees/wt\n",
      "/data/repo/.git/worktrees/wt/commondir": "../..\n",
      "/data/repo/.git/config": '[remote "origin"]\n\turl = git@gitea.example:owner/repo.git\n',
    };
    vi.mocked(readFile).mockImplementation(async (path) => files[String(path)]);
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g");
    const result = await registeredTools(server as never)["resolve_repo"].handler({ path: "/wt" });
    expect(readFile).toHaveBeenCalledWith("/data/repo/.git/config", "utf-8");
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      owner: "owner",
      repo: "repo",
      baseUrl: "https://gitea.example",
    });
    restoreReadFile();
  });
});

describe("configure_gitea tool", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient = {};
    for (const m of CLIENT_METHODS) mockClient[m] = vi.fn();
    vi.mocked(GiteaClient).mockImplementation(function () { return mockClient; } as never);
  });

  it("throws when no fields are provided", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer();
    await expect(
      registeredTools(server as never)["configure_gitea"].handler({}),
    ).rejects.toThrow("At least one of");
  });

  it("sets owner/repo without triggering credential re-discovery", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer();
    mockClient.getBaseUrl.mockReturnValue(null);
    mockClient.getCredentialStatus.mockReturnValue({
      configured: false, baseUrl: null, candidates: [], activeIndex: null, totalCandidates: 0,
    });
    const result = await registeredTools(server as never)["configure_gitea"].handler({
      owner: "myorg",
      repo: "myrepo",
    });
    expect(mockClient.configure).toHaveBeenCalledWith({ baseUrl: undefined, candidates: undefined });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ owner: "myorg", repo: "myrepo" });
  });

  it("triggers credential re-discovery when base_url is provided", async () => {
    const discover = vi.fn().mockResolvedValue([
      { source: "env", secret: "tok", schemes: ["token"], status: "pending", nextSchemeIndex: 0 },
    ]);
    const { createServer } = await import("../server.js");
    const server = await createServer(undefined, undefined, undefined, undefined, { discoverCredentials: discover });
    mockClient.getBaseUrl.mockReturnValue(null);
    mockClient.getCredentialStatus.mockReturnValue({
      configured: true, baseUrl: "https://g.example", candidates: [], activeIndex: null, totalCandidates: 1,
    });
    const result = await registeredTools(server as never)["configure_gitea"].handler({
      base_url: "https://g.example",
    });
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://g.example" }));
    expect(mockClient.configure).toHaveBeenCalledWith({
      baseUrl: "https://g.example",
      candidates: [expect.objectContaining({ secret: "tok" })],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ configured: true, baseUrl: "https://g.example" });
  });

  it("triggers re-discovery when username is provided (refresh idiom)", async () => {
    const discover = vi.fn().mockResolvedValue([]);
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g.example", undefined, "o", "r", { discoverCredentials: discover });
    mockClient.getBaseUrl.mockReturnValue("https://g.example");
    mockClient.getCredentialStatus.mockReturnValue({
      configured: true, baseUrl: "https://g.example", candidates: [], activeIndex: null, totalCandidates: 0,
    });
    await registeredTools(server as never)["configure_gitea"].handler({
      username: "alice",
    });
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://g.example",
      username: "alice",
    }));
  });

  it("errors when re-discovery is triggered but no baseUrl exists", async () => {
    const discover = vi.fn();
    const { createServer } = await import("../server.js");
    const server = await createServer(undefined, undefined, undefined, undefined, { discoverCredentials: discover });
    mockClient.getBaseUrl.mockReturnValue(null);
    await expect(
      registeredTools(server as never)["configure_gitea"].handler({ username: "alice" }),
    ).rejects.toThrow("Cannot trigger credential re-discovery without a base_url");
    expect(discover).not.toHaveBeenCalled();
  });

  it("preserves failure atomicity — discovery throw leaves zero state change", async () => {
    const discover = vi.fn().mockRejectedValue(new Error("fs error"));
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g.example", undefined, "o", "r", { discoverCredentials: discover });
    mockClient.getBaseUrl.mockReturnValue("https://g.example");
    await expect(
      registeredTools(server as never)["configure_gitea"].handler({ base_url: "https://new.example" }),
    ).rejects.toThrow("fs error");
    // configure should NOT have been called
    expect(mockClient.configure).not.toHaveBeenCalled();
  });

  it("does not leak secrets in the tool output", async () => {
    const discover = vi.fn().mockResolvedValue([
      { source: "env", secret: "super-secret-token", schemes: ["token"], status: "pending", nextSchemeIndex: 0 },
    ]);
    const { createServer } = await import("../server.js");
    const server = await createServer(undefined, undefined, undefined, undefined, { discoverCredentials: discover });
    mockClient.getBaseUrl.mockReturnValue(null);
    mockClient.getCredentialStatus.mockReturnValue({
      configured: true,
      baseUrl: "https://g.example",
      candidates: [{ source: "env", schemes: ["token"], username: null, secretPresent: true, status: "pending", lastTriedScheme: null, activeScheme: null, lastError: null }],
      activeIndex: null,
      totalCandidates: 1,
    });
    const result = await registeredTools(server as never)["configure_gitea"].handler({
      base_url: "https://g.example",
    });
    expect(result.content[0].text).not.toContain("super-secret-token");
  });
});

describe("attachment upload confinement (Issue #76)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient = {};
    for (const m of CLIENT_METHODS) mockClient[m] = vi.fn();
    vi.mocked(GiteaClient).mockImplementation(function () { return mockClient; } as never);
    await resetUploadRoot();
  });

  afterEach(async () => {
    if (savedUploadRoot === undefined) delete process.env.GITEA_UPLOAD_ROOT;
    else process.env.GITEA_UPLOAD_ROOT = savedUploadRoot;
    if (uploadRoot) await rm(uploadRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("forwards realpath-resolved basename, not the raw argument", async () => {
    await writeFile(join(uploadRoot, "log.txt"), new Uint8Array([1, 2, 3]));
    // A traversal-heavy alias still resolves inside the root: allowed, and the
    // stored filename is the canonical basename.
    const path = join(uploadRoot, "sub", "..", "log.txt");
    const { createServer } = await import("../server.js");
    mockClient.createIssueAttachment.mockResolvedValue({ id: 5 });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["create_issue_attachment"].handler({
      index: 3,
      file_path: path,
    });
    expect(mockClient.createIssueAttachment).toHaveBeenCalledWith(
      "o", "r", 3,
      { data: expect.any(Uint8Array), name: "log.txt" },
      undefined,
    );
  });

  it("rejects a path that escapes the upload root, without echoing the path", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    // /etc/hostname exists on the test host; the confinement must reject it
    // before any read, and the error must not contain the local path.
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3,
        file_path: "/etc/hostname",
      }),
    ).rejects.toThrow(/escapes the upload root/);
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("rejects .. traversal that resolves outside the root", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3,
        file_path: join(uploadRoot, "..", "..", "etc", "hostname"),
      }),
    ).rejects.toThrow(/escapes the upload root/);
  });

  it("rejects a symlink that escapes the upload root", async () => {
    await symlink("/etc/hostname", join(uploadRoot, "evil.txt"));
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3,
        file_path: join(uploadRoot, "evil.txt"),
      }),
    ).rejects.toThrow(/escapes the upload root/);
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("allows a symlink that stays inside the upload root", async () => {
    await writeFile(join(uploadRoot, "real.md"), new Uint8Array([7]));
    await symlink(join(uploadRoot, "real.md"), join(uploadRoot, "alias.md"));
    const { createServer } = await import("../server.js");
    mockClient.createIssueAttachment.mockResolvedValue({ id: 8 });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["create_issue_attachment"].handler({
      index: 3,
      file_path: join(uploadRoot, "alias.md"),
    });
    expect(mockClient.createIssueAttachment).toHaveBeenCalledWith(
      "o", "r", 3,
      { data: expect.any(Uint8Array), name: "real.md" },
      undefined,
    );
  });

  it("rejects sensitive locations even inside the root (.env*, .git, key material)", async () => {
    await writeFile(join(uploadRoot, ".env"), new Uint8Array([1]));
    await writeFile(join(uploadRoot, ".env.local"), new Uint8Array([1]));
    await mkdir(join(uploadRoot, "repo.git"));
    await writeFile(join(uploadRoot, "repo.git", "config"), new Uint8Array([1]));
    await writeFile(join(uploadRoot, "id_rsa"), new Uint8Array([1]));
    await writeFile(join(uploadRoot, "server.pem"), new Uint8Array([1]));
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    for (const name of [".env", ".env.local", join("repo.git", "config"), "id_rsa", "server.pem"]) {
      await expect(
        registeredTools(server as never)["create_issue_attachment"].handler({
          index: 3,
          file_path: join(uploadRoot, name),
        }),
      ).rejects.toThrow(/sensitive file or location/);
    }
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("rejects extensions outside the allow-list", async () => {
    await writeFile(join(uploadRoot, "payload.exe"), new Uint8Array([1]));
    await writeFile(join(uploadRoot, "noext"), new Uint8Array([1]));
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3, file_path: join(uploadRoot, "payload.exe"),
      }),
    ).rejects.toThrow(/not in the upload allow-list/);
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3, file_path: join(uploadRoot, "noext"),
      }),
    ).rejects.toThrow(/not in the upload allow-list/);
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("rejects files over the size cap before reading bytes", async () => {
    const big = join(uploadRoot, "big.log");
    // Create a sparse file whose stat size exceeds the 50 MiB cap without
    // materializing the bytes: truncate extends the file with a hole.
    const { truncate } = await import("node:fs/promises");
    await writeFile(big, new Uint8Array([0]));
    await truncate(big, 50 * 1024 * 1024 + 1);
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3, file_path: big,
      }),
    ).rejects.toThrow(/over the \d+ byte cap/);
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("returns a path-free generic error for missing files (no existence oracle)", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    const missing = join(uploadRoot, "does-not-exist.txt");
    const err = await registeredTools(server as never)["create_issue_attachment"].handler({
      index: 3, file_path: missing,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(missing);
    expect((err as Error).message).not.toContain("ENOENT");
  });

  it("applies the same confinement to create_issue_comment_attachment", async () => {
    await writeFile(join(uploadRoot, "ok.txt"), new Uint8Array([4]));
    const { createServer } = await import("../server.js");
    mockClient.createIssueCommentAttachment.mockResolvedValue({ id: 9 });
    const server = await createServer("https://g", undefined, "o", "r");
    await registeredTools(server as never)["create_issue_comment_attachment"].handler({
      comment_id: 42,
      file_path: join(uploadRoot, "ok.txt"),
    });
    expect(mockClient.createIssueCommentAttachment).toHaveBeenCalledWith(
      "o", "r", 42,
      { data: expect.any(Uint8Array), name: "ok.txt" },
      undefined,
    );
    // Escape attempt on the comment tool is rejected identically.
    await expect(
      registeredTools(server as never)["create_issue_comment_attachment"].handler({
        comment_id: 42,
        file_path: "/etc/hostname",
      }),
    ).rejects.toThrow(/escapes the upload root/);
  });

  it("rejects a whitespace-only file_path without touching the filesystem", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3, file_path: "  ",
      }),
    ).rejects.toThrow(/empty or whitespace/);
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("falls back to the working directory as the upload root when GITEA_UPLOAD_ROOT is unset", async () => {
    delete process.env.GITEA_UPLOAD_ROOT;
    // /etc/hostname is outside the process working directory too.
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3, file_path: "/etc/hostname",
      }),
    ).rejects.toThrow(/escapes the upload root/);
  });

  it("rejects pseudo-filesystem paths by the deny-list even when inside the root", async () => {
    if (process.platform === "win32") return; // /proc does not exist on Windows
    process.env.GITEA_UPLOAD_ROOT = "/";
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3, file_path: "/proc/version",
      }),
    ).rejects.toThrow(/sensitive file or location/);
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("returns a generic error when GITEA_UPLOAD_ROOT itself does not resolve", async () => {
    process.env.GITEA_UPLOAD_ROOT = join(uploadRoot, "missing-root");
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    // The file argument never gets read: the unresolvable root aborts first,
    // so an existing in-root file is enough (no temp-dir write needed).
    await writeFile(join(uploadRoot, "probe.txt"), new Uint8Array([1]));
    const err = await registeredTools(server as never)["create_issue_attachment"].handler({
      index: 3, file_path: join(uploadRoot, "probe.txt"),
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/GITEA_UPLOAD_ROOT does not resolve/);
    expect((err as Error).message).not.toContain("missing-root");
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("treats the upload root itself as a directory, not an uploadable file", async () => {
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    await expect(
      registeredTools(server as never)["create_issue_attachment"].handler({
        index: 3, file_path: uploadRoot,
      }),
    ).rejects.toThrow(); // realpath(root) === root passes containment, then stat/readFile of a directory fails generically
    expect(mockClient.createIssueAttachment).not.toHaveBeenCalled();
  });

  it("handles an unreadable file with a generic message (no EACCES oracle)", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod is meaningless for root/win32
    const locked = join(uploadRoot, "locked.txt");
    await writeFile(locked, new Uint8Array([1]));
    await chmod(locked, 0o000);
    const { createServer } = await import("../server.js");
    const server = await createServer("https://g", undefined, "o", "r");
    const err = await registeredTools(server as never)["create_issue_attachment"].handler({
      index: 3, file_path: locked,
    }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("EACCES");
    expect((err as Error).message).not.toContain(locked);
    await chmod(locked, 0o644).catch(() => {});
  });
});
