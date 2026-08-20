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

export interface GiteaConfig {
  /**
   * Gitea instance base URL. Optional — when omitted, the client starts in an
   * unconfigured state and `configure()` is used to set it at runtime.
   */
  baseUrl?: string;
  /**
   * Legacy single-token mode. When `candidates` is omitted, this is wrapped
   * as a one-element candidate list with the `token` scheme (preserving the
   * pre-multi-credential behavior exactly).
   */
  token?: string;
  /**
   * Credential candidates in priority order. When provided, enables the
   * fault-tolerant auth state machine: each candidate × scheme is tried in
   * order until one succeeds, with 401/403 advancing to the next attempt.
   */
  candidates?: CandidateCredential[];
}

/**
 * Thrown when an API tool is invoked before the client has been configured
 * with a baseUrl. Every business tool entry point (`request()`) guards with
 * this before any fetch is attempted, so the error message always reaches the
 * MCP client as actionable guidance.
 */
export class NotConfiguredError extends Error {
  constructor() {
    super(
      "Gitea connection is not configured. Use the configure_gitea tool to set base_url/owner/repo/username, or see the gitea-configure skill for guidance.",
    );
    this.name = "NotConfiguredError";
  }
}

/**
 * HTTP error from the Gitea API. Carries `status` as a structured field so
 * callers (the retry loop, tests) can branch on it without parsing the
 * message string (AGENTS.md §2.3 forbids substring-based control flow).
 */
export class GiteaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`Gitea API error (${status}): ${body || statusText}`);
    this.name = "GiteaApiError";
  }
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  state: string;
  body?: string;
  html_url: string;
  url: string;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  labels: Label[];
  assignee?: User;
  assignees?: User[];
  milestone?: Milestone;
  repository: Repository;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description?: string;
}

export interface User {
  id: number;
  login: string;
  full_name?: string;
  avatar_url: string;
  email?: string;
}

export interface Milestone {
  id: number;
  title: string;
  description?: string;
  state: string;
  open_issues: number;
  closed_issues: number;
  due_on?: string;
}

export interface Repository {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
}

export interface Comment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: User;
}

export interface Repo {
  id: number;
  full_name: string;
  name: string;
  owner: User;
  description?: string;
  html_url: string;
  default_branch?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateIssueParams {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  assignee?: string;
  assignees?: string[];
  labels?: number[];
  milestone?: number;
}

export interface UpdateIssueParams {
  owner: string;
  repo: string;
  index: number;
  title?: string;
  body?: string;
  assignee?: string;
  assignees?: string[];
  labels?: number[];
  milestone?: number;
  state?: string;
}

export interface ListIssuesParams {
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  labels?: string;
  page?: number;
  limit?: number;
}

export interface ListIssueDependenciesParams {
  owner: string;
  repo: string;
  index: number;
  page?: number;
  limit?: number;
}

export interface CheckIssueBlockedParams {
  owner: string;
  repo: string;
  index: number;
}

export interface IssueBlockedResult {
  index: number;
  blocked: boolean;
  blockers: Issue[];
  total_dependencies: number;
  open_blockers: number;
}

/**
 * Identifies the dependency/block relationship target. `owner` / `repo` / `index`
 * locate the issue in the request path; `depIndex` (+ optional `depOwner` /
 * `depRepo`, defaulting to the same repo) locate the `IssueMeta` body issue, so
 * cross-repository dependencies are supported when the instance allows them.
 */
export interface IssueDependencyTargetParams {
  owner: string;
  repo: string;
  index: number;
  depIndex: number;
  depOwner?: string;
  depRepo?: string;
}

export interface SearchIssuesParams {
  query?: string;
  type?: "issues" | "pulls";
  state?: "open" | "closed" | "all";
  labels?: string;
  page?: number;
  limit?: number;
}

export interface CreateLabelParams {
  owner: string;
  repo: string;
  name: string;
  color: string;
  description?: string;
}

export interface UpdateLabelParams {
  owner: string;
  repo: string;
  id: number;
  name?: string;
  color?: string;
  description?: string;
}

export interface CreateMilestoneParams {
  owner: string;
  repo: string;
  title: string;
  description?: string;
  due_on?: string;
}

export interface UpdateMilestoneParams {
  owner: string;
  repo: string;
  id: number;
  title?: string;
  description?: string;
  due_on?: string;
  state?: string;
}

export interface TopicList {
  topics: string[];
}

export interface ListTopicsParams {
  owner: string;
  repo: string;
  page?: number;
  limit?: number;
}

export interface ReplaceTopicsParams {
  owner: string;
  repo: string;
  topics: string[];
}

export interface PullRequestBranch {
  label: string;
  ref: string;
  sha: string;
  repo: Repository;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body?: string;
  state: string;
  html_url: string;
  url: string;
  labels: Label[];
  assignee?: User;
  assignees?: User[];
  milestone?: Milestone;
  user: User;
  merged?: boolean;
  merged_at?: string;
  mergeable?: boolean;
  draft?: boolean;
  base: PullRequestBranch;
  head: PullRequestBranch;
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

export interface PullCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; email: string; date?: string };
  };
  author?: User;
}

