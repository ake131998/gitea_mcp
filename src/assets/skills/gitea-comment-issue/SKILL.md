---
name: gitea-comment-issue
description: "Invoke to POST a new comment on a Gitea issue or pull request. The flow confirms the issue exists first, then posts. When to use: post, add, write, or reply with a comment on an issue or PR; 中文触发：在 issue/PR 上评论、留言、回复、补充说明. Do NOT invoke to edit or delete a comment (author/admin only, partly destructive — no skill), read or summarize the thread (gitea-summarize-issue), or edit the issue itself (gitea-update-issue)."
---

# gitea-comment-issue

## When to use

Trigger when the user asks to **comment / reply / leave a note on an issue or PR** — 中文请求如「在这个 issue 下评论一下」「回复这条 PR」「补充一句说明」也 MUST 走本 skill：先确认 issue 存在再发帖。

Post one new comment that advances an issue's discussion. Tools: `get_issue`, `create_comment`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo). Never guess — wrong values post to the wrong place.
- `index` = the issue `number` (URL #N → N), never the internal `id`.

## Flow
1. CONFIRM TARGET: `get_issue({ index })` — verify the issue exists and is the one you mean. Do NOT post blind.
2. POST: `create_comment({ index, body })`.

## create_comment
- RULES: `body` required, Markdown. The comment APPENDS to the thread — it never edits or replaces prior content. The response carries the comment `id`; retain it only if a follow-up `update_comment` / `delete_comment` is planned.
- CHECK FIRST: re-read the latest thread (gitea-summarize-issue) so your comment is not redundant or contradicting a newer message.
- CHECK AFTER: the comment appears with the returned `id`.

## Body template — standardize what you write into `body`
A useful comment is contextual, evidence-backed, and proposes a next step. Structure `body` with this template; drop sections that add nothing.

```markdown
**Context:** <the point you are responding to>

**Finding / proposal:** <what you discovered or suggest>

**Evidence:** <log excerpt, link, reproduction, or metric>

**Suggested next step:** <the concrete action you propose>
```
