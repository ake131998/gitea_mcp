# Tool cookbook — task → tool recipes

Quick recipes for common goals. Always resolve owner/repo first (explicit args,
`GITEA_DEFAULT_OWNER`/`REPO`, or `resolve_repo`).

## Discover where to work
- One local repo → `resolve_repo({})` once, reuse `{owner, repo}`.
- Across all repos → `list_my_repos({ page: 1, limit: 20 })`, page as needed.

## Read / report
- One issue's full picture → `get_issue` then `list_comments` (mind: list_comments
  is one default page; long threads may be truncated).
- All open issues in a repo → `list_issues({ state: "open", page: 1, limit: 50 })`,
  page until a page returns < 50.
- Issues across repos by keyword / duplicate check → `search_issues({ query, type:
  "issues" })`.
- Milestone progress → `list_milestones({ state: "all" })` (default omits closed!).
- Repository topics → `list_topics({})` (returns `{ topics: string[] }`).

## Create
- New issue with labels → `list_labels` (to get ids) → `create_issue({ title, body,
  labels: [ids] })`. Or create then `add_issue_labels([names])`.

## Edit (non-destructive)
- Change title/body/assignee → `update_issue` (PATCH; only given fields change).
- Add ONE label → `add_issue_labels(["name"])` (additive, by name).
- Remove ONE label → `remove_issue_label(id)` (by id).

## Destructive (confirm first)
- Close an issue → `update_issue({ state: "closed" })` (preferred over delete).
- Delete an issue → `delete_issue` (irreversible).
- Replace all labels → `replace_issue_labels(["a","b"])` (overwrites whole set).
- Clear all labels → `clear_issue_labels`.
- Delete a label → `delete_label(id)` (removes from EVERY issue).
- Delete a milestone → prefer `update_milestone({ state: "closed" })`; `delete_milestone`
  detaches its issues (they keep existing, milestone becomes null).

## Topics (repo tags)
- See current topics → `list_topics({})`.
- Add ONE → `add_topic({ topic: "go" })` (idempotent; lowercase letters/digits/hyphens,
  start with a letter/digit, max 35 chars).
- Remove ONE → `remove_topic({ topic: "go" })` (idempotent delete).
- Set the exact set / bulk update → `list_topics` first, then
  `replace_topics({ topics: ["go","mcp"] })` — REPLACES the whole set; pass `[]` to
  clear. Confirm with the user before replacing.

## Pull requests
- List a repo's open PRs → `list_pull_requests({ state: "open", page: 1, limit: 50 })`,
  page until a page returns < 50. Filter by `labels` (names) or `sort`.
- PRs across repos by keyword → `search_issues({ type: "pulls", query })`.
- One PR's full picture → `get_pull_request` (check `mergeable`, `merged`, `draft`),
  then `list_pull_commits` + `list_pull_files` for scope, then `list_comments` for
  the review thread (PR #N == Issue #N — comments are shared; one default page).
- Create a PR → `create_pull_request({ title, head, base, body? })`. Prefix title
  with `WIP:` while in progress. For forks use `"owner:branch"` in `head`. Link an
  issue with `Closes #123` in the body.
- Edit a PR → `update_pull_request({ index, title?, body?, state? })`. `state:
  "closed"` closes WITHOUT merging. Remove the `WIP:` prefix to mark ready.
- Merge a PR (IRREVERSIBLE) → `is_pull_merged` first; `get_pull_request` to confirm
  `mergeable: true`; get user approval; then `merge_pull_request({ index, Do })`.
  `Do`: `merge` / `squash` / `rebase` / `rebase-merge`.

## Pagination pattern (all list tools)
```
page = 1
loop:
  res = list_X({ ..., page, limit })
  process(res)
  if res.length < limit: break
  page += 1
```

## Error triage
- 401/403 → token scope/expiry. Ask user; don't loop.
- 404 → wrong owner/repo or no permission.
- 409 → conflict (e.g. duplicate label name).
- 422 → validation (bad color, malformed date).
