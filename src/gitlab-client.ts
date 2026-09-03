/**
 * GitLabClient — REST client wrapping the GitLab API v4 (`/api/v4`),
 * parallel to `GiteaClient` (issue #84).
 *
 * Design contract:
 * - Same public method surface as `GiteaClient` (identical names, parameter
 *   lists, and declared return types) so `server.ts` can hold either client
 *   behind one union type. Response bodies are passed through in GitLab's
 *   native JSON shape — handlers serialize whole responses — while the
 *   declared types carry the shared tool contract; field-level differences
 *   (GitLab `iid`/`web_url` vs Gitea `number`/`html_url`) are documented in
 *   the README instead of being silently rewritten.
 * - Per-resource addressing follows the GitLab REST API v4 rules: projects
 *   are addressed by URL-encoded path (`owner%2Frepo`), issues and merge
 *   requests by project-scoped `iid`, milestones and pipelines by ID,
 *   releases by `tag_name`, and wiki pages by URL-encoded `slug`.
 * - Reuses the platform-independent candidate state machine from
 *   `credentials.ts` (pick/mark/summarize), with GitLab candidates carrying
 *   the documented `bearer` scheme (`Authorization: Bearer <token>`).
 * - Tier-gated operations (issue blocking/dependency link types require
 *   GitLab Premium/Ultimate) fail through `requestTierGated`: a runtime 403
 *   on such an endpoint while a credential is already active becomes a typed
 *   `GitLabTierError` — never a raw API error, and never an auth retry that
 *   would burn a working candidate.
 * - Operations without any GitLab REST API v4 counterpart fail with a typed
 *   `GitLabUnsupportedError` instead of a raw API error.
 *
 * SECURITY (AGENTS.md §4): the secret is confined to `CandidateCredential`
 * and rides only inside the `Authorization` header — never in a query string
 * (`?private_token=` is forbidden), never logged, never interpolated into
 * error messages. Diagnostics go through `getCredentialStatus()` →
 * `summarizeCandidates` (redacted).
 */

import {
  type CandidateCredential,
  type CandidateSummary,
  buildAuthHeader,
  pickNextAttempt,
  markAttemptFailed,
  markAttemptSucceeded,
  findActiveCandidateIndex,
  summarizeCandidates,
} from "./credentials.js";
import type {
  ActionWorkflowRun,
  ActionWorkflowRunsResponse,
  Attachment,
  CheckIssueBlockedParams,
  Comment,
  CreateIssueParams,
  CreateLabelParams,
  CreateMilestoneParams,
  CreatePullRequestParams,
  CreateReleaseParams,
  CreateWikiPageParams,
  GetProjectParams,
  Issue,
  IssueBlockedResult,
  IssueDependencyTargetParams,
  Label,
  ListActionRunsParams,
  ListIssueDependenciesParams,
  ListIssuesParams,
  ListPullRequestsParams,
  ListProjectsParams,
  ListReleasesParams,
  ListTopicsParams,
  ListWikiPagesParams,
  MergePullRequestParams,
  Milestone,
  Project,
  PullCommit,
  PullFile,
  PullRequest,
  Release,
  ReplaceTopicsParams,
  Repo,
  RequestBody,
  SearchIssuesParams,
  TopicList,
  UpdateIssueParams,
  UpdateLabelParams,
  UpdateMilestoneParams,
  UpdatePullRequestParams,
  UpdateReleaseParams,
  UpdateRepoParams,
  UpdateWikiPageParams,
  WikiPage,
  WikiPageMeta,
  WikiRevisionList,
} from "./gitea-client.js";

/**
 * Thrown before any fetch when no baseUrl is configured — the GitLab-worded
 * counterpart of `NotConfiguredError` (whose message names the Gitea tool).
 */
export class GitLabNotConfiguredError extends Error {
  constructor() {
    super(
      "GitLab connection is not configured. Use the configure_gitlab tool to set base_url/owner/repo/username, or set GITLAB_BASE_URL / GITLAB_TOKEN and restart.",
    );
    this.name = "GitLabNotConfiguredError";
  }
}

/**
 * GitLab API failure with typed `status`/`body` so callers can branch on
 * `err.status` without substring-matching the message (AGENTS.md §2.3).
 */
export class GitLabApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`GitLab API error (${status}): ${body || statusText}`);
    this.name = "GitLabApiError";
  }
}

/**
 * The operation requires GitLab Premium/Ultimate and the instance rejected
 * it — the blocking issue link types (`blocks`, `is_blocked_by`) are not
 * available on GitLab Free.
 */
export class GitLabTierError extends Error {
  constructor(operation: string) {
    super(
      `${operation} requires GitLab Premium or Ultimate (tier-gated): the issue blocking/dependency link types (blocks, is_blocked_by) are not available on GitLab Free, and this instance rejected the operation.`,
    );
    this.name = "GitLabTierError";
  }
}

/** The operation has no GitLab REST API v4 counterpart. */
export class GitLabUnsupportedError extends Error {
  constructor(operation: string, reason: string) {
    super(`${operation} is not supported on GitLab: ${reason}`);
    this.name = "GitLabUnsupportedError";
  }
}

export interface GitLabConfig {
  baseUrl?: string;
  token?: string;
  candidates?: CandidateCredential[];
}

/** GitLab member record (subset) — used for username → ID resolution. */
interface GitLabMember {
  id: number;
  username: string;
}

/** GitLab project record (subset) — topics/default_branch/name/description. */
interface GitLabProject {
  id: number;
  name?: string;
  description?: string;
  default_branch?: string;
  topics?: string[];
}

/** GitLab issue-link record — the linked issue plus the relationship fields. */
interface GitLabIssueLink {
  issue_link_id?: number;
  link_type?: string;
  iid?: number;
  project_id?: number;
  state?: string;
}

