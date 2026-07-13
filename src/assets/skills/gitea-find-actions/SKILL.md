---
name: gitea-find-actions
description: Invoke to DISCOVER or READ Gitea Actions workflow runs — listing runs in one repo (filtered by status/branch/event/actor) or reading a single run's detail. Do NOT invoke to cancel (gitea-cancel-action), rerun (gitea-rerun-action), or to manage issues/pull requests.
---

# gitea-find-actions

Read-only Gitea Actions workflow run discovery. Tools: `list_action_runs`, `get_action_run`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo). Never guess — wrong values 404 or silently target the wrong repo.
- Actions requires Gitea 1.20+ with Actions enabled; the rerun endpoints require Gitea 1.26.0+.

## Choose the tool
- LIST runs in one repo, filtered by status/branch/event/actor → `list_action_runs`.
- ONE run's full detail (status, conclusion, timestamps, actor) → `get_action_run`.

## list_action_runs
- RULES: the response is a WRAPPER object `{ workflow_runs: [...], count: number }` — the runs live under `workflow_runs`, NOT at the top level. Paginate 1-based, `limit` <= 100. A page is final ONLY when `workflow_runs.length < limit`.
- FILTERS: `status` accepts pending, queued, waiting, in_progress, running, success, failure, skipped, cancelled. `actor` is the username that triggered the run. `event` is the trigger (push, pull_request, schedule, etc.). `head_sha` filters by commit.
- CHECK AFTER: if `workflow_runs.length === limit`, fetch the next page before treating the list as complete.

## get_action_run
- RULES: pass `runId` = the numeric run ID from `list_action_runs` or the Gitea web UI URL. Never confuse it with a workflow name, issue number, or job ID.
- NOTE: the response carries `status` (current state) and `conclusion` (final outcome, set only after completion). Check these before cancel (gitea-cancel-action) or rerun (gitea-rerun-action):
  - Cancel only valid on ACTIVE runs: status in (queued, waiting, in_progress, running, pending).
  - Rerun only valid on COMPLETED runs: status in (success, failure, cancelled, skipped).
