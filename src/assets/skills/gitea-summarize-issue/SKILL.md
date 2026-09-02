---
name: gitea-summarize-issue
description: "Invoke to READ and SUMMARIZE an issue's discussion — the issue body plus its comment thread. When to use: read and summarize an issue's body and comment thread; 中文触发：总结/梳理/概括 issue 的内容与讨论、评论串. Do NOT invoke to edit an issue (gitea-update-issue), post a comment (gitea-comment-issue), or manage labels/milestones."
---

# gitea-summarize-issue

## When to use

Trigger when the user asks to **summarize / digest an issue's discussion** — 中文请求如「总结一下这个 issue」「这个 issue 讨论到哪了」也 MUST 走本 skill。

Read an issue and its discussion, then synthesize. Tools: `get_issue`, `list_comments`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo).

## Flow
1. `get_issue({ index })` — `index` = issue `number` (URL #N → N), never the internal `id`. The `comments` field is only a COUNT.
2. `list_comments({ index })` — returns the comment thread, oldest-first.

## list_comments — TRUNCATION TRAP
- This tool passes NO page/limit and returns at most the server's default page size. For long threads the list is SILENTLY TRUNCATED. If the `comments` count (from `get_issue`) exceeds the number returned, warn that part of the thread is missing and do NOT claim a complete summary.

## Synthesis
- Report the issue state (open/closed), the body's ask, then the thread's consensus / decision / open questions. Attribute by author. Flag unresolved disagreement explicitly — do not paper over it.