/**
 * Upper bound for the client-side pagination loop in `checkIssueBlocked` —
 * the loop MUST terminate even if the server keeps returning full pages.
 */
const MAX_LINK_PAGES = 100;

export class GitLabClient {
  private baseUrl: string | null;
  private candidates: CandidateCredential[];

  constructor(config: GitLabConfig = {}) {
    this.baseUrl = config.baseUrl ? GitLabClient.normalizeBaseUrl(config.baseUrl) : null;
    this.candidates = GitLabClient.initCandidates(config);
  }

  // ── Connection management ──

  /**
   * Atomically replace the connection state. Candidates are defensive-copied
   * and their state machine fully reset (back to `pending`) so an old host's
   * active candidate can never send its old token to a new host.
   */
  configure(params: { baseUrl?: string; candidates?: CandidateCredential[] }): void {
    if (params.baseUrl !== undefined) {
      this.baseUrl = GitLabClient.normalizeBaseUrl(params.baseUrl);
    }
    if (params.candidates !== undefined) {
      this.candidates = params.candidates.map((c) => ({
        ...c,
        status: "pending" as const,
        nextSchemeIndex: 0,
        activeScheme: undefined,
        lastError: undefined,
        lastTriedScheme: undefined,
      }));
    }
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  getBaseUrl(): string | null {
    return this.baseUrl;
  }

  /**
   * Snapshot of the credential state machine — for the `gitlab_status` tool.
   * Secrets are never included; only `secretPresent: boolean` and a masked
   * `username`. See `summarizeCandidates` in `credentials.ts`.
   */
  getCredentialStatus(): {
    configured: boolean;
    baseUrl: string | null;
    candidates: CandidateSummary[];
    activeIndex: number | null;
    totalCandidates: number;
  } {
    return {
      configured: this.baseUrl !== null,
      baseUrl: this.baseUrl,
      candidates: summarizeCandidates(this.candidates),
      activeIndex: findActiveCandidateIndex(this.candidates),
      totalCandidates: this.candidates.length,
    };
  }

  // ── Request core ──

  private static normalizeBaseUrl(raw: string): string {
    // Strip trailing slashes without a trailing-repeat regex — `/\/+$/` is
    // polynomial on slash-heavy input (js/polynomial-redos), and baseUrl is
    // MCP-client-controlled via the configure tool.
    let end = raw.length;
    while (end > 0 && raw[end - 1] === "/") end -= 1;
    return raw.slice(0, end);
  }

  private static initCandidates(config: GitLabConfig): CandidateCredential[] {
    if (config.candidates && config.candidates.length > 0) {
      // Defensive copy so external mutation cannot desync the state machine.
      return config.candidates.map((c) => ({ ...c }));
    }
    if (config.token) {
      return [
        {
          source: "env",
          secret: config.token,
          schemes: ["bearer"],
          status: "pending",
          nextSchemeIndex: 0,
        },
      ];
    }
    return [];
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body: RequestBody | undefined,
    authHeader: string | null,
  ): Promise<T> {
    if (this.baseUrl === null) throw new GitLabNotConfiguredError();
    const url = new URL(`${this.baseUrl}/api/v4${path}`).href;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authHeader) headers["Authorization"] = authHeader;

    const init: RequestInit = { method, headers };
    if (body !== undefined && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    } else if (body !== undefined) {
      init.body = body;
    }

    const response = await fetch(url, init);
    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new GitLabApiError(response.status, response.statusText, errorText);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  /**
   * Send one request, iterating the candidate × scheme list on 401/403 the
   * same way `GiteaClient.request` does: an active candidate is reused
   * without probing, anonymous requests go out header-less, non-auth errors
   * propagate immediately, and on total exhaustion the last `GitLabApiError`
   * is re-thrown so the caller sees the underlying status/body.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: RequestBody,
  ): Promise<T> {
    if (this.baseUrl === null) throw new GitLabNotConfiguredError();

    const activeIdx = findActiveCandidateIndex(this.candidates);
    if (activeIdx !== null) {
      const active = this.candidates[activeIdx];
      const scheme = active.activeScheme ?? active.schemes[0];
      return this.doRequest<T>(method, path, body, buildAuthHeader(active, scheme));
    }

    if (this.candidates.length === 0) {
      return this.doRequest<T>(method, path, body, null);
    }

    let lastError: GitLabApiError | null = null;
    while (true) {
      const attempt = pickNextAttempt(this.candidates);
      if (!attempt) {
        if (lastError) throw lastError;
        throw new GitLabApiError(0, "", "all credential candidates exhausted");
      }
      const candidate = this.candidates[attempt.candidateIndex];
      try {
        const result = await this.doRequest<T>(
          method,
          path,
          body,
          buildAuthHeader(candidate, attempt.scheme),
        );
        markAttemptSucceeded(this.candidates, attempt.candidateIndex, attempt.scheme);
        return result;
      } catch (err) {
        if (err instanceof GitLabApiError && (err.status === 401 || err.status === 403)) {
          markAttemptFailed(this.candidates, attempt.candidateIndex, `${err.status}`);
          lastError = err;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Run a tier-gated issue-links request. GitLab Free rejects the blocking
   * link types at runtime; when a credential is ALREADY active (it
   * previously succeeded on this instance), such a 403 is a tier limit —
   * not an auth problem — so it becomes a typed `GitLabTierError` instead of
   * the retry loop's raw re-throw (which would also have burned the working
   * candidate list). Without a prior active credential the error propagates
   * unchanged so normal auth probing still applies.
   */
  private async requestTierGated<T>(
    operation: string,
    method: string,
    path: string,
    body?: RequestBody,
  ): Promise<T> {
    const hadActive = findActiveCandidateIndex(this.candidates) !== null;
    try {
      return await this.request<T>(method, path, body);
    } catch (err) {
      if (hadActive && err instanceof GitLabApiError && err.status === 403) {
        throw new GitLabTierError(operation);
      }
      throw err;
    }
  }

  // ── Addressing helpers ──

  /** URL-encoded project path (`owner%2Frepo`) — GitLab project addressing. */
  private static projectPath(owner: string, repo: string): string {
    return encodeURIComponent(`${owner}/${repo}`);
  }

  private static p(owner: string, repo: string): string {
    return `/projects/${GitLabClient.projectPath(owner, repo)}`;
  }

  /** Serialize optional query parameters, dropping undefined values. */
  private static qs(params: Record<string, string | number | boolean | undefined>): string {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) searchParams.set(key, String(value));
    }
    const query = searchParams.toString();
    return query ? `?${query}` : "";
  }

  /** Gitea issue state vocabulary → GitLab (`open` → `opened`; `all` → no filter). */
  private static issueState(state: "open" | "closed" | "all" | undefined): string | undefined {
    if (state === "open") return "opened";
    if (state === "closed") return "closed";
    return undefined;
  }

  /** GitLab milestone dates are `YYYY-MM-DD`; Gitea's `due_on` is ISO 8601. */
  private static toDateOnly(iso: string): string {
    return iso.slice(0, 10);
  }

  /**
   * Resolve Gitea-style label IDs to GitLab label names (GitLab issue/MR
   * label parameters take comma-separated NAMES). Throws an explicit error
   * naming the unknown ID instead of letting the API reject the whole call.
   */
  private async resolveLabelNames(owner: string, repo: string, ids: number[]): Promise<string> {
    const all = await this.request<Label[]>("GET", `${GitLabClient.p(owner, repo)}/labels`);
    const byId = new Map(all.map((l) => [l.id, l.name]));
    const names = ids.map((id) => {
      const name = byId.get(id);
      if (name === undefined) {
        throw new GitLabApiError(
          400,
          "Bad Request",
          `label id ${id} not found in project ${owner}/${repo}`,
        );
      }
      return name;
    });
    return names.join(",");
  }

  /**
   * Resolve a username to a GitLab user ID through the project members API
   * (`GET /projects/:id/members/all?query=`, exact-match on `username`).
   * GitLab issue/MR assignee parameters take numeric IDs, not usernames.
   */
  private async resolveMemberId(owner: string, repo: string, username: string): Promise<number> {
    const path = `${GitLabClient.p(owner, repo)}/members/all${GitLabClient.qs({ query: username })}`;
    const members = await this.request<GitLabMember[]>("GET", path);
    const exact = members.find((m) => m.username === username);
    if (!exact) {
      throw new GitLabApiError(
        400,
        "Bad Request",
        `assignee '${username}' is not a member of project ${owner}/${repo}`,
      );
    }
    return exact.id;
  }

  private async resolveAssigneeIds(
    owner: string,
    repo: string,
    assignee?: string,
    assignees?: string[],
  ): Promise<{ assignee_id?: number; assignee_ids?: number[] }> {
    if (assignees && assignees.length > 0) {
      const ids = await Promise.all(assignees.map((u) => this.resolveMemberId(owner, repo, u)));
      return { assignee_ids: ids };
    }
    if (assignee) {
      return { assignee_id: await this.resolveMemberId(owner, repo, assignee) };
    }
    return {};
  }

  /**
   * Map the issue's current label NAMES to real project label objects
   * (`Label[]` contract of the Gitea-shaped return type) after a label
   * mutation.
   */
  private async currentIssueLabels(
    owner: string,
    repo: string,
    index: number,
  ): Promise<Label[]> {
    const issue = await this.request<Issue>("GET", `${GitLabClient.p(owner, repo)}/issues/${index}`);
    const names = new Set(Array.isArray(issue.labels) ? issue.labels.map((l) => String(l)) : []);
    if (names.size === 0) return [];
    const all = await this.request<Label[]>("GET", `${GitLabClient.p(owner, repo)}/labels?per_page=100`);
    return all.filter((l) => names.has(l.name));
  }

  // ── Issues ──

  async listIssues(params: ListIssuesParams): Promise<Issue[]> {
    const path =
      `${GitLabClient.p(params.owner, params.repo)}/issues` +
      GitLabClient.qs({
        state: GitLabClient.issueState(params.state),
        labels: params.labels,
        page: params.page,
        per_page: params.limit,
      });
    return this.request<Issue[]>("GET", path);
  }

  async getIssue(owner: string, repo: string, index: number): Promise<Issue> {
    return this.request<Issue>("GET", `${GitLabClient.p(owner, repo)}/issues/${index}`);
  }

  async createIssue(params: CreateIssueParams): Promise<Issue> {
    const assignees = await this.resolveAssigneeIds(params.owner, params.repo, params.assignee, params.assignees);
    const body: Record<string, unknown> = {
      title: params.title,
      description: params.body,
      ...assignees,
      milestone_id: params.milestone,
    };
    if (params.labels && params.labels.length > 0) {
      body.labels = await this.resolveLabelNames(params.owner, params.repo, params.labels);
    }
    return this.request<Issue>(
      "POST",
      `${GitLabClient.p(params.owner, params.repo)}/issues`,
      body,
    );
  }

  async updateIssue(params: UpdateIssueParams): Promise<Issue> {
    const assignees = await this.resolveAssigneeIds(params.owner, params.repo, params.assignee, params.assignees);
    const body: Record<string, unknown> = {
      title: params.title,
      description: params.body,
      ...assignees,
      milestone_id: params.milestone,
      state_event:
        params.state === "closed" ? "close" : params.state === "open" ? "reopen" : undefined,
    };
    if (params.labels && params.labels.length > 0) {
      body.labels = await this.resolveLabelNames(params.owner, params.repo, params.labels);
    }
    if (Object.values(body).every((v) => v === undefined)) {
      throw new GitLabApiError(
        400,
        "Bad Request",
        "GitLab issue updates require at least one field to change",
      );
    }
    return this.request<Issue>(
      "PUT",
      `${GitLabClient.p(params.owner, params.repo)}/issues/${params.index}`,
      body,
    );
  }

  async deleteIssue(owner: string, repo: string, index: number): Promise<void> {
    await this.request("DELETE", `${GitLabClient.p(owner, repo)}/issues/${index}`);
  }

  async searchIssues(params: SearchIssuesParams): Promise<Issue[]> {
    if (params.labels !== undefined) {
      throw new GitLabUnsupportedError(
        "search_issues with a labels filter",
        "the GitLab search API (GET /search) has no labels parameter",
      );
    }
    if (!params.query) {
      throw new GitLabUnsupportedError(
        "search_issues without a query",
        "the GitLab search API requires the `search` parameter",
      );
    }
    const scope = params.type === "pulls" ? "merge_requests" : "issues";
    const path =
      "/search" +
      GitLabClient.qs({
        scope,
        search: params.query,
        state: GitLabClient.issueState(params.state),
        page: params.page,
        per_page: params.limit,
      });
    return this.request<Issue[]>("GET", path);
  }

  // ── Issue dependencies / blocks (GitLab issue links) ──
  //
  // GitLab models dependencies as two-way issue links with a `link_type`
  // (`relates_to` / `blocks` / `is_blocked_by`). The list endpoint returns
  // each linked issue with `link_type` relative to the queried issue, so
  // `is_blocked_by` entries are the dependencies (blockers) and `blocks`
  // entries are the issues this issue blocks. All blocking link types are
  // Premium/Ultimate-gated → `requestTierGated`.

  private async listIssueLinks(
    params: ListIssueDependenciesParams,
  ): Promise<GitLabIssueLink[]> {
    const path =
      `${GitLabClient.p(params.owner, params.repo)}/issues/${params.index}/links` +
      GitLabClient.qs({ page: params.page, per_page: params.limit });
    return this.requestTierGated<GitLabIssueLink[]>(
      "Issue dependency/block operations",
      "GET",
      path,
    );
  }

  private async findLink(
    params: IssueDependencyTargetParams,
    linkType: string,
  ): Promise<GitLabIssueLink> {
    const links = await this.listIssueLinks({ owner: params.owner, repo: params.repo, index: params.index });
    let depProjectId: number | undefined;
    if (params.depOwner !== undefined || params.depRepo !== undefined) {
      const depOwner = params.depOwner ?? params.owner;
      const depRepo = params.depRepo ?? params.repo;
      const dep = await this.request<GitLabProject>(
        "GET",
        GitLabClient.p(depOwner, depRepo),
      );
      depProjectId = dep.id;
    }
    // When a cross-project target was specified, the project ID must match —
    // a lenient iid-only fallback could delete a different project's link.
    const match = links.find(
      (l) =>
        l.link_type === linkType &&
        l.iid === params.depIndex &&
        (depProjectId === undefined || l.project_id === depProjectId),
    );
    if (!match?.issue_link_id) {
      throw new GitLabApiError(
        404,
        "Not Found",
        `no '${linkType}' link to issue #${params.depIndex} on issue ${params.owner}/${params.repo}#${params.index}`,
      );
    }
    return match;
  }

  private async addIssueLink(
    params: IssueDependencyTargetParams,
    linkType: string,
  ): Promise<Issue> {
    const depOwner = params.depOwner ?? params.owner;
    const depRepo = params.depRepo ?? params.repo;
    await this.requestTierGated<Issue>(
      "Issue dependency/block operations",
      "POST",
      `${GitLabClient.p(params.owner, params.repo)}/issues/${params.index}/links`,
      {
        target_project_id: GitLabClient.projectPath(depOwner, depRepo),
        target_issue_iid: params.depIndex,
        link_type: linkType,
      },
    );
    // Keep the documented contract: return the issue on which the
    // relationship was created (the dependent for dependencies, the blocker
    // for blocks).
    return this.getIssue(params.owner, params.repo, params.index);
  }

  private async removeIssueLink(params: IssueDependencyTargetParams, linkType: string): Promise<Issue> {
    const link = await this.findLink(params, linkType);
    await this.requestTierGated(
      "Issue dependency/block operations",
      "DELETE",
      `${GitLabClient.p(params.owner, params.repo)}/issues/${params.index}/links/${link.issue_link_id}`,
    );
    return this.getIssue(params.owner, params.repo, params.index);
  }

  async listIssueDependencies(params: ListIssueDependenciesParams): Promise<Issue[]> {
    const links = await this.listIssueLinks(params);
    return links.filter((l) => l.link_type === "is_blocked_by") as unknown as Issue[];
  }

  async addIssueDependency(params: IssueDependencyTargetParams): Promise<Issue> {
    return this.addIssueLink(params, "is_blocked_by");
  }

  async removeIssueDependency(params: IssueDependencyTargetParams): Promise<Issue> {
    return this.removeIssueLink(params, "is_blocked_by");
  }

  async listIssueBlocks(params: ListIssueDependenciesParams): Promise<Issue[]> {
    const links = await this.listIssueLinks(params);
    return links.filter((l) => l.link_type === "blocks") as unknown as Issue[];
  }

  async addIssueBlock(params: IssueDependencyTargetParams): Promise<Issue> {
    return this.addIssueLink(params, "blocks");
  }

  async removeIssueBlock(params: IssueDependencyTargetParams): Promise<Issue> {
    return this.removeIssueLink(params, "blocks");
  }

  async checkIssueBlocked(params: CheckIssueBlockedParams): Promise<IssueBlockedResult> {
    const pageSize = 100;
    const dependencies: Issue[] = [];

    for (let page = 1; page <= MAX_LINK_PAGES; page++) {
      const deps = await this.listIssueDependencies({ ...params, page, limit: pageSize });
      dependencies.push(...deps);
      if (deps.length < pageSize) break;
    }

    const blockers = dependencies.filter((dep) => dep.state !== "closed");
    return {
      index: params.index,
      blocked: blockers.length > 0,
      blockers,
      total_dependencies: dependencies.length,
      open_blockers: blockers.length,
    };
  }

  // ── Comments (GitLab issue notes) ──

  async listComments(owner: string, repo: string, index: number): Promise<Comment[]> {
    // GitLab defaults to newest-first; Gitea returns oldest-first — keep the
    // documented ordering contract with explicit sort parameters.
    const path =
      `${GitLabClient.p(owner, repo)}/issues/${index}/notes` +
      GitLabClient.qs({ sort: "asc", order_by: "created_at" });
    return this.request<Comment[]>("GET", path);
  }

  async createComment(owner: string, repo: string, index: number, body: string): Promise<Comment> {
    return this.request<Comment>(
      "POST",
      `${GitLabClient.p(owner, repo)}/issues/${index}/notes`,
      { body },
    );
  }

  async updateComment(owner: string, repo: string, id: number, _body: string): Promise<Comment> {
    void _body;
    throw new GitLabUnsupportedError(
      "update_comment",
      "GitLab notes are addressed per-issue (/projects/:id/issues/:issue_iid/notes/:note_id) and this tool carries no issue number, so a note cannot be modified by global ID",
    );
  }

  async deleteComment(owner: string, repo: string, id: number): Promise<void> {
    void owner;
    void repo;
    void id;
    throw new GitLabUnsupportedError(
      "delete_comment",
      "GitLab notes are addressed per-issue (/projects/:id/issues/:issue_iid/notes/:note_id) and this tool carries no issue number, so a note cannot be deleted by global ID",
    );
  }

  // ── Issue attachments (no GitLab counterpart) ──

  async createIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    file: { data: Uint8Array<ArrayBuffer>; name: string },
    name?: string,
  ): Promise<Attachment> {
    void owner;
    void repo;
    void index;
    void file;
    void name;
    throw new GitLabUnsupportedError(
      "create_issue_attachment",
      "GitLab has no REST API for issue attachments",
    );
  }

  async listIssueAttachments(owner: string, repo: string, index: number): Promise<Attachment[]> {
    void owner;
    void repo;
    void index;
    throw new GitLabUnsupportedError(
      "list_issue_attachments",
      "GitLab has no REST API for issue attachments",
    );
  }

  async getIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    attachmentId: number,
  ): Promise<Attachment> {
    void owner;
    void repo;
    void index;
    void attachmentId;
    throw new GitLabUnsupportedError(
      "get_issue_attachment",
      "GitLab has no REST API for issue attachments",
    );
  }

  async editIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    attachmentId: number,
    name: string,
  ): Promise<Attachment> {
    void owner;
    void repo;
    void index;
    void attachmentId;
    void name;
    throw new GitLabUnsupportedError(
      "edit_issue_attachment",
      "GitLab has no REST API for issue attachments",
    );
  }

  async deleteIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    attachmentId: number,
  ): Promise<void> {
    void owner;
    void repo;
    void index;
    void attachmentId;
    throw new GitLabUnsupportedError(
      "delete_issue_attachment",
      "GitLab has no REST API for issue attachments",
    );
  }

  async createIssueCommentAttachment(
    owner: string,
    repo: string,
    commentId: number,
    file: { data: Uint8Array<ArrayBuffer>; name: string },
    name?: string,
  ): Promise<Attachment> {
    void owner;
    void repo;
    void commentId;
    void file;
    void name;
    throw new GitLabUnsupportedError(
      "create_issue_comment_attachment",
      "GitLab has no REST API for issue attachments",
    );
  }

  // ── Labels ──

  async listLabels(owner: string, repo: string, page?: number, limit?: number): Promise<Label[]> {
    const path =
      `${GitLabClient.p(owner, repo)}/labels` +
      GitLabClient.qs({ page, per_page: limit });
    return this.request<Label[]>("GET", path);
  }

  async createLabel(params: CreateLabelParams): Promise<Label> {
    return this.request<Label>("POST", `${GitLabClient.p(params.owner, params.repo)}/labels`, {
      name: params.name,
      color: params.color,
      description: params.description,
    });
  }

  async updateLabel(params: UpdateLabelParams): Promise<Label> {
    if (!params.name && !params.color) {
      throw new GitLabApiError(
        400,
        "Bad Request",
        "GitLab label updates require at least a new name or a color",
      );
    }
    // GitLab renames via `new_name` (PUT /projects/:id/labels/:label_id).
    return this.request<Label>(
      "PUT",
      `${GitLabClient.p(params.owner, params.repo)}/labels/${params.id}`,
      {
        new_name: params.name,
        color: params.color,
        description: params.description,
      },
    );
  }

  async deleteLabel(owner: string, repo: string, id: number): Promise<void> {
    await this.request("DELETE", `${GitLabClient.p(owner, repo)}/labels/${id}`);
  }

  async addIssueLabels(owner: string, repo: string, index: number, labels: string[]): Promise<Label[]> {
    const current = await this.getIssue(owner, repo, index);
    const existing = new Set(
      Array.isArray(current.labels) ? current.labels.map((l) => String(l)) : [],
    );
    const additions = labels.filter((name) => !existing.has(name));
    if (additions.length === 0) {
      return this.currentIssueLabels(owner, repo, index);
    }
    await this.request<Issue>(
      "PUT",
      `${GitLabClient.p(owner, repo)}/issues/${index}`,
      { add_labels: additions.join(",") },
    );
    return this.currentIssueLabels(owner, repo, index);
  }

  async removeIssueLabel(owner: string, repo: string, index: number, id: number): Promise<void> {
    // GitLab removes issue labels by NAME; translate the Gitea-style label ID.
    const all = await this.listLabels(owner, repo);
    const label = all.find((l) => l.id === id);
    if (!label) {
      throw new GitLabApiError(404, "Not Found", `label id ${id} not found in project ${owner}/${repo}`);
    }
    await this.request(
      "PUT",
      `${GitLabClient.p(owner, repo)}/issues/${index}`,
      { remove_labels: label.name },
    );
  }

  async replaceIssueLabels(owner: string, repo: string, index: number, labels: string[]): Promise<Label[]> {
    // `labels` (comma-separated) REPLACES the entire set; empty string clears.
    await this.request<Issue>(
      "PUT",
      `${GitLabClient.p(owner, repo)}/issues/${index}`,
      { labels: labels.join(",") },
    );
    return this.currentIssueLabels(owner, repo, index);
  }

  async clearIssueLabels(owner: string, repo: string, index: number): Promise<void> {
    await this.request("PUT", `${GitLabClient.p(owner, repo)}/issues/${index}`, { labels: "" });
  }

  // ── Milestones ──

  async listMilestones(
    owner: string,
    repo: string,
    state?: string,
    page?: number,
    limit?: number,
  ): Promise<Milestone[]> {
    // GitLab milestone state vocabulary: `active` / `closed`.
    const gitlabState = state === "open" ? "active" : state === "closed" ? "closed" : undefined;
    const path =
      `${GitLabClient.p(owner, repo)}/milestones` +
      GitLabClient.qs({ state: gitlabState, page, per_page: limit });
    return this.request<Milestone[]>("GET", path);
  }

  async getMilestone(owner: string, repo: string, id: number): Promise<Milestone> {
    return this.request<Milestone>("GET", `${GitLabClient.p(owner, repo)}/milestones/${id}`);
  }

  async createMilestone(params: CreateMilestoneParams): Promise<Milestone> {
    return this.request<Milestone>("POST", `${GitLabClient.p(params.owner, params.repo)}/milestones`, {
      title: params.title,
      description: params.description,
      due_date: params.due_on !== undefined ? GitLabClient.toDateOnly(params.due_on) : undefined,
    });
  }

  async updateMilestone(params: UpdateMilestoneParams): Promise<Milestone> {
    const body = {
      title: params.title,
      description: params.description,
      due_date: params.due_on !== undefined ? GitLabClient.toDateOnly(params.due_on) : undefined,
      state_event:
        params.state === "closed" ? "close" : params.state === "open" ? "activate" : undefined,
    };
    if (Object.values(body).every((v) => v === undefined)) {
      throw new GitLabApiError(
        400,
        "Bad Request",
        "GitLab milestone updates require at least one field to change",
      );
    }
    return this.request<Milestone>(
      "PUT",
      `${GitLabClient.p(params.owner, params.repo)}/milestones/${params.id}`,
      body,
    );
  }

  async deleteMilestone(owner: string, repo: string, id: number): Promise<void> {
    await this.request("DELETE", `${GitLabClient.p(owner, repo)}/milestones/${id}`);
  }

  // ── Repository / topics ──

  async listMyRepos(page?: number, limit?: number): Promise<Repo[]> {
    // GET /projects returns the projects the token can access (all owners).
    const path = `/projects${GitLabClient.qs({ page, per_page: limit })}`;
    return this.request<Repo[]>("GET", path);
  }

  async listTopics(_params: ListTopicsParams): Promise<TopicList> {
    const project = await this.request<GitLabProject>(
      "GET",
      GitLabClient.p(_params.owner, _params.repo),
    );
    return { topics: project.topics ?? [] };
  }

  async replaceTopics(params: ReplaceTopicsParams): Promise<TopicList> {
    const project = await this.request<GitLabProject>(
      "PUT",
      GitLabClient.p(params.owner, params.repo),
      { topics: params.topics },
    );
    return { topics: project.topics ?? [] };
  }

  async addTopic(owner: string, repo: string, topic: string): Promise<void> {
    const project = await this.request<GitLabProject>("GET", GitLabClient.p(owner, repo));
    const topics = project.topics ?? [];
    if (topics.includes(topic)) return;
    await this.request("PUT", GitLabClient.p(owner, repo), { topics: [...topics, topic] });
  }

  async removeTopic(owner: string, repo: string, topic: string): Promise<void> {
    const project = await this.request<GitLabProject>("GET", GitLabClient.p(owner, repo));
    const topics = (project.topics ?? []).filter((t) => t !== topic);
    await this.request("PUT", GitLabClient.p(owner, repo), { topics });
  }

  async getRepo(owner: string, repo: string): Promise<Repo> {
    return this.request<Repo>("GET", GitLabClient.p(owner, repo));
  }

  async updateRepo(params: UpdateRepoParams): Promise<Repo> {
    if (params.website !== undefined) {
      throw new GitLabUnsupportedError(
        "update_repo with website",
        "GitLab projects have no homepage/website attribute",
      );
    }
    if (params.private !== undefined) {
      throw new GitLabUnsupportedError(
        "update_repo with private",
        "GitLab visibility is a tri-state `visibility` attribute (private/internal/public), not a boolean",
      );
    }
    return this.request<Repo>("PUT", GitLabClient.p(params.owner, params.repo), {
      name: params.name,
      description: params.description,
      default_branch: params.default_branch,
    });
  }

  // ── Merge requests (the pull-request group) ──

  async listPullRequests(params: ListPullRequestsParams): Promise<PullRequest[]> {
    if (params.milestone !== undefined) {
      throw new GitLabUnsupportedError(
        "list_pull_requests with a milestone filter",
        "the GitLab merge request list API has no verifiable milestone-ID filter (its `milestone` parameter is title-based)",
      );
    }
    let orderBy: string | undefined;
    let sort: string | undefined;
    switch (params.sort) {
      case "oldest":
        orderBy = "created_at";
        sort = "asc";
        break;
      case "recentupdate":
        orderBy = "updated_at";
        sort = "desc";
        break;
      case "leastupdate":
        orderBy = "updated_at";
        sort = "asc";
        break;
      case "mostcomment":
      case "leastcomment":
      case "priority":
        throw new GitLabUnsupportedError(
          `list_pull_requests with sort=${params.sort}`,
          "GitLab supports created_at/updated_at ordering here; use oldest, recentupdate, or leastupdate",
        );
      case undefined:
        break;
    }
    const path =
      `${GitLabClient.p(params.owner, params.repo)}/merge_requests` +
      GitLabClient.qs({
        state: GitLabClient.issueState(params.state),
        labels: params.labels,
        order_by: orderBy,
        sort,
        page: params.page,
        per_page: params.limit,
      });
    return this.request<PullRequest[]>("GET", path);
  }

  async getPullRequest(owner: string, repo: string, index: number): Promise<PullRequest> {
    return this.request<PullRequest>("GET", `${GitLabClient.p(owner, repo)}/merge_requests/${index}`);
  }

  async createPullRequest(params: CreatePullRequestParams): Promise<PullRequest> {
    const assignees = await this.resolveAssigneeIds(params.owner, params.repo, params.assignee, params.assignees);
    const body: Record<string, unknown> = {
      source_branch: params.head,
      target_branch: params.base,
      title: params.title,
      description: params.body,
      ...assignees,
      milestone_id: params.milestone,
    };
    if (params.labels && params.labels.length > 0) {
      body.labels = await this.resolveLabelNames(params.owner, params.repo, params.labels);
    }
    return this.request<PullRequest>(
      "POST",
      `${GitLabClient.p(params.owner, params.repo)}/merge_requests`,
      body,
    );
  }

  async updatePullRequest(params: UpdatePullRequestParams): Promise<PullRequest> {
    const assignees = await this.resolveAssigneeIds(params.owner, params.repo, params.assignee, params.assignees);
    const body: Record<string, unknown> = {
      title: params.title,
      description: params.body,
      target_branch: params.base,
      ...assignees,
      milestone_id: params.milestone,
      state_event:
        params.state === "closed" ? "close" : params.state === "open" ? "reopen" : undefined,
    };
    if (params.labels && params.labels.length > 0) {
      body.labels = await this.resolveLabelNames(params.owner, params.repo, params.labels);
    }
    if (Object.values(body).every((v) => v === undefined)) {
      throw new GitLabApiError(
        400,
        "Bad Request",
        "GitLab merge request updates require at least one field to change",
      );
    }
    return this.request<PullRequest>(
      "PUT",
      `${GitLabClient.p(params.owner, params.repo)}/merge_requests/${params.index}`,
      body,
    );
  }

  async isPullMerged(owner: string, repo: string, index: number): Promise<boolean> {
    const mr = await this.getPullRequest(owner, repo, index);
    return mr.state === "merged";
  }

  async mergePullRequest(params: MergePullRequestParams): Promise<void> {
    if (params.Do === "rebase" || params.Do === "rebase-merge") {
      throw new GitLabUnsupportedError(
        `merge_pull_request with Do=${params.Do}`,
        "GitLab merges via PUT /projects/:id/merge_requests/:iid/merge; its rebase is a separate asynchronous endpoint that cannot be combined atomically with a merge",
      );
    }
    const body: Record<string, unknown> = {
      squash: params.Do === "squash" ? true : undefined,
      // GitLab has a single custom merge-commit message field; prefer the
      // Gitea message body, falling back to the title field.
      merge_commit_message: params.MergeMessageField ?? params.MergeTitleField,
      squash_commit_message: params.Do === "squash" ? (params.MergeMessageField ?? undefined) : undefined,
      sha: params.SHA,
    };
    await this.request(
      "PUT",
      `${GitLabClient.p(params.owner, params.repo)}/merge_requests/${params.index}/merge`,
      body,
    );
  }

  async listPullCommits(
    owner: string,
    repo: string,
    index: number,
    page?: number,
    limit?: number,
  ): Promise<PullCommit[]> {
    const path =
      `${GitLabClient.p(owner, repo)}/merge_requests/${index}/commits` +
      GitLabClient.qs({ page, per_page: limit });
    return this.request<PullCommit[]>("GET", path);
  }

  async listPullFiles(
    owner: string,
    repo: string,
    index: number,
    page?: number,
    limit?: number,
  ): Promise<PullFile[]> {
    const path =
      `${GitLabClient.p(owner, repo)}/merge_requests/${index}/diffs` +
      GitLabClient.qs({ page, per_page: limit });
    return this.request<PullFile[]>("GET", path);
  }

  // ── Pipelines (the Actions group) ──

  async listActionRuns(params: ListActionRunsParams): Promise<ActionWorkflowRunsResponse> {
    const path =
      `${GitLabClient.p(params.owner, params.repo)}/pipelines` +
      GitLabClient.qs({
        ref: params.branch,
        // Pass-through value-level filters: GitLab's `status`/`source`
        // vocabularies partially overlap the Gitea ones; documented in README.
        source: params.event,
        status: params.status,
        username: params.actor,
        sha: params.head_sha,
        page: params.page,
        per_page: params.limit,
      });
    const runs = await this.request<ActionWorkflowRun[]>("GET", path);
    return { workflow_runs: runs, count: runs.length };
  }

  async getActionRun(owner: string, repo: string, runId: number): Promise<ActionWorkflowRun> {
    return this.request<ActionWorkflowRun>(
      "GET",
      `${GitLabClient.p(owner, repo)}/pipelines/${runId}`,
    );
  }

  async cancelActionRun(owner: string, repo: string, runId: number): Promise<void> {
    await this.request(
      "POST",
      `${GitLabClient.p(owner, repo)}/pipelines/${runId}/cancel`,
    );
  }

  async rerunActionRun(owner: string, repo: string, runId: number): Promise<ActionWorkflowRun | undefined> {
    return this.request<ActionWorkflowRun>(
      "POST",
      `${GitLabClient.p(owner, repo)}/pipelines/${runId}/retry`,
    );
  }

  async rerunActionRunFailedJobs(owner: string, repo: string, runId: number): Promise<void> {
    void owner;
    void repo;
    void runId;
    throw new GitLabUnsupportedError(
      "rerun_action_run_failed_jobs",
      "GitLab retries whole pipelines (POST /projects/:id/pipelines/:pipeline_id/retry), not only their failed jobs — use rerun_action_run",
    );
  }

  // ── Releases ──
  //
  // GitLab releases are addressed by tag name only — there is no numeric
  // release ID, so the Gitea id-addressed tools have no counterpart.

  async listReleases(params: ListReleasesParams): Promise<Release[]> {
    if (params.draft !== undefined || params.prerelease !== undefined) {
      throw new GitLabUnsupportedError(
        "list_releases with draft/prerelease filters",
        "the GitLab release list API has no draft/prerelease filter",
      );
    }
    const path =
      `${GitLabClient.p(params.owner, params.repo)}/releases` +
      GitLabClient.qs({ page: params.page, per_page: params.limit });
    return this.request<Release[]>("GET", path);
  }

  async getRelease(owner: string, repo: string, id: number): Promise<Release> {
    void owner;
    void repo;
    void id;
    throw new GitLabUnsupportedError(
      "get_release by numeric ID",
      "GitLab releases are addressed by tag name (they carry no numeric ID) — use get_release_by_tag",
    );
  }

  async getReleaseByTag(owner: string, repo: string, tag: string): Promise<Release> {
    return this.request<Release>(
      "GET",
      `${GitLabClient.p(owner, repo)}/releases/${encodeURIComponent(tag)}`,
    );
  }

  async createRelease(params: CreateReleaseParams): Promise<Release> {
    if (params.draft !== undefined || params.prerelease !== undefined) {
      throw new GitLabUnsupportedError(
        "create_release with draft/prerelease",
        "GitLab releases have no draft/prerelease concepts",
      );
    }
    return this.request<Release>("POST", `${GitLabClient.p(params.owner, params.repo)}/releases`, {
      tag_name: params.tag_name,
      name: params.name,
      description: params.body,
      ref: params.target_commitish,
    });
  }

  async updateRelease(params: UpdateReleaseParams): Promise<Release> {
    void params;
    throw new GitLabUnsupportedError(
      "update_release by numeric ID",
      "GitLab releases are addressed by tag name (they carry no numeric ID)",
    );
  }

  async deleteRelease(owner: string, repo: string, id: number): Promise<void> {
    void owner;
    void repo;
    void id;
    throw new GitLabUnsupportedError(
      "delete_release by numeric ID",
      "GitLab releases are addressed by tag name (they carry no numeric ID)",
    );
  }

  // ── Wiki ──
  //
  // GitLab wiki pages are addressed by URL-encoded slug; content is plain
  // text (Markdown by default), so no base64 decoding is needed.

  async listWikiPages(params: ListWikiPagesParams): Promise<WikiPageMeta[]> {
    const path =
      `${GitLabClient.p(params.owner, params.repo)}/wikis` +
      GitLabClient.qs({ page: params.page, per_page: params.limit });
    return this.request<WikiPageMeta[]>("GET", path);
  }

  async getWikiPage(owner: string, repo: string, pageName: string): Promise<WikiPage> {
    return this.request<WikiPage>(
      "GET",
      `${GitLabClient.p(owner, repo)}/wikis/${encodeURIComponent(pageName)}`,
    );
  }

  async createWikiPage(params: CreateWikiPageParams): Promise<WikiPage> {
    if (params.message !== undefined) {
      throw new GitLabUnsupportedError(
        "create_wiki_page with message",
        "the GitLab wikis API does not accept a commit message",
      );
    }
    return this.request<WikiPage>("POST", `${GitLabClient.p(params.owner, params.repo)}/wikis`, {
      title: params.title,
      content: params.content,
    });
  }

  async updateWikiPage(params: UpdateWikiPageParams): Promise<WikiPage> {
    if (params.message !== undefined) {
      throw new GitLabUnsupportedError(
        "update_wiki_page with message",
        "the GitLab wikis API does not accept a commit message",
      );
    }
    if (params.title === undefined && params.content === undefined) {
      throw new GitLabApiError(
        400,
        "Bad Request",
        "GitLab wiki updates require at least a new title or new content",
      );
    }
    return this.request<WikiPage>(
      "PUT",
      `${GitLabClient.p(params.owner, params.repo)}/wikis/${encodeURIComponent(params.pageName)}`,
      { title: params.title, content: params.content },
    );
  }

  async deleteWikiPage(owner: string, repo: string, pageName: string): Promise<void> {
    await this.request(
      "DELETE",
      `${GitLabClient.p(owner, repo)}/wikis/${encodeURIComponent(pageName)}`,
    );
  }

  async listWikiRevisions(
    owner: string,
    repo: string,
    pageName: string,
    page?: number,
  ): Promise<WikiRevisionList> {
    void owner;
    void repo;
    void pageName;
    void page;
    throw new GitLabUnsupportedError(
      "list_wiki_revisions",
      "the GitLab wikis API has no revisions endpoint",
    );
  }

  // ── Projects (placeholder — parity with the Gitea client) ──

  async listProjects(_params: ListProjectsParams): Promise<Project[]> {
    return [];
  }

  async getProject(params: GetProjectParams): Promise<Project> {
    throw new GitLabApiError(
      404,
      "Not Found",
      "Repository project boards are not implemented for GitLab (placeholder, mirroring the Gitea client)",
    );
  }
}