export interface PullFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  html_url: string;
}

export interface ListPullRequestsParams {
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  labels?: string;
  sort?: "oldest" | "recentupdate" | "leastupdate" | "mostcomment" | "leastcomment" | "priority";
  milestone?: number;
  page?: number;
  limit?: number;
}

export interface CreatePullRequestParams {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  head: string;
  base: string;
  assignee?: string;
  assignees?: string[];
  labels?: number[];
  milestone?: number;
}

export interface UpdatePullRequestParams {
  owner: string;
  repo: string;
  index: number;
  title?: string;
  body?: string;
  base?: string;
  assignee?: string;
  assignees?: string[];
  labels?: number[];
  milestone?: number;
  state?: "open" | "closed";
}

export interface MergePullRequestParams {
  owner: string;
  repo: string;
  index: number;
  Do: "merge" | "squash" | "rebase" | "rebase-merge";
  MergeTitleField?: string;
  MergeMessageField?: string;
  SHA?: string;
}

// ── Projects (placeholder — Gitea has no projects REST API yet) ──

/**
 * Repository project board. No live shape exists yet — the fields here
 * anticipate the upstream API (go-gitea/gitea#36824) so that wiring real HTTP
 * calls later is a mechanical change inside `listProjects` / `getProject`.
 */
export interface Project {
  id: number;
  title: string;
  description?: string;
  state: string;
}

export interface ListProjectsParams {
  owner: string;
  repo: string;
}

export interface GetProjectParams {
  owner: string;
  repo: string;
  id: number;
}

// ── Repository ──

export interface UpdateRepoParams {
  owner: string;
  repo: string;
  name?: string;
  description?: string;
  website?: string;
  private?: boolean;
  default_branch?: string;
}

// ── Wiki ──

export interface WikiCommit {
  sha: string;
  message: string;
  author?: { name: string; email: string; date?: string };
  commiter?: { name: string; email: string; date?: string };
}

export interface WikiPageMeta {
  title: string;
  html_url: string;
  sub_url?: string;
  last_commit?: WikiCommit;
}

/**
 * Decoded wiki page as returned to MCP callers. `content` is the plain
 * Markdown text (decoded from the API's `content_base64`) so clients never
 * have to handle base64 themselves.
 */
export interface WikiPage {
  title: string;
  content: string;
  footer?: string;
  sidebar?: string;
  html_url: string;
  sub_url?: string;
  commit_count: number;
  last_commit?: WikiCommit;
}

/** Raw wiki page shape returned by the Gitea API (content is base64). */
interface WikiPageResponse {
  title: string;
  content_base64?: string;
  footer?: string;
  sidebar?: string;
  html_url: string;
  sub_url?: string;
  commit_count: number;
  last_commit?: WikiCommit;
}

export interface WikiRevisionList {
  commits: WikiCommit[];
  count: number;
}

export interface ListWikiPagesParams {
  owner: string;
  repo: string;
  page?: number;
  limit?: number;
}

export interface CreateWikiPageParams {
  owner: string;
  repo: string;
  title: string;
  content: string;
  message?: string;
}

export interface UpdateWikiPageParams {
  owner: string;
  repo: string;
  pageName: string;
  title?: string;
  content?: string;
  message?: string;
}

// ── Actions ──

export interface ActionWorkflowRun {
  id: number;
  display_title?: string;
  event?: string;
  head_branch?: string;
  head_sha?: string;
  path?: string;
  run_attempt?: number;
  run_number?: number;
  status: string;
  conclusion?: string;
  url?: string;
  html_url?: string;
  started_at?: string;
  completed_at?: string;
  actor?: User;
  trigger_actor?: User;
  repository?: Repository;
  head_repository?: Repository;
}

export interface ActionWorkflowRunsResponse {
  workflow_runs: ActionWorkflowRun[];
  count: number;
}

export interface ListActionRunsParams {
  owner: string;
  repo: string;
  branch?: string;
  event?: string;
  status?: string;
  actor?: string;
  head_sha?: string;
  page?: number;
  limit?: number;
}

// ── Releases ──

/**
 * A request body: JSON-serializable data or a multipart upload form. The
 * union keeps the multipart branch of `doRequest` a type-narrowing (`typeof`
 * / `instanceof`) instead of an `unknown`-typed free-for-all, so static
 * analysis (CodeQL taint tracking) sees one explicit sink per branch.
 */
export type RequestBody = FormData | Record<string, unknown>;

// Gitea's generic Attachment model — shared by the issue, issue-comment, and
// release asset endpoints (field-identical across all three).
export interface Attachment {
  id: number;
  name: string;
  size: number;
  download_count: number;
  created_at: string;
  uuid: string;
  browser_download_url: string;
}

export interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  name?: string;
  body?: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at?: string;
  html_url: string;
  url: string;
  tag_commit?: { sha: string; url: string };
  author?: User;
  attachments?: Attachment[];
}

export interface ListReleasesParams {
  owner: string;
  repo: string;
  draft?: boolean;
  prerelease?: boolean;
  page?: number;
  limit?: number;
}

export interface CreateReleaseParams {
  owner: string;
  repo: string;
  tag_name: string;
  name?: string;
  body?: string;
  target_commitish?: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface UpdateReleaseParams {
  owner: string;
  repo: string;
  id: number;
  tag_name?: string;
  name?: string;
  body?: string;
  target_commitish?: string;
  draft?: boolean;
  prerelease?: boolean;
}

export class GiteaClient {
  private baseUrl: string | null;
  private candidates: CandidateCredential[];

  constructor(config: GiteaConfig = {}) {
    this.baseUrl = config.baseUrl ? GiteaClient.normalizeBaseUrl(config.baseUrl) : null;
    this.candidates = GiteaClient.initCandidates(config);
  }

  /**
   * Parse, validate, and normalize a raw baseUrl string. Shared by the
   * constructor and `configure()` so tool-supplied URLs go through the same
   * protocol allowlist + URL reconstruction pipeline as git-file-derived values.
   */
  private static normalizeBaseUrl(raw: string): string {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid Gitea baseUrl: ${raw}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Gitea baseUrl must use http or https, got: ${parsed.protocol}`);
    }
    let path = parsed.pathname;
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${parsed.protocol}//${parsed.host}${path === "/" ? "" : path}`;
  }

  /**
   * Build the initial candidate list from config — shared extraction so the
   * constructor stays focused on assignment.
   */
  private static initCandidates(config: GiteaConfig): CandidateCredential[] {
    if (config.candidates && config.candidates.length > 0) {
      // Defensive copy so external mutation cannot desync the state machine.
      return config.candidates.map((c) => ({ ...c }));
    }
    if (config.token) {
      return [
        {
          source: "env",
          secret: config.token,
          schemes: ["token"],
          status: "pending",
          nextSchemeIndex: 0,
        },
      ];
    }
    return [];
  }

