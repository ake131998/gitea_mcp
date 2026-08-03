## 1. Schema

- [x] 1.1 Add `CheckIssueBlockedSchema` to `src/tools.ts` at the end of the `// ── Issue Dependencies ──` section (owner/repo optional, `index` required int ≥ 1, no page/limit)

## 2. Client method

- [x] 2.1 Add `CheckIssueBlockedParams` + `IssueBlockedResult` interfaces to `src/gitea-client.ts`
- [x] 2.2 Add `checkIssueBlocked` method to `GiteaClient`: loop `listIssueDependencies` (page from 1, limit 100, stop when a page returns fewer than limit), filter `state !== "closed"`, assemble `IssueBlockedResult`

## 3. Server registration

- [x] 3.1 Import `CheckIssueBlockedSchema` in `src/server.ts`
- [x] 3.2 Register `check_issue_blocked` at the end of the Issue Dependencies tool group with a description covering purpose, return shape, relationship to `list_issue_dependencies`, and the `enable_issue_dependencies` 404 precondition

## 4. Documentation

- [x] 4.1 Add `check_issue_blocked` row to the Issue Dependencies table in `README.md`
- [x] 4.2 Add the corresponding Chinese row in `README.zh-CN.md`

## 5. Tests

- [x] 5.1 Add `checkIssueBlocked` cases to `src/__tests__/gitea-client.test.ts`: no dependencies, open dependencies, all closed, mixed states, pagination across pages, request path/pagination params, 404 propagation
- [x] 5.2 Add `CheckIssueBlockedSchema` parsing tests to `src/__tests__/tools.test.ts` (`index` required, minimum 1)
- [x] 5.3 Add `check_issue_blocked` registration + handler test to `src/__tests__/server.test.ts`

## 6. Verification

- [x] 6.1 `make lint` passes (real emit, covers tests)
- [x] 6.2 `make build` passes
- [x] 6.3 `make test` passes with all existing tests green
- [x] 6.4 Runtime smoke of built `dist/` and coverage > 80%
