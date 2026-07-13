# Gitea object field reference

The shapes of the JSON objects these tools return (verbatim from the Gitea API).
Use this to read results correctly and pick the right identifier.

## Issue
- `id` (number) — internal id. NOT used by tools; tools use `number`.
- `number` (number) — the issue index shown in the URL (#42). This is the `index`
  passed to get_issue / update_issue / delete_issue / comments tools.
- `title` (string), `body` (string?), `state` ("open" | "closed")
- `html_url`, `url` (string)
- `comments` (number) — comment COUNT, not the comments themselves
- `labels` (Label[])
- `assignee` (User?), `assignees` (User[]?)
- `milestone` (Milestone?)
- `repository` (Repository) — present on search_issues results
- `created_at`, `updated_at` (string ISO); `closed_at` (string?, when closed)

## Label
- `id` (number) — used by remove_issue_label / update_label / delete_label
- `name` (string) — used by add_issue_labels / replace_issue_labels
- `color` (string) — 6-digit hex, with or without "#"
- `description` (string?)

## User
- `id` (number), `login` (string), `full_name` (string?), `avatar_url` (string),
  `email` (string?)

## Milestone
- `id` (number) — used by get/update/delete_milestone; also the `milestone` value on
  create/update_issue
- `title` (string), `description` (string?), `state` ("open" | "closed")
- `open_issues` (number), `closed_issues` (number) — counts for progress
- `due_on` (string?, ISO)

## Comment
- `id` (number) — used by update_comment / delete_comment. NOT the issue number.
- `body` (string) — Markdown
- `html_url` (string), `created_at`, `updated_at` (string ISO)
- `user` (User) — comment author

## Repository (embedded on issues)
- `id` (number), `full_name` (string "owner/repo"), `name` (string),
  `owner` ({ login: string })

## Repo (from list_my_repos)
- `id`, `full_name`, `name`, `owner` (User), `description?`, `html_url`,
  `default_branch?`, `created_at`, `updated_at`

## Topic list (from list_topics / replace_topics)
- `topics` (string[]) — the repository's topic names. Each name is lowercase
  letters, digits, and hyphens, starting with a letter/digit, max 35 chars.
  `replace_topics` sends this object back to SET the whole set (empty array
  clears all topics); `add_topic` / `remove_topic` operate on a single name and
  return no body.

## PullRequest (from list_pull_requests / get_pull_request / create / update)
- `id` (number) — internal id. NOT used by tools; tools use `number`.
- `number` (number) — the PR index shown in the URL (#42). This is the `index`
  passed to get/update/merge_pull_request and list_pull_commits/files. Shares the
  number space with issues (PR #N == Issue #N — comments/labels reuse issue tools).
- `title` (string), `body` (string?), `state` ("open" | "closed")
- `html_url`, `url` (string)
- `labels` (Label[]), `assignee` (User?), `assignees` (User[]?), `milestone` (Milestone?)
- `user` (User) — PR author
- `base` / `head` (PullRequestBranch) — `{ label, ref, sha, repo }`. `head.ref` is the
  source branch; `base.ref` is the target branch.
- `merged` (boolean?) — whether the PR has been merged
- `merged_at` (string?, ISO) — merge timestamp
- `mergeable` (boolean?) — whether Gitea can auto-merge (no conflicts). Check before
  calling merge_pull_request.
- `draft` (boolean?) — draft / WIP status
- `created_at`, `updated_at` (string ISO); `closed_at` (string?, when closed)

## PullCommit (from list_pull_commits)
- `sha` (string), `html_url` (string)
- `commit.message` (string), `commit.author` ({ name, email, date? })
- `author` (User?) — the Gitea user, if linked

## PullFile (from list_pull_files)
- `sha` (string), `filename` (string) — path in the repo
- `status` (string) — "added" | "modified" | "deleted" | "renamed" | "copied"
- `additions`, `deletions`, `changes` (number) — line counts
- `html_url` (string) — link to the diff
