---
name: gitea-rerun-action
description: "Invoke to RERUN a completed Gitea Actions workflow run — either the entire run or only its failed jobs. The flow confirms the run has completed and is rerunnable first, then reruns after user approval. When to use: rerun or retry a completed workflow run, or only its failed jobs; 中文触发：重跑/重试已结束的 workflow、CI，或只重试失败的任务/job. Do NOT invoke to cancel (gitea-cancel-action), find/read runs (gitea-find-actions), or manage issues/pull requests."
---

# gitea-rerun-action

## When to use

Trigger when the user asks to **rerun / retry a workflow run or failed CI jobs** — 中文请求如「重跑一下这个 CI」「再跑一次流水线」「只重试失败的 job」也 MUST 走本 skill：先确认运行已结束，经用户批准后再重跑。

Rerun one completed Actions workflow run. Tools: `get_action_run`, `rerun_action_run`, `rerun_action_run_failed_jobs`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo).
- Requires Gitea 1.26.0+ for the rerun endpoints. Rerunning consumes CI minutes and resources — always confirm the runId, the rerun scope (full vs failed-only), and the user's intent BEFORE calling either rerun tool.

## Flow
1. CHECK STATUS: `get_action_run({ runId })` — verify the run has COMPLETED (status is one of: success, failure, cancelled, skipped). If still ACTIVE (queued, waiting, in_progress, running, pending), STOP — cannot rerun an active run; use gitea-cancel-action if you want to stop it first.
2. CHOOSE SCOPE:
   - `rerun_action_run` — reruns the ENTIRE run (all jobs, regardless of prior success/failure). Use when the run is fundamentally broken or you need a clean re-run.
   - `rerun_action_run_failed_jobs` — reruns ONLY the jobs that failed. More efficient when most jobs succeeded; preserves the successful job results. The run must have conclusion "failure" for this to make sense.
3. CONFIRM: state the runId, display_title, conclusion, and the chosen scope, then ask the user for explicit approval.
4. RERUN: `rerun_action_run({ runId })` or `rerun_action_run_failed_jobs({ runId })`.
5. VERIFY (optional): call `list_action_runs` to find the new run (it will have an incremented `run_attempt`).

## rerun_action_run
- RULES: `runId` is the numeric run ID. Only COMPLETED runs can be reruned. Creates a NEW run; the original is not modified. Returns the new run object or a text confirmation.
- CHECK FIRST: `get_action_run` (step 1) + scope decision (step 2) + user confirmation (step 3).

## rerun_action_run_failed_jobs
- RULES: same as rerun_action_run but only re-executes failed jobs. Only meaningful when the run's conclusion is "failure". Returns a text confirmation.
- CHECK FIRST: `get_action_run` to confirm the run has failed jobs + user confirmation.

## Error handling
- 400/409: the run may still be active or not rerunnable — re-read `get_action_run` and do NOT retry blindly.
- 404: wrong runId or repo — verify with `list_action_runs`.
