---
name: gitea-find-pulls
description: Invoke to DISCOVER or READ Gitea pull requests — listing one repo's PRs, cross-repo PR search, reading a single PR, its commits, or its changed files. Do NOT invoke to create/edit/close/merge (gitea-create-pull / gitea-update-pull / gitea-merge-pull), or to read the comment discussion (gitea-summarize-pull).
---

# gitea-find-pulls

Read-only pull request discovery. Tools: `list_pull_requests`, `search_issues`, `get_pull_request`, `list_pull_commits`, `list_pull_files`.

## Prerequisites
- Resolve `owner`+`repo` for `list_pull_requests`/`get_pull_request`/`list_pull_commits`/`list_pull_files`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo). Never guess — wrong values 404 or silently target the wrong repo.
- Paginate 1-based, `limit` ≤ 100. A page is final ONLY when it returns fewer than `limit` items. Always set `limit` (default page size is server-controlled).

## Choose the tool
- ONE repo's PRs, filtered by state/labels/sort/milestone → `list_pull_requests`.
- ACROSS repos by keyword → `search_issues({ type: "pulls" })` (global; no owner/repo).
- ONE PR's full detail (branches, mergeable, merged) → `get_pull_request`.
- Commits in one PR → `list_pull_commits`.
- Files changed in one PR → `list_pull_files`.

## list_pull_requests
- RULES: `labels` = comma-separated NAMES, AND-matched; a mistyped or non-existent name returns EMPTY with no error. `sort` options: `oldest`, `recentupdate`, `leastupdate`, `mostcomment`, `leastcomment`, `priority`. `state` default is `open`.
- CHECK FIRST: confirm label names via `list_labels` (gitea-manage-labels) before filtering by labels.
- CHECK AFTER: if `length === limit`, fetch the next page before treating the list as complete.

## search_issues
- RULES: GLOBAL — no owner/repo; each result carries its own `repository`. Set `type: "pulls"` to search only PRs. `labels` = names. `query` matches title + body.
- CHECK FIRST: set `type` deliberately.
- CHECK AFTER: page fully if completeness matters.

## get_pull_request
- RULES: pass `index` = the PR `number` (URL #42 → 42), never the internal `id`.
- NOTE: the response carries `mergeable` (boolean), `merged` (boolean), `merged_at`, `draft`, plus `base`/`head` branch objects. Check `mergeable` before attempting a merge (gitea-merge-pull).

## list_pull_commits / list_pull_files
- RULES: pass the PR `index`. Both paginate 1-based.
- Commits: each has `sha`, `html_url`, `commit.message`, optional `author`.
- Files: each has `filename`, `status` (added/modified/deleted/renamed), `additions`, `deletions`, `changes`, `html_url`.
- CHECK AFTER: if `length === limit`, fetch the next page.
