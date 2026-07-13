---
name: gitea-merge-pull
description: Invoke to MERGE one Gitea pull request after confirming it is mergeable and the user has explicitly approved the strategy. IRREVERSIBLE. Do NOT invoke to create (gitea-create-pull), edit/close without merging (gitea-update-pull), find/read (gitea-find-pulls), or check merge status only (gitea-find-pulls get_pull_request).
---

# gitea-merge-pull

Merge one pull request. IRREVERSIBLE. Tools: `get_pull_request`, `is_pull_merged`, `merge_pull_request`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo).
- This is DESTRUCTIVE and IRREVERSIBLE — merging is final. Always confirm the index, the strategy, and the user's approval BEFORE calling `merge_pull_request`.

## Flow
1. CHECK MERGED: `is_pull_merged({ index })` — if already merged, STOP and report; do not attempt a redundant merge.
2. CHECK MERGEABLE: `get_pull_request({ index })` — confirm `mergeable: true`, `state: "open"`, and that the PR is not `draft` or WIP-titled. If `mergeable` is false or null, STOP — conflicts must be resolved on the branch first.
3. CONFIRM: state the index, the chosen `Do` strategy, and ask the user for explicit approval.
4. MERGE: `merge_pull_request({ index, Do, MergeTitleField?, MergeMessageField?, SHA? })`.

## merge_pull_request
- RULES: `Do` is required and selects the strategy:
  - `merge` — creates a merge commit (preserves all individual commits).
  - `squash` — squashes all commits into one on the base branch.
  - `rebase` — rebases commits onto the base branch, then fast-forwards.
  - `rebase-merge` — rebases commits, then creates a merge commit.
- `MergeTitleField` / `MergeMessageField` customize the merge commit message. `SHA` pins the expected HEAD — the merge FAILS if the branch moved since (guards against racing pushes).
- CHECK FIRST: `is_pull_merged` (step 1) + `get_pull_request` `mergeable` (step 2) + user confirmation (step 3).
- CHECK AFTER: the tool returns a text confirmation. If it errors with 409, the PR is not mergeable (conflicts or already merged) — re-read `get_pull_request` and do NOT retry blindly.