  /**
   * Atomically replace the connection state. When `baseUrl` is provided it is
   * normalized and set; when `candidates` is provided they replace the current
   * list with defensive copies whose state machine is fully reset (all back to
   * `pending`). This prevents an old host's active candidate from sending its
   * old token to a new host.
   */
  configure(params: { baseUrl?: string; candidates?: CandidateCredential[] }): void {
    if (params.baseUrl !== undefined) {
      this.baseUrl = GiteaClient.normalizeBaseUrl(params.baseUrl);
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

  /** Whether the client has a baseUrl and can make API calls. */
  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  /** The current normalized baseUrl, or null when unconfigured. */
  getBaseUrl(): string | null {
    return this.baseUrl;
  }

  /**
   * Snapshot of the credential state machine — for the `gitea_status` tool.
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

  /**
   * Single HTTP call. Throws `GiteaApiError` on non-2xx so the retry loop can
   * branch on `status` (never on the message string). The `authHeader` is
   * pre-built by the caller from the active candidate + scheme.
   *
   * SECURITY (CodeQL `js/file-access-to-http`): two designed file → HTTP
   * data flows reach the fetch sink below. Each carries its OWN justified
   * line-scoped suppression at the point the taint enters the request; the
   * rule itself stays globally enabled as a guardrail against real backdoor
   * injection, and neither suppression covers the other's flow.
   *
   * 1. Credential flow — the `Authorization` header (and the `init` object
   *    carrying it) holds credentials read from local git files
   *    (`~/.git-credentials` / `.git/config` → `CandidateCredential.secret`
   *    → `buildAuthHeader`, see `credentials.ts`). This is the designed
   *    authentication pipeline (docs/architecture.md §5.3), NOT information
   *    exfiltration: the secret is sent verbatim because that is its purpose,
   *    and AGENTS.md §4 forbids logging or echoing it anywhere else.
   *
   * 2. Attachment-upload flow — multipart `FormData` bodies carry a local
   *    file's bytes because uploading that file is the entire point of the
   *    attachment tools. The upload source is hardened BEFORE it reaches
   *    this method by the `readUploadFile` confinement choke point in
   *    `server.ts` (realpath upload-root confinement, sensitive-location
   *    deny-list, extension allow-list, size cap, path-free errors), per
   *    issue #76: the rule stayed active until the source was hardened;
   *    with the hardening in place the suppression is justified.
   */
  private async doRequest<T>(
    method: string,
    path: string,
    body: RequestBody | undefined,
    authHeader: string | null,
  ): Promise<T> {
    // Guard: every API tool enters here through request(), which already checks
    // for the unconfigured state. This assertion exists solely for TypeScript
    // narrowing (this.baseUrl is string | null); it is never reached at runtime
    // unless doRequest is called directly (which never happens).
    if (this.baseUrl === null) throw new NotConfiguredError();
    const url = new URL(`${this.baseUrl}/api/v1${path}`).href;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authHeader) headers["Authorization"] = authHeader;

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      if (body instanceof FormData) {
        // Multipart upload (issue/comment attachments): let fetch derive the
        // Content-Type with its own boundary — a manually set Content-Type
        // would omit the boundary parameter and break the request.
        // Intentional (flow 2, attachment upload): the file bytes in this
        // FormData were read through the `readUploadFile` confinement choke
        // point in `server.ts` (upload-root realpath confinement, sensitive-
        // location deny-list, extension allow-list, size cap) per issue #76 —
        // uploading the confined file is the designed behavior. See the
        // doRequest doc comment. The rule stays globally enabled.
        init.body = /* codeql[js/file-access-to-http] */ body;
      } else {
        headers["Content-Type"] = "application/json";
        // Intentional (flow 1, credential): `init` carries the file-derived
        // auth header built by buildAuthHeader (see the doRequest doc comment
        // above). Path-scoped suppression for this sink; the rule stays
        // globally enabled.
        // codeql[js/file-access-to-http]
        init.body = JSON.stringify(body);
      }
    }

    // Intentional credential authentication (docs/architecture.md §5.3,
    // AGENTS.md §4), not exfiltration — see the doRequest doc comment.
    // codeql[js/file-access-to-http]
    const response = await fetch(url, init);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new GiteaApiError(response.status, response.statusText, errorText);
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
   * Auth-aware request entry point. Three modes:
   *
   * 1. Active candidate exists (a prior attempt succeeded): reuse its locked
   *    scheme directly, no iteration.
   * 2. No candidates at all: anonymous request (no Authorization header).
   * 3. Otherwise: iterate (candidate, scheme) pairs in priority order, trying
   *    each until one succeeds. On 401/403 the current attempt is marked
   *    failed and the next is tried; non-auth errors propagate immediately
   *    (we do NOT mask 5xx / network errors as auth failures). When every
   *    candidate × scheme is exhausted, the most recent `GiteaApiError` is
   *    re-thrown so the caller sees the underlying status/body; the
   *    `gitea_status` tool surfaces the full attempt history.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: RequestBody,
  ): Promise<T> {
    // Single guard point: when unconfigured, throw before any fetch. This
    // covers every API tool including search_issues / list_my_repos which
    // bypass resolve() but still enter request().
    if (this.baseUrl === null) throw new NotConfiguredError();

    const activeIdx = findActiveCandidateIndex(this.candidates);
    if (activeIdx !== null) {
      const active = this.candidates[activeIdx];
      const scheme = active.activeScheme ?? active.schemes[0];
      return this.doRequest<T>(method, path, body, buildAuthHeader(active, scheme));
    }

    if (this.candidates.length === 0) {
      return this.doRequest<T>(method, path, body, null);
    }

    let lastError: GiteaApiError | null = null;
    while (true) {
      const attempt = pickNextAttempt(this.candidates);
      if (!attempt) {
        // Exhausted. Re-throw the underlying API error so the status/body
        // format is preserved. The gitea_status tool reveals the full
        // candidate × scheme attempt history.
        if (lastError) throw lastError;
        throw new GiteaApiError(0, "", "all credential candidates exhausted");
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
        if (err instanceof GiteaApiError && (err.status === 401 || err.status === 403)) {
          markAttemptFailed(this.candidates, attempt.candidateIndex, `${err.status}`);
          lastError = err;
          continue;
        }
        throw err;
      }
    }
  }

  async listIssues(
    params: ListIssuesParams,
  ): Promise<Issue[]> {
    const searchParams = new URLSearchParams();
    if (params.state) searchParams.set("state", params.state);
    if (params.labels) searchParams.set("labels", params.labels);
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues${query ? `?${query}` : ""}`;
    return this.request<Issue[]>("GET", path);
  }

  async getIssue(owner: string, repo: string, index: number): Promise<Issue> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}`;
    return this.request<Issue>("GET", path);
  }

  async createIssue(params: CreateIssueParams): Promise<Issue> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues`;
    return this.request<Issue>("POST", path, {
      title: params.title,
      body: params.body,
      assignee: params.assignee,
      assignees: params.assignees,
      labels: params.labels,
      milestone: params.milestone,
    });
  }

  async updateIssue(params: UpdateIssueParams): Promise<Issue> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.index}`;
    return this.request<Issue>("PATCH", path, {
      title: params.title,
      body: params.body,
      assignee: params.assignee,
      assignees: params.assignees,
      labels: params.labels,
      milestone: params.milestone,
      state: params.state,
    });
  }

