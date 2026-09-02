---
name: gitea-plan-milestones
description: "Invoke to CREATE, EDIT, or CLOSE a Gitea milestone, or to list/inspect milestones for planning. When to use: create, edit, close, or list milestones, or plan releases/iterations; 中文触发：创建/修改/关闭/查看里程碑（milestone）、做版本/迭代规划. Do NOT invoke to delete a milestone (destructive — no skill) or to set an issue's milestone (that is gitea-update-issue)."
---

# gitea-plan-milestones

## When to use

Trigger when the user asks about **milestones or release/iteration planning** — 中文请求如「建一个 v1.2 里程碑」「看看里程碑进度」「关闭这个迭代」也 MUST 走本 skill。

Create / edit / close milestones. Tools: `list_milestones`, `get_milestone`, `create_milestone`, `update_milestone`.

## Prerequisites
- Resolve `owner`+`repo`: pass explicitly, else `GITEA_DEFAULT_OWNER`/`GITEA_DEFAULT_REPO`, else `resolve_repo` (gitea-resolve-repo).

## list_milestones — DEFAULT-OPEN TRAP
- Default returns ONLY open milestones. Pass `state: "all"` or `state: "closed"` to see the rest, or you will silently miss closed/completed milestones. Paginate 1-based, `limit` ≤ 100.

## create_milestone
- RULES: `title` required; `description` optional; `due_on` = ISO 8601 (e.g. `2025-12-31T23:59:59Z`). Returns the new milestone including its `id`.

## update_milestone
- RULES: identifies by `id` (number). PATCH — only `title` / `description` / `due_on` / `state` you pass change; omit = unchanged. State is `open` | `closed`.
- NOTE: CLOSING a milestone does NOT close its issues — they stay open. Close issues separately (gitea-update-issue) before or after.

## get_milestone
- Read one milestone by `id`: includes `open_issues` / `closed_issues` counts for progress (progress = closed / (open + closed)).

## Description template — standardize what you write into `description`
Milestones succeed when scope is explicit. When creating or editing, structure `description` with this template; keep it short and drop empty sections.

```markdown
**Goal:** <the single outcome this milestone delivers>

**Scope**
- In: <what this milestone covers>
- Out: <what is explicitly deferred>

**Acceptance criteria**
- <observable, checkable condition>
- <observable, checkable condition>

**Owners:** <who is accountable>
```
