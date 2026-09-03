# GitLab MCP — usage strategy

You manage GitLab issues, comments, labels, milestones, project topics, and
merge requests through this MCP server. This process serves **GitLab** (the
same tool names as the Gitea edition, backed by the GitLab REST API v4).
Every tool returns GitLab's JSON verbatim as text. Follow these rules to use
them correctly.

## Config is auto-discovered from git (env vars optional)

On start the server reads `<cwd>/.git/config` and derives `baseUrl`, `owner`,
and `repo` so one install can serve many projects. `GITLAB_REPO_URL` — one
credentialed clone URL (`https://<user>:<token>@<host>[:<port>]/<owner>/<repo>.git`) —
supplies instance, owner/repo, and a credential in a single variable, sitting
below the `GITLAB_BASE_URL` / `GITLAB_DEFAULT_OWNER` / `GITLAB_DEFAULT_REPO`
env vars (OPTIONAL overrides that win over git discovery); `GITLAB_TOKEN` is
one auth candidate, tried after the repo-URL userinfo and a
`.git/config [gitlab]` token and before git's credential machinery
(`git credential fill`). The remote is chosen `upstream` first, then `origin`.
If the cwd has no git remote and neither `GITLAB_BASE_URL` nor `GITLAB_REPO_URL`
is set, the server starts
in an **unconfigured** state — tools/list is available but business tools
return a `GitLabNotConfiguredError`. Use the **configure_gitlab** tool to set
the connection at runtime. Credentials are sent only as
`Authorization: Bearer <token>` — never as a URL query parameter.

## Addressing is per-resource (critical gotcha)

GitLab does not address everything by one number:

- Projects are the URL-encoded path (`owner%2Frepo`) — pass `owner` + `repo`
  and the client encodes them; issues and merge requests use the
  project-scoped `iid` (the number shown in the UI).
- Milestones and pipelines use their numeric **ID** (`milestone_id`), which
  differs from the milestone `iid`.
- Releases are addressed by `tag_name` — they carry no numeric ID, so
  `get_release` / `update_release` / `delete_release` (ID-based) are NOT
  supported; use `get_release_by_tag`, and treat `delete_release` /
  `update_release` as unavailable on GitLab.
- Wiki pages use the URL-encoded `slug` (`pageName` maps to it).

`list_issues` / `list_pull_requests` return GitLab objects (`iid`, `web_url`,
`references`, …) — read the fields actually present instead of assuming
Gitea's `number` / `html_url`.

## Tier-gated: issue blocking/dependencies

Issue dependency and block tools (`list_issue_dependencies`,
`add_issue_dependency`, `remove_issue_dependency`, `list_issue_blocks`,
`add_issue_block`, `remove_issue_block`, `check_issue_blocked`) use the
GitLab issue-links API. The `blocks` / `is_blocked_by` link types require
**GitLab Premium or Ultimate**; on GitLab Free these tools return a typed
`GitLabTierError`. Do not retry them on Free — direct the user to upgrade or
track the relationship in the issue description instead.

## Not available on GitLab (typed errors, not failures to fix)

- Issue attachments: GitLab has no attachments REST API —
  `*_issue_attachment*` tools return `GitLabUnsupportedError`.
- `update_comment` / `delete_comment`: GitLab notes are addressed per-issue
  (`/projects/:id/issues/:issue_iid/notes/:note_id`) and these tools carry no
  issue number; only `list_comments` / `create_comment` work.
- `rerun_action_run_failed_jobs`: pipelines retry as a whole — use
  `rerun_action_run`. "Actions runs" are GitLab **pipelines**; filter values
  follow the pipelines API (`ref`, `status`, `sha`, `username`).
- `merge_pull_request` with `Do: "rebase"` / `"rebase-merge"`: use `"merge"`
  or `"squash"`.
- Release `draft`/`prerelease` flags, `update_repo`'s `website`/`private`,
  wiki `message` fields, and `search_issues` with a `labels` filter have no
  GitLab counterpart and return `GitLabUnsupportedError`.

## Labels: names on GitLab, IDs at the edges

- `add_issue_labels`, `replace_issue_labels` → label **names**.
- `remove_issue_label` → label **ID** (`list_labels` first); the client
  translates the ID to GitLab's name-based removal.
- `create_issue` / `update_issue` / `create_pull_request` `labels` → label
  **IDs** (`number[]`), translated to names by the client — the label must
  already exist in the project.
- Label renames map to GitLab's `new_name`; a rename needs a name or color.

Assignees are GitLab **user IDs** on the wire: username arguments are resolved
through the project members API, so the user must be a project member.

## Comments use comment IDs, not issue numbers

`list_comments` returns each note's `id`; `create_comment` posts to the
issue. Comments are shared between issues and merge requests with the same
number (MR #N == Issue #N), mirroring the Gitea behavior.

## Pagination

List endpoints are 1-based: `page` starts at 1, `per_page` (the `limit`
argument) max 100, default page size 20. Page forward until a page returns
fewer than `limit` items. Do not assume one page is complete.

## Destructive operations — confirm before running

These are irreversible on most GitLab instances:

- `delete_issue`, `delete_label`, `delete_milestone`
- `clear_issue_labels`, `replace_issue_labels` (replaces the ENTIRE label set)
- `replace_topics` (replaces the ENTIRE topic set; pass `[]` to clear all)
- `merge_pull_request` (IRREVERSIBLE — confirm the iid and strategy)
- `delete_wiki_page` (recoverable only from the wiki git clone)

Confirm the target id/index and scope with the user before calling.

## Pull requests — merge requests

The `*_pull_request` tools operate on GitLab merge requests (iid-addressed).
Comments, labels, and milestones on an MR reuse the **issue** tools with the
same number. Close WITHOUT merging: `update_pull_request({ state: "closed" })`.
`merge_pull_request` is IRREVERSIBLE — check `is_pull_merged` first, confirm
mergeability via `get_pull_request`, and get explicit user approval before
merging. `is_pull_merged` reflects GitLab's `state === "merged"`.

## Search vs list

- `list_issues` — one repo, paginated, filterable by state/labels.
- `search_issues` — across ALL projects the token can see, via the GitLab
  global search API. It REQUIRES a `query` (no empty searches) and does not
  support label filters; `type: "pulls"` searches merge requests.

## Error format

Failed calls throw `GitLab API error (<status>): <body>`. Read the status:
401 → token missing or invalid; 403 → token lacks scope, or the endpoint is
tier-gated (see above); 404 → wrong project path, missing resource, or no
permission; 422 → validation. `GitLabUnsupportedError` / `GitLabTierError`
mean the operation has no Free-tier GitLab counterpart — do not retry.
