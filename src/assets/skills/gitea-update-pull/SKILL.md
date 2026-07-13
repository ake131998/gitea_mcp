---
name: gitea-update-pull
description: Invoke to EDIT fields, CLOSE (without merging), REOPEN, retarget, or toggle WIP on ONE existing Gitea pull request. Do NOT invoke to create (gitea-create-pull), merge (gitea-merge-pull — destructive), find/read (gitea-find-pulls), or change a single label (gitea-label-issue).
---

# gitea-update-pull

Edit one pull request's fields or change its state. Tools: `get_pull_request`, `update_pull_request`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo).
- There is NO optimistic locking — always read current state first.

## Flow
1. READ CURRENT: `get_pull_request({ index })` — `index` = PR `number` (URL #N → N), never the internal `id`.
2. APPLY: `update_pull_request({ index, ...changedFields })`.

## update_pull_request
- RULES: PATCH — only fields you pass change; omit = unchanged. To CLEAR a field pass its EMPTY form, do NOT omit it: `milestone: 0` clears the milestone, `assignees: []` clears assignees. Use `assignees` (array), not the deprecated `assignee`. State values are `open` | `closed`.
- CLOSE WITHOUT MERGING: `update_pull_request({ index, state: "closed" })`. This closes the PR but does NOT merge it — the commits stay on the `head` branch. Reopen later with `state: "open"`.
- WIP TOGGLE: to mark work-in-progress, prefix the title with `WIP:` or `[WIP]`. To mark ready, remove the prefix. Pass the full new `title`.
- RETARGET: `base` changes the target branch. RARELY REVERSIBLE — confirm with the user before retargeting; it can invalidate reviews and conflict checks.
- NOT FOR single-label changes: `labels` here are IDs and REPLACE the entire set — to add/remove one label use `add_issue_labels` / `remove_issue_label` (gitea-label-issue, PR #N == Issue #N).
- CHECK FIRST: `get_pull_request` for current values if state may have changed since your last read; state the intended change to the user before writing.
