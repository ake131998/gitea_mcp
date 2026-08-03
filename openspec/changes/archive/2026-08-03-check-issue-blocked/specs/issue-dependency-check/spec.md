## ADDED Requirements

### Requirement: Single-call blocked verdict
The system SHALL provide a `check_issue_blocked` tool that returns, for a given issue, a structured verdict of whether it is blocked by open dependencies, together with the list of open blockers and dependency totals, in a single call.

#### Scenario: Issue with open dependency is blocked
- **WHEN** an issue has at least one dependency whose `state` is not `closed`
- **THEN** the tool returns `blocked: true` and that dependency is included in the `blockers` list

#### Scenario: Issue without open dependencies is not blocked
- **WHEN** an issue has no dependencies, or every dependency is `closed`
- **THEN** the tool returns `blocked: false` and an empty `blockers` list

#### Scenario: Result shape
- **WHEN** the tool is called with valid `owner`, `repo`, and `index` inputs
- **THEN** the response contains `index`, `blocked`, `blockers`, `total_dependencies`, and `open_blockers`

### Requirement: Full dependency list aggregation
The system SHALL collect the complete dependency list of an issue by paginating internally, so the caller never passes `page` / `limit` and receives the aggregated result regardless of dependency count.

#### Scenario: More than one page of dependencies
- **WHEN** an issue has more dependencies than fit on one page
- **THEN** the tool pages through the dependency endpoint until every dependency is collected before computing the verdict

#### Scenario: No pagination parameters accepted
- **WHEN** the caller invokes the tool
- **THEN** the input schema accepts only `owner`, `repo`, and `index` (no `page` / `limit` parameters)

### Requirement: Dependencies-disabled error propagation
The system SHALL propagate the dependency endpoint's 404 error unchanged when the repository has not enabled issue dependencies, and MUST NOT swallow it.

#### Scenario: Repository has issue dependencies disabled
- **WHEN** the repository has `enable_issue_dependencies` off and the tool is called
- **THEN** the call fails with the endpoint's 404 `GiteaApiError` and no partial result is returned

#### Scenario: Dependency state filtering
- **WHEN** dependencies are aggregated
- **THEN** only entries whose `state` is not `closed` are reported as blockers, and `open_blockers` equals the size of the `blockers` list
