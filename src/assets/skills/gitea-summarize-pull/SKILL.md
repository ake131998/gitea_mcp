---
name: gitea-summarize-pull
description: Invoke to READ and SUMMARIZE a pull request — the PR body, commits, changed files, and comment thread. Produces a review-oriented summary (what it changes, mergeability, open questions). Do NOT invoke to create/edit/merge/close a PR (gitea-create-pull / gitea-update-pull / gitea-merge-pull), or to post a comment (gitea-comment-issue).
---

# gitea-summarize-pull

Read a pull request and its discussion, then synthesize. Tools: `get_pull_request`, `list_pull_commits`, `list_pull_files`, `list_comments`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo).

## Flow
1. `get_pull_request({ index })` — `index` = PR `number` (URL #N → N), never the internal `id`. Read title, body, `base`/`head`, `mergeable`, `merged`, `draft`, labels, milestone.
2. `list_pull_commits({ index })` — the commit history (page if `length === limit`).
3. `list_pull_files({ index })` — the diff scope: filenames, statuses, additions/deletions (page if `length === limit`).
4. `list_comments({ index })` — the review discussion. PR #N == Issue #N — the comment endpoints are shared.

## list_comments — TRUNCATION TRAP
- This tool passes NO page/limit and returns at most the server's default page size. For long review threads the list is SILENTLY TRUNCATED. If the `comments` count (from `get_pull_request`) exceeds the number returned, warn that part of the thread is missing and do NOT claim a complete summary.

## Synthesis
- Report: the PR state (open/closed/merged/draft), WHAT it changes (from commits + files), the mergeability/conflict status, then the thread's consensus / decisions / open questions. Attribute by author. Flag unresolved review feedback or blocking questions explicitly — do not paper over disagreement. End with one recommended NEXT ACTION (merge / request changes / close).
