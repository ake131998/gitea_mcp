#!/usr/bin/env node
import { createRequire } from "node:module";
import { runServer, type Platform } from "./server.js";
import { discoverConfig, discoverGitLabConfig } from "./git-config.js";

const pkgVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export const TOP_LEVEL_USAGE = `Usage: gitea-mcp [command] [options]

Gitea MCP server — exposes Gitea issues, labels, milestones, and comments as
tools for AI assistants. With no command, it starts the Model Context Protocol
server over stdio and auto-discovers baseUrl, owner, repo, and credentials from
the environment and the local git remote (.git/config).

Platform selection: one process serves one platform (default: gitea).
MCP_PLATFORM=gitlab — or any GITLAB_BASE_URL/GITLAB_TOKEN/GITLAB_REPO_URL env
var without a GITEA_* counterpart — serves GitLab instead (GITLAB_* env
contract, and the same tool names backed by the GitLab REST API v4).

Commands:
  init    Install bundled action skills into an AI tool's skills directory.

Options:
  -h, --help        Show this help and exit.
  -V, --version     Show version and exit.

With no command, gitea-mcp starts the MCP server. Run \`gitea-mcp init --help\`
for init-specific options.
`;

/**
 * Resolve which platform this process serves. Explicit `MCP_PLATFORM`
 * (`gitea`|`gitlab`) wins; otherwise GitLab is auto-selected when any
 * GITLAB_* connection env var is present and no GITEA_* connection env var
 * is (`*_BASE_URL`, `*_TOKEN`, `*_REPO_URL`). The default remains `gitea`
 * for backward compatibility.
 */
export function resolvePlatform(env: NodeJS.ProcessEnv): Platform {
  const explicit = env.MCP_PLATFORM;
  if (explicit !== undefined) {
    if (explicit !== "gitea" && explicit !== "gitlab") {
      throw new Error(`Invalid MCP_PLATFORM '${explicit}': expected 'gitea' or 'gitlab'.`);
    }
    return explicit;
  }
  const hasGitLab =
    env.GITLAB_BASE_URL !== undefined ||
    env.GITLAB_TOKEN !== undefined ||
    env.GITLAB_REPO_URL !== undefined;
  const hasGitea =
    env.GITEA_BASE_URL !== undefined ||
    env.GITEA_TOKEN !== undefined ||
    env.GITEA_REPO_URL !== undefined;
  return hasGitLab && !hasGitea ? "gitlab" : "gitea";
}

/**
 * Parse the optional `MCP_TOOL_ALLOWLIST` env var into the tool-name list
 * passed to `runServer`/`createServer`. Unset, empty, or whitespace-only
 * values (and values whose every entry is blank after trimming) leave the
 * gate off and return `undefined`; otherwise entries are split on commas and
 * trimmed. Matching against the registered tool names of the active platform
 * happens in server.ts — an entry naming no such tool is a fatal startup
 * error there, following the `resolvePlatform` precedent.
 */
export function resolveToolAllowlist(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env.MCP_TOOL_ALLOWLIST;
  if (raw === undefined) return undefined;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

const argv = process.argv.slice(2);
const head = argv[0];

if (head === "-h" || head === "--help" || head === "help") {
  process.stdout.write(TOP_LEVEL_USAGE);
  process.exit(0);
}

if (head === "-V" || head === "--version") {
  process.stdout.write(`gitea-mcp ${pkgVersion}\n`);
  process.exit(0);
}

if (head === "init") {
  // `gitea-mcp init [--tool <name>]` installs the bundled skills into a target
  // AI tool's skills directory. It needs no Gitea credentials, so it is
  // dispatched before the config-discovery logic below.
  const { runInitCommand } = await import("./skills.js");
  runInitCommand(argv.slice(1)).catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
} else {
  // Resolve baseUrl/owner/repo/credentials from env first, then git's own
  // machinery (`.git/config` remotes via file reads; tokens/credentials via
  // `git config` / `git credential fill` subprocesses — never in-process
  // parsing of secret-bearing files). Discovery collects ALL credential
  // candidates (repo URL, config token, env token, git credential helper)
  // rather than picking one, so the client can fall back across them when
  // one scheme is rejected (e.g. an account password that is not a PAT).
  // When the git binary is unavailable, discovery degrades to the env
  // sources (repo URL / env token) / anonymous mode and the status tool
  // reports gitAvailable=false as fix guidance. When neither env nor any
  // git remote provides a baseUrl, the server starts in an UNCONFIGURED
  // state — business tools return NotConfiguredError on invocation, and the
  // configure tool enables runtime configuration.
  //
  // One process serves one platform: MCP_PLATFORM (or the GITLAB_*/GITEA_*
  // env mix) selects which discovery pipeline runs and which client the
  // server wires (GiteaClient by default, GitLabClient in gitlab mode).
  let platform: Platform;
  try {
    platform = resolvePlatform(process.env);
  } catch (err: unknown) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
  const fatal = (err: unknown): void => {
    console.error("Fatal error:", err);
    process.exit(1);
  };
  // Startup tool allowlist: parsed once here (env wiring is this file's role)
  // and enforced in server.ts at the registration layer. `undefined` means
  // the gate is off and every tool of the platform stays available.
  const toolAllowlist = resolveToolAllowlist(process.env);
  const discovered = await (platform === "gitlab" ? discoverGitLabConfig() : discoverConfig()).catch(fatal);

  if (!discovered) {
    const baseUrlVar = platform === "gitlab" ? "GITLAB_BASE_URL" : "GITEA_BASE_URL";
    const repoUrlVar = platform === "gitlab" ? "GITLAB_REPO_URL" : "GITEA_REPO_URL";
    console.error(
      `gitea-mcp: starting UNCONFIGURED — no git remote found in ${process.cwd()}, and neither ${baseUrlVar} nor ${repoUrlVar} is set. Use the configure_${platform} tool to configure at runtime.`,
    );
    if (platform === "gitlab") {
      runServer(undefined, undefined, undefined, undefined, undefined, undefined, "gitlab", toolAllowlist).catch(fatal);
    } else {
      runServer(undefined, undefined, undefined, undefined, undefined, undefined, undefined, toolAllowlist).catch(fatal);
    }
  } else if (platform === "gitlab") {
    runServer(
      discovered.baseUrl,
      discovered.candidates,
      discovered.defaultOwner,
      discovered.defaultRepo,
      undefined,
      discovered.gitAvailable,
      "gitlab",
      toolAllowlist,
    ).catch(fatal);
  } else {
    runServer(
      discovered.baseUrl,
      discovered.candidates,
      discovered.defaultOwner,
      discovered.defaultRepo,
      undefined,
      discovered.gitAvailable,
      undefined,
      toolAllowlist,
    ).catch(fatal);
  }
}
