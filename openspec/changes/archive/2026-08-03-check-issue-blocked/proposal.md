## Why

AI clients need a single-call verdict on whether an issue is blocked by open dependencies. Today they must call `list_issue_dependencies` (possibly paginated) and manually filter each dependency's `state` field, burning context and round-trips for a question that deserves one call.

## What Changes

- Add a `check_issue_blocked` MCP tool that returns a structured verdict — `blocked`, `blockers`, `total_dependencies`, `open_blockers` — in a single call.
- `tools.ts`: add `CheckIssueBlockedSchema` (owner/repo/index only; no page/limit — pagination is internal).
- `gitea-client.ts`: add `CheckIssueBlockedParams` + `IssueBlockedResult` interfaces and a `checkIssueBlocked` method that loops `listIssueDependencies` until all dependencies are collected, filters for `state !== "closed"`, and assembles the result.
- `server.ts`: register the `check_issue_blocked` tool with a description covering purpose, return shape, relationship to `list_issue_dependencies`, and the `enable_issue_dependencies` 404 precondition.
- `README.md` / `README.zh-CN.md`: add the tool row to the Issue Dependencies table.

## Capabilities

### New Capabilities

- `issue-dependency-check`: single-call blocked-state detection for issues, aggregating the full dependency list and reporting open blockers.

### Modified Capabilities

None — this is the first OpenSpec capability in the repository.

## Impact

- Code: `src/tools.ts`, `src/gitea-client.ts`, `src/server.ts`.
- Docs: `README.md`, `README.zh-CN.md`.
- Tests: `src/__tests__/gitea-client.test.ts` (client method: empty/open/closed/mixed/pagination cases), `src/__tests__/tools.test.ts` (schema), `src/__tests__/server.test.ts` (registration + handler).
- Dependencies: none added; relies on the existing `request<T>` infrastructure and the global `fetch`.
- Error behavior: a 404 from the dependency endpoint (repo has `enable_issue_dependencies` off) propagates as `GiteaApiError` unchanged.
