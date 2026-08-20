---
name: gitea-configure
description: Invoke to CONFIGURE / SET UP / FIX the Gitea connection — instance URL, token, or owner/repo discovery. Use when a tool fails with 401/403 (bad or missing token), when the user asks how to wire up gitea-mcp, or when baseUrl/owner/repo could not be auto-detected. Do NOT invoke for normal issue/label/milestone work once the connection works.
---

# gitea-configure

Diagnose and fix the Gitea connection. The server auto-discovers its config from the
project's git remotes; this skill is the fallback when that fails or the token is wrong.

## How gitea-mcp discovers config (no env vars required)

On start, the server reads `<cwd>/.git/config` and resolves in this order:

1. **baseUrl** — `GITEA_BASE_URL` env var, else derived from the selected remote's host.
   SSH remotes (`git@host:owner/repo`) resolve to `https://host`.
2. **owner / repo** — `GITEA_DEFAULT_OWNER` / `GITEA_DEFAULT_REPO` env vars, else from the
   selected remote's URL.
3. **Remote selection** — `upstream` remote first, falling back to `origin`, then any
   other remote. Both are surfaced in `resolve_repo` output.

If the working directory has NO git remote and `GITEA_BASE_URL` is unset, the server
starts in an **unconfigured** state — `tools/list` is available, but business tools
return `NotConfiguredError`. Use the `configure_gitea` tool to set the connection at
runtime (session-scoped, never persisted), or guide the user to restart from a cloned
repo / with env vars set.

## Token discovery chain (tried in order)

1. `.git/config` — a `[gitea "<baseUrl>"]` section (read via
   `git config get --url=<baseUrl> gitea.token`), e.g.
   ```ini
   [gitea "https://gitea.example.com"]
       token = <your-token>
   ```
   A bare `[gitea]` section with `token = ...` is a host-wide fallback.
2. `GITEA_TOKEN` env var.
3. The credential git itself would use for the instance host, retrieved via
   `git credential fill` — this honors every configured credential helper,
   including OS keychains (`wincred` / `osxkeychain` / `libsecret`) and the
   store file (`~/.git-credentials`). If `gitea_status` reports
   `gitAvailable: false`, git could not be used at all — only `GITEA_TOKEN`
   remains; guide the user to install git (≥ 2.46) or set `GITEA_TOKEN`.
4. If none of the above yield a token, the server starts WITHOUT a token (anonymous). Public
   repos may be read; writes and private repos return 401 — that is the signal to help the
   user add a token via one of the sources above.

## Fix flow — when a tool returns 401 / 403

1. Confirm the instance: run `resolve_repo` (no args) and read its `baseUrl` and `remote`.
   If it throws, the cwd has no usable git remote — tell the user to run gitea-mcp from a
   cloned repo, or set `GITEA_BASE_URL` + `GITEA_TOKEN`.
2. Ask the user to create a token at `<baseUrl>/user/settings/applications` (Gitea → Settings
   → Applications → Access Tokens). Capture the scopes they need: `issue`, `comment`,
   `label`, `milestone` (read+write). NEVER have the user paste a token into chat unless they
   explicitly choose to — prefer having them run a git command themselves.
3. Have the user store it so discovery finds it. Recommend, in priority order:
   - `git config --file=.git/config gitea."<baseUrl>".token "<token>"` (project-scoped), or
   - store it as a git credential (any configured helper — e.g.
     `git credential approve`, or an OS-keychain helper), or
   - export `GITEA_TOKEN` (and `GITEA_BASE_URL`) in their MCP client config.
   `<baseUrl>` is the EXACT value `resolve_repo` reported (scheme + host, with port if any).
4. After the user stores the credential, call `configure_gitea` with the same `base_url`
   to trigger credential re-discovery — no restart needed. If the server started
   unconfigured, provide `base_url` (and optionally `username` for identity selection)
   in the same call. Re-calling with the same `base_url` is the "I just added a
   git credential, refresh now" idiom.

## Never log the token

Tokens are secret. Do not echo, paste into notes, or include in issue/comment bodies. Pass
configuration values to the user as commands to run themselves; never print a token back.
