import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GitLabClient,
  GitLabApiError,
  GitLabNotConfiguredError,
  GitLabTierError,
  GitLabUnsupportedError,
} from "../gitlab-client.js";
import type { CandidateCredential } from "../credentials.js";

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function buildResponse(body: unknown, status = 200, statusText = "OK"): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => {
      if (body === undefined) return "";
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function stubFetch(response: FakeResponse) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0];
  return { url: url as string, init: init as RequestInit };
}

function tokenCandidate(secret = "gl-token"): CandidateCredential {
  return { source: "env", secret, schemes: ["bearer"], status: "pending", nextSchemeIndex: 0 };
}

describe("GitLabClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Constructor / configuration ──

  it("normalizes a trailing slash off the baseUrl", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example/", token: "t" });
    await client.listIssues({ owner: "o", repo: "r" });
    expect(lastCall(fetchMock).url).toBe("https://gl.example/api/v4/projects/o%2Fr/issues");
  });

  it("throws GitLabNotConfiguredError before any fetch when unconfigured", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({});
    await expect(client.getIssue("o", "r", 1)).rejects.toThrow(GitLabNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the bearer token in the Authorization header", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "gl-secret" });
    await client.listIssues({ owner: "o", repo: "r" });
    const { init } = lastCall(fetchMock);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer gl-secret");
  });

  it("sends no Authorization header when no candidates exist (anonymous)", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example" });
    await client.listIssues({ owner: "o", repo: "r" });
    expect((lastCall(fetchMock).init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("never puts the token in the URL query string", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "gl-secret" });
    await client.listIssues({ owner: "o", repo: "r" });
    expect(lastCall(fetchMock).url).not.toContain("gl-secret");
    expect(lastCall(fetchMock).url).not.toContain("private_token");
    expect(lastCall(fetchMock).url).not.toContain("access_token");
  });

  it("throws with status and response body on error", async () => {
    stubFetch(buildResponse("not found", 404, "Not Found"));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.getIssue("o", "r", 1)).rejects.toThrow("GitLab API error (404): not found");
  });

  it("returns undefined for 204 responses", async () => {
    stubFetch(buildResponse(undefined, 204, "No Content"));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.deleteIssue("o", "r", 1)).resolves.toBeUndefined();
  });

  it("configure() replaces candidates with a fully reset state machine", async () => {
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "bad" });
    // Burn the initial candidate on a 401.
    stubFetch(buildResponse("401 Unauthorized", 401, "Unauthorized"));
    await expect(client.getIssue("o", "r", 1)).rejects.toThrow(GitLabApiError);
    expect(client.getCredentialStatus().candidates[0].status).toBe("exhausted");

    // configure() resets the state so the new candidate is retried.
    const fetchMock = stubFetch(buildResponse({ iid: 1 }));
    client.configure({ candidates: [tokenCandidate("good")] });
    await client.getIssue("o", "r", 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getCredentialStatus().activeIndex).toBe(0);
  });

  // ── Addressing: projects by URL-encoded path ──

  it("addresses projects by URL-encoded path", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listIssues({ owner: "my-group", repo: "my-project" });
    expect(lastCall(fetchMock).url).toBe(
      "https://gl.example/api/v4/projects/my-group%2Fmy-project/issues",
    );
  });

  // ── Issues ──

  it("list_issues maps state open→opened and forwards labels/pagination", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listIssues({ owner: "o", repo: "r", state: "open", labels: "a,b", page: 2, limit: 50 });
    expect(lastCall(fetchMock).url).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/issues?state=opened&labels=a%2Cb&page=2&per_page=50",
    );
  });

  it("list_issues omits the state filter for state=all", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listIssues({ owner: "o", repo: "r", state: "all" });
    expect(lastCall(fetchMock).url).toBe("https://gl.example/api/v4/projects/o%2Fr/issues");
  });

  it("get_issue addresses the issue by project-scoped iid", async () => {
    const fetchMock = stubFetch(buildResponse({ iid: 5 }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.getIssue("o", "r", 5);
    expect(lastCall(fetchMock).url).toBe("https://gl.example/api/v4/projects/o%2Fr/issues/5");
  });

  it("create_issue posts title/description and resolves milestone", async () => {
    const fetchMock = stubFetch(buildResponse({ iid: 7 }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.createIssue({ owner: "o", repo: "r", title: "T", body: "B", milestone: 3 });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("https://gl.example/api/v4/projects/o%2Fr/issues");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      title: "T",
      description: "B",
      milestone_id: 3,
    });
  });

  it("create_issue resolves label IDs to GitLab label names", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([{ id: 11, name: "bug", color: "#ff0000" }]))
      .mockResolvedValueOnce(buildResponse({ iid: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.createIssue({ owner: "o", repo: "r", title: "T", labels: [11] });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      title: "T",
      labels: "bug",
    });
  });

  it("create_issue resolves assignee usernames through the project members API", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        buildResponse([{ id: 42, username: "alice" }, { id: 43, username: "alicia" }]),
      )
      .mockResolvedValueOnce(buildResponse({ iid: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.createIssue({ owner: "o", repo: "r", title: "T", assignee: "alice" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/members/all?query=alice",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      title: "T",
      assignee_id: 42,
    });
  });

  it("create_issue errors explicitly when an assignee is not a project member", async () => {
    stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(
      client.createIssue({ owner: "o", repo: "r", title: "T", assignee: "nobody" }),
    ).rejects.toThrow("assignee 'nobody' is not a member of project o/r");
  });

  it("create_issue errors explicitly when a label ID is unknown", async () => {
    stubFetch(buildResponse([{ id: 11, name: "bug", color: "#ff0000" }]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(
      client.createIssue({ owner: "o", repo: "r", title: "T", labels: [99] }),
    ).rejects.toThrow("label id 99 not found in project o/r");
  });

  it("update_issue maps state to state_event (closed→close, open→reopen)", async () => {
    const fetchMock = stubFetch(buildResponse({ iid: 5 }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.updateIssue({ owner: "o", repo: "r", index: 5, state: "closed" });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("https://gl.example/api/v4/projects/o%2Fr/issues/5");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ state_event: "close" });
  });

  it("update_issue rejects an empty change set without fetching", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.updateIssue({ owner: "o", repo: "r", index: 5 })).rejects.toThrow(
      "GitLab issue updates require at least one field to change",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delete_issue sends DELETE to the iid-addressed path", async () => {
    const fetchMock = stubFetch(buildResponse(undefined, 204));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.deleteIssue("o", "r", 5);
    const { init } = lastCall(fetchMock);
    expect(init.method).toBe("DELETE");
  });

  it("search_issues queries the global search API with scope=issues", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.searchIssues({ query: "leak", state: "open", page: 1, limit: 20 });
    expect(lastCall(fetchMock).url).toBe(
      "https://gl.example/api/v4/search?scope=issues&search=leak&state=opened&page=1&per_page=20",
    );
  });

  it("search_issues with type=pulls searches merge requests", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.searchIssues({ query: "leak", type: "pulls" });
    expect(lastCall(fetchMock).url).toContain("scope=merge_requests");
  });

  it("search_issues requires a query on GitLab", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.searchIssues({})).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("search_issues rejects the labels filter (no GitLab counterpart)", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.searchIssues({ query: "x", labels: "a" })).rejects.toThrow(
      GitLabUnsupportedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Comments (issue notes) ──

  it("list_comments requests oldest-first ordering (Gitea parity)", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listComments("o", "r", 5);
    expect(lastCall(fetchMock).url).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/issues/5/notes?sort=asc&order_by=created_at",
    );
  });

  it("create_comment posts the note body", async () => {
    const fetchMock = stubFetch(buildResponse({ id: 9 }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.createComment("o", "r", 5, "hello");
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("https://gl.example/api/v4/projects/o%2Fr/issues/5/notes");
    expect(JSON.parse(init.body as string)).toEqual({ body: "hello" });
  });

  it("update_comment / delete_comment have no GitLab counterpart", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.updateComment("o", "r", 9, "x")).rejects.toThrow(GitLabUnsupportedError);
    await expect(client.deleteComment("o", "r", 9)).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Issue attachments (no GitLab counterpart) ──

  it("attachment tools report a typed unsupported error", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    const file = { data: new Uint8Array(new ArrayBuffer(1)), name: "f.txt" };
    await expect(client.createIssueAttachment("o", "r", 1, file)).rejects.toThrow(GitLabUnsupportedError);
    await expect(client.listIssueAttachments("o", "r", 1)).rejects.toThrow(GitLabUnsupportedError);
    await expect(client.getIssueAttachment("o", "r", 1, 2)).rejects.toThrow(GitLabUnsupportedError);
    await expect(client.editIssueAttachment("o", "r", 1, 2, "n")).rejects.toThrow(GitLabUnsupportedError);
    await expect(client.deleteIssueAttachment("o", "r", 1, 2)).rejects.toThrow(GitLabUnsupportedError);
    await expect(client.createIssueCommentAttachment("o", "r", 9, file)).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Labels ──

  it("label CRUD uses /projects/:id/labels and renames via new_name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([]))
      .mockResolvedValueOnce(buildResponse({ id: 1 }))
      .mockResolvedValueOnce(buildResponse({ id: 1, name: "renamed" }))
      .mockResolvedValueOnce(buildResponse(undefined, 204));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listLabels("o", "r", 2, 50);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/labels?page=2&per_page=50",
    );
    await client.createLabel({ owner: "o", repo: "r", name: "l", color: "#ff0000" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/labels");
    await client.updateLabel({ owner: "o", repo: "r", id: 1, name: "renamed", description: "d" });
    expect(fetchMock.mock.calls[2][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/labels/1");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({
      new_name: "renamed",
      description: "d",
    });
    await client.deleteLabel("o", "r", 1);
    expect(fetchMock.mock.calls[3][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/labels/1");
  });

  it("update_label requires a name or color on GitLab", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(
      client.updateLabel({ owner: "o", repo: "r", id: 1, description: "only" }),
    ).rejects.toThrow("GitLab label updates require at least a new name or a color");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("add_issue_labels issues add_labels with the new names only", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ iid: 5, labels: ["a"] }))
      .mockResolvedValueOnce(buildResponse({ iid: 5, labels: ["a", "b"] }))
      .mockResolvedValueOnce(buildResponse({ iid: 5, labels: ["a", "b"] }))
      .mockResolvedValueOnce(
        buildResponse([
          { id: 1, name: "a", color: "#111111" },
          { id: 2, name: "b", color: "#222222" },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    const result = await client.addIssueLabels("o", "r", 5, ["a", "b"]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ add_labels: "b" });
    expect(result).toEqual([
      { id: 1, name: "a", color: "#111111" },
      { id: 2, name: "b", color: "#222222" },
    ]);
  });

  it("add_issue_labels skips the write when nothing is new", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ iid: 5, labels: ["a"] }))
      .mockResolvedValueOnce(buildResponse({ iid: 5, labels: ["a"] }))
      .mockResolvedValueOnce(buildResponse([{ id: 1, name: "a", color: "#111111" }]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    const result = await client.addIssueLabels("o", "r", 5, ["a"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual([{ id: 1, name: "a", color: "#111111" }]);
  });

  it("remove_issue_label translates the label ID to a name-based removal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([{ id: 7, name: "bug", color: "#ff0000" }]))
      .mockResolvedValueOnce(buildResponse({ iid: 5, labels: ["bug", "x"] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.removeIssueLabel("o", "r", 5, 7);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ remove_labels: "bug" });
  });

  it("replace_issue_labels writes the full comma-separated set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ iid: 5, labels: ["x"] }))
      .mockResolvedValueOnce(buildResponse({ iid: 5, labels: ["x", "y"] }))
      .mockResolvedValueOnce(buildResponse([
        { id: 1, name: "x", color: "#111111" },
        { id: 2, name: "y", color: "#222222" },
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    const result = await client.replaceIssueLabels("o", "r", 5, ["x", "y"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ labels: "x,y" });
    expect(result).toHaveLength(2);
  });

  it("clear_issue_labels writes an empty labels string", async () => {
    const fetchMock = stubFetch(buildResponse(undefined, 204));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.clearIssueLabels("o", "r", 5);
    expect(JSON.parse(lastCall(fetchMock).init.body as string)).toEqual({ labels: "" });
  });

  // ── Milestones ──

  it("milestones are addressed by milestone_id and map open→active", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([]))
      .mockResolvedValueOnce(buildResponse({ id: 12 }))
      .mockResolvedValueOnce(buildResponse({ id: 13 }))
      .mockResolvedValueOnce(buildResponse({ id: 12 }))
      .mockResolvedValueOnce(buildResponse(undefined, 204));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });

    await client.listMilestones("o", "r", "open", 1, 20);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/milestones?state=active&page=1&per_page=20",
    );

    await client.getMilestone("o", "r", 12);
    expect(fetchMock.mock.calls[1][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/milestones/12");

    await client.createMilestone({ owner: "o", repo: "r", title: "v1", due_on: "2026-03-11T03:45:40Z" });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({
      title: "v1",
      due_date: "2026-03-11",
    });

    await client.updateMilestone({ owner: "o", repo: "r", id: 12, state: "open" });
    expect(fetchMock.mock.calls[3][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/milestones/12");
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({ state_event: "activate" });

    await client.deleteMilestone("o", "r", 12);
    expect(fetchMock.mock.calls[4][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/milestones/12");
  });

  it("update_milestone rejects an empty change set", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.updateMilestone({ owner: "o", repo: "r", id: 1 })).rejects.toThrow(
      "GitLab milestone updates require at least one field to change",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Topics ──

  it("topics read/modify/write the project attribute", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ id: 1, topics: ["t1"] })) // listTopics read
      .mockResolvedValueOnce(buildResponse({ id: 1, topics: ["t2", "t1"] })) // replaceTopics write
      .mockResolvedValueOnce(buildResponse({ id: 1, topics: ["t1"] })) // addTopic read
      .mockResolvedValueOnce(buildResponse({ id: 1, topics: ["t2", "t1"] })) // addTopic write
      .mockResolvedValueOnce(buildResponse({ id: 1, topics: ["t2", "t1"] })) // removeTopic read
      .mockResolvedValueOnce(buildResponse({ id: 1, topics: ["t1"] })) // removeTopic write
      .mockResolvedValueOnce(buildResponse({ id: 1, topics: ["t1"] })) // absent-topic read
      .mockResolvedValueOnce(buildResponse({ id: 1, topics: ["t1"] })); // absent-topic write
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });

    await expect(client.listTopics({ owner: "o", repo: "r" })).resolves.toEqual({ topics: ["t1"] });
    expect(fetchMock.mock.calls[0][0]).toBe("https://gl.example/api/v4/projects/o%2Fr");

    await expect(client.replaceTopics({ owner: "o", repo: "r", topics: ["t2", "t1"] })).resolves.toEqual({
      topics: ["t2", "t1"],
    });

    await client.addTopic("o", "r", "t2");
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({ topics: ["t1", "t2"] });

    await client.removeTopic("o", "r", "t2");
    expect(JSON.parse(fetchMock.mock.calls[5][1].body as string)).toEqual({ topics: ["t1"] });

    // Removing an absent topic rewrites the unchanged set (idempotent write).
    await client.removeTopic("o", "r", "missing");
    expect(JSON.parse(fetchMock.mock.calls[7][1].body as string)).toEqual({ topics: ["t1"] });
  });

  it("add_topic is a no-op when the topic already exists", async () => {
    const fetchMock = stubFetch(buildResponse({ id: 1, topics: ["t1"] }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.addTopic("o", "r", "t1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Repository ──

  it("update_repo maps name/description/default_branch onto PUT /projects/:id", async () => {
    const fetchMock = stubFetch(buildResponse({ id: 1 }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.updateRepo({ owner: "o", repo: "r", description: "d", default_branch: "main" });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("https://gl.example/api/v4/projects/o%2Fr");
    expect(JSON.parse(init.body as string)).toEqual({ description: "d", default_branch: "main" });
  });

  it("update_repo rejects website/private (no GitLab boolean/tri-state mapping)", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.updateRepo({ owner: "o", repo: "r", website: "https://x" })).rejects.toThrow(
      GitLabUnsupportedError,
    );
    await expect(client.updateRepo({ owner: "o", repo: "r", private: true })).rejects.toThrow(
      GitLabUnsupportedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("list_my_repos lists accessible projects", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listMyRepos(1, 20);
    expect(lastCall(fetchMock).url).toBe("https://gl.example/api/v4/projects?page=1&per_page=20");
  });

  // ── Merge requests ──

  it("merge requests are addressed by iid and sort maps to order_by/sort", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listPullRequests({ owner: "o", repo: "r", state: "open", sort: "oldest", labels: "a" });
    expect(lastCall(fetchMock).url).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/merge_requests?state=opened&labels=a&order_by=created_at&sort=asc",
    );
  });

  it("list_pull_requests rejects sort values GitLab cannot order by", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(
      client.listPullRequests({ owner: "o", repo: "r", sort: "mostcomment" }),
    ).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("list_pull_requests rejects the milestone filter (title-based on GitLab)", async () => {
    const fetchMock = stubFetch(buildResponse([]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(
      client.listPullRequests({ owner: "o", repo: "r", milestone: 3 }),
    ).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("create_pull_request maps head/base onto source_branch/target_branch", async () => {
    const fetchMock = stubFetch(buildResponse({ iid: 9 }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.createPullRequest({ owner: "o", repo: "r", title: "T", head: "f", base: "main" });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("https://gl.example/api/v4/projects/o%2Fr/merge_requests");
    expect(JSON.parse(init.body as string)).toEqual({
      source_branch: "f",
      target_branch: "main",
      title: "T",
    });
  });

  it("merge_pull_request PUTs the merge endpoint (squash for Do=squash, sha pass-through)", async () => {
    const fetchMock = stubFetch(buildResponse({ iid: 9, state: "merged" }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.mergePullRequest({
      owner: "o",
      repo: "r",
      index: 9,
      Do: "squash",
      MergeMessageField: "msg",
      SHA: "abc",
    });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("https://gl.example/api/v4/projects/o%2Fr/merge_requests/9/merge");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      squash: true,
      merge_commit_message: "msg",
      squash_commit_message: "msg",
      sha: "abc",
    });
  });

  it("merge_pull_request rejects rebase strategies (no atomic rebase+merge on GitLab)", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(
      client.mergePullRequest({ owner: "o", repo: "r", index: 9, Do: "rebase" }),
    ).rejects.toThrow(GitLabUnsupportedError);
    await expect(
      client.mergePullRequest({ owner: "o", repo: "r", index: 9, Do: "rebase-merge" }),
    ).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is_pull_merged reflects GitLab state === merged", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ iid: 9, state: "merged" }))
      .mockResolvedValueOnce(buildResponse({ iid: 9, state: "opened" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.isPullMerged("o", "r", 9)).resolves.toBe(true);
    await expect(client.isPullMerged("o", "r", 9)).resolves.toBe(false);
  });

  it("MR commits and diffs use the iid-addressed endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([]))
      .mockResolvedValueOnce(buildResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listPullCommits("o", "r", 9, 1, 20);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/merge_requests/9/commits?page=1&per_page=20",
    );
    await client.listPullFiles("o", "r", 9);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/merge_requests/9/diffs",
    );
  });

  // ── Pipelines (Actions group) ──

  it("list_action_runs lists pipelines (plural) and wraps the response", async () => {
    const fetchMock = stubFetch(buildResponse([{ id: 1, status: "success" }, { id: 2, status: "failed" }]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    const result = await client.listActionRuns({
      owner: "o",
      repo: "r",
      branch: "main",
      actor: "alice",
      head_sha: "abc",
      page: 1,
      limit: 20,
    });
    expect(lastCall(fetchMock).url).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/pipelines?ref=main&username=alice&sha=abc&page=1&per_page=20",
    );
    expect(result.workflow_runs).toHaveLength(2);
    expect(result.count).toBe(2);
  });

  it("pipeline create/retry/cancel use their documented endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ id: 5 }))
      .mockResolvedValueOnce(buildResponse({ id: 5, status: "running" }))
      .mockResolvedValueOnce(buildResponse({ id: 5, status: "canceled" }))
      .mockResolvedValueOnce(buildResponse({ id: 5, status: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });

    await client.getActionRun("o", "r", 5);
    expect(fetchMock.mock.calls[0][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/pipelines/5");

    await client.cancelActionRun("o", "r", 5);
    expect(fetchMock.mock.calls[1][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/pipelines/5/cancel");
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");

    await client.rerunActionRun("o", "r", 5);
    expect(fetchMock.mock.calls[2][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/pipelines/5/retry");
  });

  it("rerun_action_run_failed_jobs has no GitLab counterpart", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.rerunActionRunFailedJobs("o", "r", 5)).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Releases (tag_name addressing) ──

  it("releases are addressed by URL-encoded tag_name", async () => {
    const fetchMock = stubFetch(buildResponse({ tag_name: "v1.0" }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.getReleaseByTag("o", "r", "v1.0");
    expect(lastCall(fetchMock).url).toBe("https://gl.example/api/v4/projects/o%2Fr/releases/v1.0");
  });

  it("id-addressed release tools have no GitLab counterpart", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.getRelease("o", "r", 1)).rejects.toThrow(GitLabUnsupportedError);
    await expect(
      client.updateRelease({ owner: "o", repo: "r", id: 1, name: "n" }),
    ).rejects.toThrow(GitLabUnsupportedError);
    await expect(client.deleteRelease("o", "r", 1)).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("list_releases rejects draft/prerelease filters; create maps ref", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([]))
      .mockResolvedValueOnce(buildResponse({ tag_name: "v2" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    // The rejected filter throws before any fetch, so the create call is fetch #1.
    await expect(client.listReleases({ owner: "o", repo: "r", draft: true })).rejects.toThrow(
      GitLabUnsupportedError,
    );
    await client.createRelease({
      owner: "o",
      repo: "r",
      tag_name: "v2",
      body: "notes",
      target_commitish: "main",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      tag_name: "v2",
      description: "notes",
      ref: "main",
    });
    await expect(
      client.createRelease({ owner: "o", repo: "r", tag_name: "v3", draft: true }),
    ).rejects.toThrow(GitLabUnsupportedError);
  });

  // ── Wiki (slug addressing) ──

  it("wiki pages are addressed by URL-encoded slug", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([]))
      .mockResolvedValueOnce(buildResponse({ slug: "dir/page", content: "# hi" }))
      .mockResolvedValueOnce(buildResponse(undefined, 204));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });

    await client.listWikiPages({ owner: "o", repo: "r" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/wikis");

    await client.getWikiPage("o", "r", "dir/page");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/wikis/dir%2Fpage",
    );

    await client.deleteWikiPage("o", "r", "dir/page");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/wikis/dir%2Fpage",
    );
  });

  it("wiki create/update send plain content; message is unsupported", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ slug: "Home" }))
      .mockResolvedValueOnce(buildResponse({ slug: "Home" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });

    await client.createWikiPage({ owner: "o", repo: "r", title: "Home", content: "# hi" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/wikis");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      title: "Home",
      content: "# hi",
    });

    await client.updateWikiPage({ owner: "o", repo: "r", pageName: "Home", content: "# bye" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/wikis/Home");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ content: "# bye" });

    await expect(
      client.createWikiPage({ owner: "o", repo: "r", title: "H", content: "c", message: "m" }),
    ).rejects.toThrow(GitLabUnsupportedError);
    await expect(
      client.updateWikiPage({ owner: "o", repo: "r", pageName: "H" }),
    ).rejects.toThrow("GitLab wiki updates require at least a new title or new content");
  });

  it("list_wiki_revisions has no GitLab counterpart", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.listWikiRevisions("o", "r", "Home")).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Projects placeholder (parity with the Gitea client) ──

  it("projects stay placeholders: list returns [] and get reports 404 semantics", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.listProjects({ owner: "o", repo: "r" })).resolves.toEqual([]);
    await expect(client.getProject({ owner: "o", repo: "r", id: 1 })).rejects.toThrow(GitLabApiError);
    await expect(client.getProject({ owner: "o", repo: "r", id: 1 })).rejects.toThrow(
      "GitLab API error (404)",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Issue dependencies / blocks (tier-gated issue links) ──

  it("list_issue_dependencies filters is_blocked_by links; blocks filters blocks", async () => {
    const fetchMock = stubFetch(
      buildResponse([
        { issue_link_id: 1, link_type: "is_blocked_by", iid: 2, project_id: 1, state: "opened" },
        { issue_link_id: 2, link_type: "blocks", iid: 3, project_id: 1, state: "opened" },
        { issue_link_id: 3, link_type: "relates_to", iid: 4, project_id: 1, state: "opened" },
      ]),
    );
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    const deps = await client.listIssueDependencies({ owner: "o", repo: "r", index: 5 });
    expect(deps).toHaveLength(1);
    expect((deps[0] as unknown as { iid?: number }).iid).toBe(2);
    const blocks = await client.listIssueBlocks({ owner: "o", repo: "r", index: 5 });
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as unknown as { iid?: number }).iid).toBe(3);
    expect(lastCall(fetchMock).url).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/issues/5/links",
    );
  });

  it("add_issue_dependency posts link_type is_blocked_by then returns the source issue", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ issue_link_id: 1 }))
      .mockResolvedValueOnce(buildResponse({ iid: 5, state: "opened" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    const issue = await client.addIssueDependency({ owner: "o", repo: "r", index: 5, depIndex: 7 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/issues/5/links",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      target_project_id: "o%2Fr",
      target_issue_iid: 7,
      link_type: "is_blocked_by",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://gl.example/api/v4/projects/o%2Fr/issues/5");
    expect((issue as unknown as { iid?: number }).iid).toBe(5);
  });

  it("add_issue_block posts link_type blocks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ issue_link_id: 1 }))
      .mockResolvedValueOnce(buildResponse({ iid: 9, state: "opened" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.addIssueBlock({ owner: "o", repo: "r", index: 9, depIndex: 3 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      target_project_id: "o%2Fr",
      target_issue_iid: 3,
      link_type: "blocks",
    });
  });

  it("remove_issue_dependency resolves the link ID then deletes it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        buildResponse([
          { issue_link_id: 11, link_type: "is_blocked_by", iid: 7, project_id: 1 },
          { issue_link_id: 12, link_type: "blocks", iid: 8, project_id: 1 },
        ]),
      )
      .mockResolvedValueOnce(buildResponse(undefined, 204))
      .mockResolvedValueOnce(buildResponse({ iid: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.removeIssueDependency({ owner: "o", repo: "r", index: 5, depIndex: 7 });
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/issues/5/links/11",
    );
  });

  it("remove_issue_dependency matches cross-project targets by resolved project ID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        buildResponse([{ issue_link_id: 21, link_type: "is_blocked_by", iid: 7, project_id: 77 }]),
      )
      .mockResolvedValueOnce(buildResponse({ id: 77 })) // dep project lookup
      .mockResolvedValueOnce(buildResponse(undefined, 204))
      .mockResolvedValueOnce(buildResponse({ iid: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.removeIssueDependency({
      owner: "o",
      repo: "r",
      index: 5,
      depIndex: 7,
      depOwner: "other",
      depRepo: "proj",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/issues/5/links",
    );
    expect(fetchMock.mock.calls[1][0]).toBe("https://gl.example/api/v4/projects/other%2Fproj");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/issues/5/links/21",
    );
  });

  it("remove_* errors 404 when no matching link exists", async () => {
    const fetchMock = stubFetch(
      buildResponse([{ issue_link_id: 12, link_type: "blocks", iid: 8, project_id: 1 }]),
    );
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(
      client.removeIssueDependency({ owner: "o", repo: "r", index: 5, depIndex: 7 }),
    ).rejects.toThrow("no 'is_blocked_by' link to issue #7");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("check_issue_blocked computes the structured verdict from links", async () => {
    stubFetch(
      buildResponse([
        { issue_link_id: 1, link_type: "is_blocked_by", iid: 2, project_id: 1, state: "opened" },
        { issue_link_id: 2, link_type: "is_blocked_by", iid: 3, project_id: 1, state: "closed" },
        { issue_link_id: 3, link_type: "blocks", iid: 4, project_id: 1, state: "opened" },
      ]),
    );
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    const result = await client.checkIssueBlocked({ owner: "o", repo: "r", index: 5 });
    expect(result).toEqual({
      index: 5,
      blocked: true,
      blockers: [{ issue_link_id: 1, link_type: "is_blocked_by", iid: 2, project_id: 1, state: "opened" }],
      total_dependencies: 2,
      open_blockers: 1,
    });
  });

  it("check_issue_blocked stops paginating after a short page", async () => {
    const fetchMock = stubFetch(
      buildResponse([
        { issue_link_id: 1, link_type: "is_blocked_by", iid: 2, project_id: 1, state: "opened" },
      ]),
    );
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.checkIssueBlocked({ owner: "o", repo: "r", index: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][0] as string)).toContain("page=1&per_page=100");
  });

  // ── Tier gating ──

  it("a 403 on issue links becomes GitLabTierError once a credential is active", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ iid: 5 })) // getIssue → activates the candidate
      .mockResolvedValueOnce(buildResponse("403 Forbidden", 403, "Forbidden"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.getIssue("o", "r", 5);
    await expect(client.listIssueDependencies({ owner: "o", repo: "r", index: 5 })).rejects.toThrow(
      GitLabTierError,
    );
    // The active candidate was NOT burned by the tier failure.
    expect(client.getCredentialStatus().activeIndex).toBe(0);
  });

  it("without an active credential a 403 stays an auth error (retry semantics)", async () => {
    stubFetch(buildResponse("403 Forbidden", 403, "Forbidden"));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.listIssueDependencies({ owner: "o", repo: "r", index: 5 })).rejects.toThrow(
      GitLabApiError,
    );
    expect(client.getCredentialStatus().candidates[0].status).toBe("exhausted");
  });

  it("exhausted credentials re-throw the last GitLabApiError", async () => {
    stubFetch(buildResponse("401 Unauthorized", 401, "Unauthorized"));
    const client = new GitLabClient({ baseUrl: "https://gl.example", candidates: [tokenCandidate()] });
    await expect(client.getIssue("o", "r", 1)).rejects.toThrow("GitLab API error (401): 401 Unauthorized");
    expect(client.getCredentialStatus().activeIndex).toBeNull();
  });

  it("an active candidate is reused without re-probing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ iid: 1 }))
      .mockResolvedValueOnce(buildResponse({ iid: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.getIssue("o", "r", 1);
    await client.getIssue("o", "r", 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1];
    expect((second[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer t" });
  });

  // ── Coverage completion: branches not exercised by the groups above ──

  it("configure({ baseUrl }) re-normalizes the base URL; isConfigured/getBaseUrl report it", async () => {
    const client = new GitLabClient({});
    expect(client.isConfigured()).toBe(false);
    expect(client.getBaseUrl()).toBeNull();
    client.configure({ baseUrl: "https://gl.example/" });
    expect(client.isConfigured()).toBe(true);
    expect(client.getBaseUrl()).toBe("https://gl.example");
  });

  it("parses an empty 200 body as undefined", async () => {
    stubFetch(buildResponse("", 200, "OK"));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.getIssue("o", "r", 1)).resolves.toBeUndefined();
  });

  it("throws the zero-status error when candidates were exhausted before any attempt", async () => {
    stubFetch(buildResponse({}));
    const client = new GitLabClient({
      baseUrl: "https://gl.example",
      candidates: [
        { source: "env", secret: "t", schemes: ["bearer"], status: "exhausted", nextSchemeIndex: 1 },
      ],
    });
    await expect(client.getIssue("o", "r", 1)).rejects.toThrow(
      "all credential candidates exhausted",
    );
  });

  it("create_issue resolves an assignees array to assignee_ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([{ id: 42, username: "alice" }]))
      .mockResolvedValueOnce(buildResponse([{ id: 43, username: "bob" }]))
      .mockResolvedValueOnce(buildResponse({ iid: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.createIssue({ owner: "o", repo: "r", title: "T", assignees: ["alice", "bob"] });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({
      title: "T",
      assignee_ids: [42, 43],
    });
  });

  it("update_issue resolves label IDs to names", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([{ id: 11, name: "bug", color: "#ff0000" }]))
      .mockResolvedValueOnce(buildResponse({ iid: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.updateIssue({ owner: "o", repo: "r", index: 5, labels: [11] });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ labels: "bug" });
  });

  it("remove_issue_block resolves the blocks link ID then deletes it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        buildResponse([
          { issue_link_id: 31, link_type: "is_blocked_by", iid: 7, project_id: 1 },
          { issue_link_id: 32, link_type: "blocks", iid: 8, project_id: 1 },
        ]),
      )
      .mockResolvedValueOnce(buildResponse(undefined, 204))
      .mockResolvedValueOnce(buildResponse({ iid: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.removeIssueBlock({ owner: "o", repo: "r", index: 5, depIndex: 8 });
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/issues/5/links/32",
    );
  });

  it("remove_issue_label errors 404 when the label ID is unknown", async () => {
    stubFetch(buildResponse([{ id: 7, name: "bug", color: "#ff0000" }]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.removeIssueLabel("o", "r", 5, 99)).rejects.toThrow(
      "label id 99 not found in project o/r",
    );
  });

  it("list_pull_requests maps recentupdate/leastupdate and tolerates no sort", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([]))
      .mockResolvedValueOnce(buildResponse([]))
      .mockResolvedValueOnce(buildResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });

    await client.listPullRequests({ owner: "o", repo: "r", sort: "recentupdate" });
    expect(fetchMock.mock.calls[0][0]).toContain("order_by=updated_at&sort=desc");

    await client.listPullRequests({ owner: "o", repo: "r", sort: "leastupdate" });
    expect(fetchMock.mock.calls[1][0]).toContain("order_by=updated_at&sort=asc");

    await client.listPullRequests({ owner: "o", repo: "r" });
    expect(fetchMock.mock.calls[2][0]).not.toContain("order_by=");
  });

  it("create_pull_request resolves label IDs to names", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([{ id: 11, name: "bug", color: "#ff0000" }]))
      .mockResolvedValueOnce(buildResponse({ iid: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.createPullRequest({
      owner: "o",
      repo: "r",
      title: "T",
      head: "f",
      base: "main",
      labels: [11],
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({ labels: "bug" });
  });

  it("update_pull_request maps fields and rejects an empty change set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse([{ id: 11, name: "bug", color: "#ff0000" }]))
      .mockResolvedValueOnce(buildResponse({ iid: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.updatePullRequest({
      owner: "o",
      repo: "r",
      index: 9,
      state: "open",
      labels: [11],
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/merge_requests/9",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({
      state_event: "reopen",
      labels: "bug",
    });
    await expect(
      client.updatePullRequest({ owner: "o", repo: "r", index: 9 }),
    ).rejects.toThrow("GitLab merge request updates require at least one field to change");
  });

  it("list_releases lists releases with pagination", async () => {
    const fetchMock = stubFetch(buildResponse([{ tag_name: "v1" }]));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await client.listReleases({ owner: "o", repo: "r", page: 1, limit: 20 });
    expect(lastCall(fetchMock).url).toBe(
      "https://gl.example/api/v4/projects/o%2Fr/releases?page=1&per_page=20",
    );
  });

  it("getRepo fetches the project", async () => {
    stubFetch(buildResponse({ id: 1 }));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(client.getRepo("o", "r")).resolves.toMatchObject({ id: 1 });
  });

  it("update_wiki_page rejects the message parameter", async () => {
    const fetchMock = stubFetch(buildResponse({}));
    const client = new GitLabClient({ baseUrl: "https://gl.example", token: "t" });
    await expect(
      client.updateWikiPage({ owner: "o", repo: "r", pageName: "Home", content: "c", message: "m" }),
    ).rejects.toThrow(GitLabUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
