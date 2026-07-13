---
name: gitea-cancel-action
description: Invoke to CANCEL one active Gitea Actions workflow run. PARTIALLY DESTRUCTIVE — active jobs are killed and partial results discarded. The flow confirms the run is still active first, then cancels after user approval. Do NOT invoke to rerun (gitea-rerun-action), find/read runs (gitea-find-actions), or manage issues/pull requests.
---

# gitea-cancel-action

Cancel one active Actions workflow run. PARTIALLY DESTRUCTIVE. Tools: `get_action_run`, `cancel_action_run`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo).
- Cancellation kills in-progress jobs; partial results and logs are NOT preserved. Always confirm the runId and the user's intent BEFORE calling `cancel_action_run`.

## Flow
1. CHECK STATUS: `get_action_run({ runId })` — verify the run is still ACTIVE (status is one of: queued, waiting, in_progress, running, pending). If the run has already completed (status is success, failure, cancelled, or skipped), STOP — cancelling a finished run returns an error.
2. CONFIRM: state the runId, display_title, current status, and how long it has been running, then ask the user for explicit approval.
3. CANCEL: `cancel_action_run({ runId })`.
4. VERIFY (optional): call `get_action_run({ runId })` again to confirm the conclusion is now "cancelled".

## cancel_action_run
- RULES: `runId` is the numeric run ID from list_action_runs or the Gitea web UI — never confuse it with a workflow name, issue number, or job ID.
- Only ACTIVE runs can be cancelled. Attempting to cancel a completed run returns an error.
- The API returns 204 No Content on success — the tool returns a text confirmation.
- CHECK FIRST: `get_action_run` (step 1) + user confirmation (step 2).
- CHECK AFTER: if it errors with 400/409, the run may have already completed — re-read `get_action_run` and do NOT retry blindly.
