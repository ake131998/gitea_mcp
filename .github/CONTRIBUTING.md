# Contributing to gitea-mcp

Thank you for your interest in contributing! This document covers how to set up, develop, and submit changes.

## Code of Conduct

All contributors are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Quick Links

- **Architecture**: [`docs/architecture.md`](docs/architecture.md) — module layout, dependency graph, and patterns
- **AI workflow rules**: [`AGENTS.md`](AGENTS.md) — two-remote model, branch discipline, and verification steps
- **Public API**: [`README.md`](README.md) — tool inventory, env contract, and MCP client setup

## How to Contribute

### Reporting Bugs

- Search [existing issues](https://github.com/amonstack/gitea_mcp/issues) first. Duplicate reports waste your time.
- Use the **Bug Report** template when opening a new issue.
- Include: steps to reproduce, expected vs actual behavior, Node version, and the MCP client you use.

### Suggesting Features

- Use the **Feature Request** template.
- Describe the problem before the solution. Context matters more than a specific implementation idea.
- If the feature involves a new MCP tool, skim the "Adding a tool" guide in `docs/architecture.md` first.

### Pull Requests

1. Fork the repository and create a branch from `master`.
2. Make your changes, following the conventions in `AGENTS.md` (Conventional Commits, module layout, error handling).
3. Run `make verify`. It must pass.
4. Open a pull request against `master`.

### Branch Discipline

This project uses a [two-remote model](AGENTS.md#12-branch-and-worktree-workflow):

- `master` is read-only and mirrors the upstream. Never commit directly to it.
- Work in a feature branch with an isolated git worktree.
- Squash to a single clean commit before the PR.

## Development Setup

### Prerequisites

- **Node.js ≥ 18** (uses the global `fetch`)
- **Git ≥ 2.x**

### Getting Started

```bash
git clone https://github.com/amonstack/gitea_mcp.git
cd gitea_mcp
npm install
```

### Verification

All checks must pass before submitting a PR:

```bash
make lint      # TypeScript type-check (with emit)
make build     # Compile src/ → dist/
make test      # Unit tests (vitest)
```

The CI pipeline runs `make verify`, which adds a secret scan before lint:

```bash
make verify    # scan → lint → build → test
```

For integration tests (requires a live Gitea instance):

```bash
make test-integration
```

## Commit Conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: <description>       # New feature or tool
fix: <description>        # Bug fix
chore: <description>      # CI, deps, tooling
docs: <description>       # Documentation
refactor: <description>   # Code restructure (no behavior change)
test: <description>       # Tests
```

- Subject: imperative mood, lowercase, ≤ 72 characters.
- Body: describe the functional outcome for users, not code mechanics.

## Adding a New Tool

Adding an MCP tool touches four files (see `docs/architecture.md` for details):

1. `src/tools.ts` — Zod input schema
2. `src/gitea-client.ts` — API method (if needed)
3. `src/server.ts` — `registerTool` call
4. `README.md` / `README.zh-CN.md` — tool table row

Write unit tests for every new tool, schema, or client method.

## Questions?

If something is unclear, [open an issue](https://github.com/amonstack/gitea_mcp/issues) and tag it with "question".