  async deleteIssue(owner: string, repo: string, index: number): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}`;
    return this.request<void>("DELETE", path);
  }

  async searchIssues(params: SearchIssuesParams): Promise<Issue[]> {
    const searchParams = new URLSearchParams();
    if (params.query) searchParams.set("q", params.query);
    if (params.type) searchParams.set("type", params.type);
    if (params.state) searchParams.set("state", params.state);
    if (params.labels) searchParams.set("labels", params.labels);
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/issues/search${query ? `?${query}` : ""}`;
    return this.request<Issue[]>("GET", path);
  }

  // ── Issue Dependencies ──

  /**
   * Builds the `IssueMeta` body for a dependency/block mutation. The body issue
   * (`depIndex`) defaults to the same repo as the path issue when its owner/repo
   * are not provided — the common same-repo case — but keeps cross-repo support.
   */
  private issueMetaBody(params: IssueDependencyTargetParams): { index: number; owner: string; repo: string } {
    return {
      index: params.depIndex,
      owner: params.depOwner ?? params.owner,
      repo: params.depRepo ?? params.repo,
    };
  }

  /** List the issues that BLOCK this issue (its "blocked by" dependencies). */
  async listIssueDependencies(params: ListIssueDependenciesParams): Promise<Issue[]> {
    const searchParams = new URLSearchParams();
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.index}/dependencies${query ? `?${query}` : ""}`;
    return this.request<Issue[]>("GET", path);
  }

  /** Make `index` depend on (be blocked by) `depIndex`. Returns the target issue. */
  async addIssueDependency(params: IssueDependencyTargetParams): Promise<Issue> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.index}/dependencies`;
    return this.request<Issue>("POST", path, this.issueMetaBody(params));
  }

  /** Remove the dependency where `index` is blocked by `depIndex`. Returns the target issue. */
  async removeIssueDependency(params: IssueDependencyTargetParams): Promise<Issue> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.index}/dependencies`;
    return this.request<Issue>("DELETE", path, this.issueMetaBody(params));
  }

  /** List the issues that are BLOCKED BY this issue (its "blocking" dependents). */
  async listIssueBlocks(params: ListIssueDependenciesParams): Promise<Issue[]> {
    const searchParams = new URLSearchParams();
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.index}/blocks${query ? `?${query}` : ""}`;
    return this.request<Issue[]>("GET", path);
  }

  /** Make `depIndex` be blocked by `index`. Returns the path (blocker) issue. */
  async addIssueBlock(params: IssueDependencyTargetParams): Promise<Issue> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.index}/blocks`;
    return this.request<Issue>("POST", path, this.issueMetaBody(params));
  }

  /** Unblock `depIndex` from being blocked by `index`. Returns the path (blocker) issue. */
  async removeIssueBlock(params: IssueDependencyTargetParams): Promise<Issue> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.index}/blocks`;
    return this.request<Issue>("DELETE", path, this.issueMetaBody(params));
  }

  /**
   * Determine whether `index` is blocked: it has at least one dependency whose
   * `state` is not `"closed"`. Paginates `listIssueDependencies` internally until
   * all dependencies are collected, then assembles the verdict in a single result.
   */
  async checkIssueBlocked(params: CheckIssueBlockedParams): Promise<IssueBlockedResult> {
    const pageSize = 100;
    const dependencies: Issue[] = [];

    for (let page = 1; ; page++) {
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

  async listComments(
    owner: string,
    repo: string,
    index: number,
  ): Promise<Comment[]> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/comments`;
    return this.request<Comment[]>("GET", path);
  }

  async createComment(
    owner: string,
    repo: string,
    index: number,
    body: string,
  ): Promise<Comment> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/comments`;
    return this.request<Comment>("POST", path, { body });
  }

  async updateComment(
    owner: string,
    repo: string,
    id: number,
    body: string,
  ): Promise<Comment> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${id}`;
    return this.request<Comment>("PATCH", path, { body });
  }

  async deleteComment(
    owner: string,
    repo: string,
    id: number,
  ): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${id}`;
    return this.request<void>("DELETE", path);
  }

  // ── Issue attachments ──

  /**
   * Upload a file as an issue attachment (multipart/form-data). The caller
   * (server.ts handler) reads the local file; this method stays pure HTTP:
   * it wraps the given bytes + filename into a FormData with the required
   * `attachment` field. `name` optionally overrides the stored filename.
   */
  async createIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    file: { data: Uint8Array<ArrayBuffer>; name: string },
    name?: string,
  ): Promise<Attachment> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/assets`;
    const query = new URLSearchParams();
    if (name) query.set("name", name);
    const form = new FormData();
    form.append("attachment", new Blob([file.data]), file.name);
    const qs = query.toString();
    return this.request<Attachment>("POST", qs ? `${path}?${qs}` : path, form);
  }

  async listIssueAttachments(
    owner: string,
    repo: string,
    index: number,
  ): Promise<Attachment[]> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/assets`;
    return this.request<Attachment[]>("GET", path);
  }

  async getIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    attachmentId: number,
  ): Promise<Attachment> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/assets/${attachmentId}`;
    return this.request<Attachment>("GET", path);
  }

  async editIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    attachmentId: number,
    name: string,
  ): Promise<Attachment> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/assets/${attachmentId}`;
    return this.request<Attachment>("PATCH", path, { name });
  }

  async deleteIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    attachmentId: number,
  ): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/assets/${attachmentId}`;
    return this.request<void>("DELETE", path);
  }

  /**
   * Upload a file as an attachment on one issue comment (multipart/form-data,
   * same shape as createIssueAttachment but targeting the comment by id).
   */
  async createIssueCommentAttachment(
    owner: string,
    repo: string,
    commentId: number,
    file: { data: Uint8Array<ArrayBuffer>; name: string },
    name?: string,
  ): Promise<Attachment> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/assets`;
    const query = new URLSearchParams();
    if (name) query.set("name", name);
    const form = new FormData();
    form.append("attachment", new Blob([file.data]), file.name);
    const qs = query.toString();
    return this.request<Attachment>("POST", qs ? `${path}?${qs}` : path, form);
  }

  async listLabels(
    owner: string,
    repo: string,
    page?: number,
    limit?: number,
  ): Promise<Label[]> {
    const searchParams = new URLSearchParams();
    if (page) searchParams.set("page", String(page));
    if (limit) searchParams.set("limit", String(limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels${query ? `?${query}` : ""}`;
    return this.request<Label[]>("GET", path);
  }

  async createLabel(params: CreateLabelParams): Promise<Label> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/labels`;
    return this.request<Label>("POST", path, {
      name: params.name,
      color: params.color,
      description: params.description,
    });
  }

  async updateLabel(params: UpdateLabelParams): Promise<Label> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/labels/${params.id}`;
    return this.request<Label>("PATCH", path, {
      name: params.name,
      color: params.color,
      description: params.description,
    });
  }

  async deleteLabel(owner: string, repo: string, id: number): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels/${id}`;
    return this.request<void>("DELETE", path);
  }

  async addIssueLabels(
    owner: string,
    repo: string,
    index: number,
    labels: string[],
  ): Promise<Label[]> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/labels`;

    const current = await this.request<Label[]>("GET", path);
    const existingNames = new Set(current.map((l) => l.name));

    const toAdd: string[] = [];
    const seen = new Set<string>();
    for (const name of labels) {
      if (!existingNames.has(name) && !seen.has(name)) {
        toAdd.push(name);
        seen.add(name);
      }
    }

    if (toAdd.length === 0) {
      return current;
    }

    return this.request<Label[]>("POST", path, { labels: toAdd });
  }

  async removeIssueLabel(
    owner: string,
    repo: string,
    index: number,
    id: number,
  ): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/labels/${id}`;
    return this.request<void>("DELETE", path);
  }

  async replaceIssueLabels(
    owner: string,
    repo: string,
    index: number,
    labels: string[],
  ): Promise<Label[]> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/labels`;
    return this.request<Label[]>("PUT", path, { labels });
  }

  async clearIssueLabels(
    owner: string,
    repo: string,
    index: number,
  ): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/labels`;
    return this.request<void>("DELETE", path);
  }

  async listMilestones(
    owner: string,
    repo: string,
    state?: string,
    page?: number,
    limit?: number,
  ): Promise<Milestone[]> {
    const searchParams = new URLSearchParams();
    if (state) searchParams.set("state", state);
    if (page) searchParams.set("page", String(page));
    if (limit) searchParams.set("limit", String(limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones${query ? `?${query}` : ""}`;
    return this.request<Milestone[]>("GET", path);
  }

  async getMilestone(
    owner: string,
    repo: string,
    id: number,
  ): Promise<Milestone> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones/${id}`;
    return this.request<Milestone>("GET", path);
  }

  async createMilestone(params: CreateMilestoneParams): Promise<Milestone> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/milestones`;
    return this.request<Milestone>("POST", path, {
      title: params.title,
      description: params.description,
      due_on: params.due_on,
    });
  }

  async updateMilestone(params: UpdateMilestoneParams): Promise<Milestone> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/milestones/${params.id}`;
    return this.request<Milestone>("PATCH", path, {
      title: params.title,
      description: params.description,
      due_on: params.due_on,
      state: params.state,
    });
  }

  async deleteMilestone(
    owner: string,
    repo: string,
    id: number,
  ): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones/${id}`;
    return this.request<void>("DELETE", path);
  }

  async listMyRepos(page?: number, limit?: number): Promise<Repo[]> {
    const searchParams = new URLSearchParams();
    if (page) searchParams.set("page", String(page));
    if (limit) searchParams.set("limit", String(limit));

    const query = searchParams.toString();
    const path = `/user/repos${query ? `?${query}` : ""}`;
    return this.request<Repo[]>("GET", path);
  }

  async listTopics(params: ListTopicsParams): Promise<TopicList> {
    const searchParams = new URLSearchParams();
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/topics${query ? `?${query}` : ""}`;
    return this.request<TopicList>("GET", path);
  }

  async replaceTopics(params: ReplaceTopicsParams): Promise<TopicList> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/topics`;
    return this.request<TopicList>("PUT", path, { topics: params.topics });
  }

  async addTopic(owner: string, repo: string, topic: string): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/topics/${encodeURIComponent(topic)}`;
    return this.request<void>("PUT", path);
  }

  async removeTopic(owner: string, repo: string, topic: string): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/topics/${encodeURIComponent(topic)}`;
    return this.request<void>("DELETE", path);
  }

  async listPullRequests(params: ListPullRequestsParams): Promise<PullRequest[]> {
    const searchParams = new URLSearchParams();
    if (params.state) searchParams.set("state", params.state);
    if (params.labels) searchParams.set("labels", params.labels);
    if (params.sort) searchParams.set("sort", params.sort);
    if (params.milestone) searchParams.set("milestone", String(params.milestone));
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls${query ? `?${query}` : ""}`;
    return this.request<PullRequest[]>("GET", path);
  }

  async getPullRequest(owner: string, repo: string, index: number): Promise<PullRequest> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}`;
    return this.request<PullRequest>("GET", path);
  }

  async createPullRequest(params: CreatePullRequestParams): Promise<PullRequest> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls`;
    return this.request<PullRequest>("POST", path, {
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base,
      assignee: params.assignee,
      assignees: params.assignees,
      labels: params.labels,
      milestone: params.milestone,
    });
  }

  async updatePullRequest(params: UpdatePullRequestParams): Promise<PullRequest> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.index}`;
    return this.request<PullRequest>("PATCH", path, {
      title: params.title,
      body: params.body,
      base: params.base,
      assignee: params.assignee,
      assignees: params.assignees,
      labels: params.labels,
      milestone: params.milestone,
      state: params.state,
    });
  }

  async isPullMerged(owner: string, repo: string, index: number): Promise<boolean> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/merge`;
    try {
      await this.request<void>("GET", path);
      return true;
    } catch (err) {
      // Gitea returns 404 when the pull request has not been merged; any other
      // status propagates. Status-based branching (not message substring) per §2.3.
      if (err instanceof GiteaApiError && err.status === 404) return false;
      throw err;
    }
  }

  async mergePullRequest(params: MergePullRequestParams): Promise<void> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.index}/merge`;
    return this.request<void>("POST", path, {
      Do: params.Do,
      MergeTitleField: params.MergeTitleField,
      MergeMessageField: params.MergeMessageField,
      SHA: params.SHA,
    });
  }

  async listPullCommits(
    owner: string,
    repo: string,
    index: number,
    page?: number,
    limit?: number,
  ): Promise<PullCommit[]> {
    const searchParams = new URLSearchParams();
    if (page) searchParams.set("page", String(page));
    if (limit) searchParams.set("limit", String(limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/commits${query ? `?${query}` : ""}`;
    return this.request<PullCommit[]>("GET", path);
  }

  async listPullFiles(
    owner: string,
    repo: string,
    index: number,
    page?: number,
    limit?: number,
  ): Promise<PullFile[]> {
    const searchParams = new URLSearchParams();
    if (page) searchParams.set("page", String(page));
    if (limit) searchParams.set("limit", String(limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/files${query ? `?${query}` : ""}`;
    return this.request<PullFile[]>("GET", path);
  }

  // ── Actions ──

  async listActionRuns(params: ListActionRunsParams): Promise<ActionWorkflowRunsResponse> {
    const searchParams = new URLSearchParams();
    if (params.branch) searchParams.set("branch", params.branch);
    if (params.event) searchParams.set("event", params.event);
    if (params.status) searchParams.set("status", params.status);
    if (params.actor) searchParams.set("created_by", params.actor);
    if (params.head_sha) searchParams.set("head_sha", params.head_sha);
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/actions/runs${query ? `?${query}` : ""}`;
    return this.request<ActionWorkflowRunsResponse>("GET", path);
  }

  async getActionRun(owner: string, repo: string, runId: number): Promise<ActionWorkflowRun> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`;
    return this.request<ActionWorkflowRun>("GET", path);
  }

  async cancelActionRun(owner: string, repo: string, runId: number): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/cancel`;
    return this.request<void>("POST", path);
  }

  async rerunActionRun(owner: string, repo: string, runId: number): Promise<ActionWorkflowRun | undefined> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/rerun`;
    return this.request<ActionWorkflowRun | undefined>("POST", path);
  }

  async rerunActionRunFailedJobs(owner: string, repo: string, runId: number): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/rerun-failed-jobs`;
    return this.request<void>("POST", path);
  }

  // ── Releases ──

  async listReleases(params: ListReleasesParams): Promise<Release[]> {
    const searchParams = new URLSearchParams();
    if (params.draft !== undefined) searchParams.set("draft", String(params.draft));
    if (params.prerelease !== undefined) searchParams.set("pre-release", String(params.prerelease));
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/releases${query ? `?${query}` : ""}`;
    return this.request<Release[]>("GET", path);
  }

  async getRelease(owner: string, repo: string, id: number): Promise<Release> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}`;
    return this.request<Release>("GET", path);
  }

  async getReleaseByTag(owner: string, repo: string, tag: string): Promise<Release> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`;
    return this.request<Release>("GET", path);
  }

  async createRelease(params: CreateReleaseParams): Promise<Release> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/releases`;
    return this.request<Release>("POST", path, {
      tag_name: params.tag_name,
      name: params.name,
      body: params.body,
      target_commitish: params.target_commitish,
      draft: params.draft,
      prerelease: params.prerelease,
    });
  }

  async updateRelease(params: UpdateReleaseParams): Promise<Release> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/releases/${params.id}`;
    return this.request<Release>("PATCH", path, {
      tag_name: params.tag_name,
      name: params.name,
      body: params.body,
      target_commitish: params.target_commitish,
      draft: params.draft,
      prerelease: params.prerelease,
    });
  }

  async deleteRelease(owner: string, repo: string, id: number): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}`;
    return this.request<void>("DELETE", path);
  }

  // ── Repository ──

  async getRepo(owner: string, repo: string): Promise<Repo> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return this.request<Repo>("GET", path);
  }

  async updateRepo(params: UpdateRepoParams): Promise<Repo> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    return this.request<Repo>("PATCH", path, {
      name: params.name,
      description: params.description,
      website: params.website,
      private: params.private,
      default_branch: params.default_branch,
    });
  }

  // ── Wiki ──

  /** Decode the API's base64 page payload into the plain-text WikiPage shape. */
  private static decodeWikiPage(raw: WikiPageResponse): WikiPage {
    return {
      title: raw.title,
      content: Buffer.from(raw.content_base64 ?? "", "base64").toString("utf-8"),
      footer: raw.footer,
      sidebar: raw.sidebar,
      html_url: raw.html_url,
      sub_url: raw.sub_url,
      commit_count: raw.commit_count,
      last_commit: raw.last_commit,
    };
  }

  async listWikiPages(params: ListWikiPagesParams): Promise<WikiPageMeta[]> {
    const searchParams = new URLSearchParams();
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/wiki/pages${query ? `?${query}` : ""}`;
    return this.request<WikiPageMeta[]>("GET", path);
  }

  async getWikiPage(owner: string, repo: string, pageName: string): Promise<WikiPage> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/wiki/page/${encodeURIComponent(pageName)}`;
    const raw = await this.request<WikiPageResponse>("GET", path);
    return GiteaClient.decodeWikiPage(raw);
  }

  async createWikiPage(params: CreateWikiPageParams): Promise<WikiPage> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/wiki/new`;
    const raw = await this.request<WikiPageResponse>("POST", path, {
      title: params.title,
      content_base64: Buffer.from(params.content, "utf-8").toString("base64"),
      message: params.message,
    });
    return GiteaClient.decodeWikiPage(raw);
  }

  async updateWikiPage(params: UpdateWikiPageParams): Promise<WikiPage> {
    const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/wiki/page/${encodeURIComponent(params.pageName)}`;
    const raw = await this.request<WikiPageResponse>("PATCH", path, {
      title: params.title,
      content_base64:
        params.content === undefined
          ? undefined
          : Buffer.from(params.content, "utf-8").toString("base64"),
      message: params.message,
    });
    return GiteaClient.decodeWikiPage(raw);
  }

  async deleteWikiPage(owner: string, repo: string, pageName: string): Promise<void> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/wiki/page/${encodeURIComponent(pageName)}`;
    return this.request<void>("DELETE", path);
  }

  async listWikiRevisions(
    owner: string,
    repo: string,
    pageName: string,
    page?: number,
  ): Promise<WikiRevisionList> {
    const searchParams = new URLSearchParams();
    if (page) searchParams.set("page", String(page));

    const query = searchParams.toString();
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/wiki/revisions/${encodeURIComponent(pageName)}${query ? `?${query}` : ""}`;
    return this.request<WikiRevisionList>("GET", path);
  }

  // ── Projects (placeholder — no HTTP) ──

  /**
   * Always returns an empty list. Gitea does not yet ship a REST API for
   * repository project boards (go-gitea/gitea#36824), so rather than calling a
   * nonexistent endpoint we return `[]` locally. The day the upstream API
   * lands, wiring the real call is a one-line change inside this method — no
   * contract churn for callers.
   */
  async listProjects(_params: ListProjectsParams): Promise<Project[]> {
    return [];
  }

  /**
   * Always reports "not found" for the requested project. Gitea does not yet
   * ship a REST API for repository project boards (go-gitea/gitea#36824), so
   * the project cannot exist from the API's perspective. The thrown error
   * carries HTTP 404 semantics — the same way `getIssue` surfaces a missing
   * issue — so MCP clients see a consistent not-found signal. When the upstream
   * API lands, replace the body with a real `this.request` call.
   */
  async getProject(params: GetProjectParams): Promise<Project> {
    throw new GiteaApiError(
      404,
      "Not Found",
      `project ${params.id} not found in ${params.owner}/${params.repo} — Gitea has no projects REST API yet (go-gitea/gitea#36824)`,
    );
  }
}
