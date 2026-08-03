## Context

`gitea-mcp` exposes issue dependency tools (`list_issue_dependencies` etc.) whose results are paginated. AI clients wanting a "is this issue blocked?" answer must page through the dependency list themselves and filter by `state`. This change adds `check_issue_blocked` — a single-call aggregator. The codebase follows a strict module split (AGENTS.md §2.5): `tools.ts` holds only Zod schemas, `gitea-client.ts` only the REST client, `server.ts` only MCP composition. Adding a tool is a coordinated four-file change (docs/architecture.md §5.4).

## Goals / Non-Goals

**Goals**

- Return `{ index, blocked, blockers, total_dependencies, open_blockers }` in one call.
- Handle pagination internally with a fixed page size of 100 (the API max).
- Keep the server handler a thin `resolve(input)` → `client.method(...)` → `JSON.stringify` wrapper, like every other handler.

**Non-Goals**

- No new endpoint or API surface; only a client-side aggregation over the existing `/issues/{index}/dependencies` endpoint.
- No caching, no concurrency, no changes to the existing paginated tools.
- No change to error semantics: a 404 (dependencies disabled) still propagates as `GiteaApiError`.

## Decisions

**1. Aggregation lives in the client method, not the handler.**
Pagination and filtering are HTTP-layer concerns, and the handler must stay consistent with all other handlers (`const data = await client.method(...)`).
*Alternative considered:* handler-side paging loop — rejected because it would duplicate the aggregation logic in `server.ts` and break the uniform handler pattern.

**2. The method loops the existing `listIssueDependencies`, not raw `request<T>`.**
Reuses the existing path building and `request<T>` infrastructure (auth header, error propagation, credential state machine). No direct `fetch` calls (AGENTS.md §2.2 / Issue constraint).

**3. `blockers` is typed as `Issue[]`, not a slimmed-down shape.**
The dependency endpoint already returns full `Issue` objects; reusing `Issue` avoids a new serialization layer and keeps `html_url`/`title`/`state` available for the client to render. The issue's example JSON shows only the commonly used fields, but the full object is a superset.

**4. Loop termination: stop when a page returns fewer than `limit` (100) items.**
This matches the documented pagination convention of the existing tools ("keep paging until a page returns fewer than `limit`"). Page numbers start at 1. An empty final page is a valid terminator, so no off-by-one risk.

**5. State filter is `state !== "closed"`.**
Per the issue's definition of "blocked" — a dependency counts as a blocker unless explicitly closed. Other states (open, and any future states) count as blocking.

## Risks / Trade-offs

- [Many pages → many sequential HTTP calls] → Mitigation: each page is a separate round-trip, but this is bounded in practice (dependency lists are small); same cost profile as a manual client loop, minus the client's own round-trips for aggregation.
- [Repo with dependencies disabled → 404 on first page] → Mitigation: propagate the `GiteaApiError` unchanged; the tool description documents this precondition so clients can react.
- [Dependency added between pages (no snapshot consistency)] → Mitigation: accepted; the existing API offers no transaction, and the verdict is a point-in-time view by design.

## Migration Plan

Pure additive change: new schema, new client method, new tool registration, new README rows. No changes to existing behavior, no data migration. Rollback = revert the PR.

## Open Questions

None — the issue specifies the interface and behavior precisely.
