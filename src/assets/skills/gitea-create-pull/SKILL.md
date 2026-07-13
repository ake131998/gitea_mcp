---
name: gitea-create-pull
description: Invoke to CREATE / OPEN a new Gitea pull request. The flow confirms the branch exists and checks for an existing open PR on the same head/base first, then creates. Do NOT invoke to edit/close (gitea-update-pull), merge (gitea-merge-pull), read/find (gitea-find-pulls), or post a review comment (gitea-comment-issue).
---

# gitea-create-pull

Open one new pull request after ruling out a duplicate. Tools: `list_pull_requests`, `create_pull_request`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo). Never guess — wrong values create the PR in the wrong repo.
- The `head` (source) branch MUST already exist and contain the commits to merge; the `base` (target) branch is typically the default branch.

## Flow
1. DUPLICATE CHECK (always first): `list_pull_requests({ state: "open" })`. If an open PR with the same `head`/`base` already exists, comment on it (gitea-comment-issue) instead of creating a duplicate. Do NOT skip this — creation does not de-duplicate.
2. CREATE: `create_pull_request({ title, head, base, body? })`.

## create_pull_request
- RULES: `title`, `head`, and `base` are required. For cross-fork PRs use `"owner:branch"` in `head` (e.g. `"ake131998:feat/my-change"`). `body` is Markdown.
- Do NOT pass `labels` or `milestone` here: `labels` expect IDs (error-prone). Create WITHOUT them, then attach labels by name via `add_issue_labels` (gitea-label-issue — PR #N == Issue #N) and set the milestone via `update_pull_request`.
- WIP / draft: Gitea blocks merges when the title starts with `WIP:`, `[WIP]`, or `Draft:`. Prefix the title while work is in progress; remove the prefix when ready to merge (gitea-update-pull).
- CHECK FIRST: confirm no duplicate open PR (step 1), that `head` exists and is pushed, and that `owner`/`repo` are correct before writing.
- CHECK AFTER: the returned object's `number` is the new PR index; `mergeable` indicates whether Gitea can auto-merge it.

## Body template — standardize what you write into `body`
Always structure `body`. Ask the user for details if the change is not obvious. Drop a section only when it is genuinely empty; never invent data.

```markdown
## Summary
<1-2 sentences: what this PR changes and why>

## Changes
- <bullet: specific change>
- <bullet: specific change>

## Related issues
Closes #<issue number>

## Checklist
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Breaking changes noted below

## Breaking changes
<none, or describe>
```

Use `Closes #123` / `Fixes #123` in the body to auto-close the linked issue when the PR merges.
