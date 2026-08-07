---
name: install
description: Install or verify the bundled named Implementer, Reviewer, and Judge profiles required by Herder. Use when setting up the Herder plugin, when Herder reports a missing Codex role, or when the user asks to refresh host-native agent definitions.
---

# Herder Install

Install or verify every bundled host-native role definition required by Herder. Each curated profile declares one root-orchestrator launch requirement and compiles exactly three child roles. All applicable profiles install by default, the plugin version is the single verified release unit, and no runtime network fetch is required.

Codex Fire uses these profiles as native custom agent types. It requires Codex Multi-Agent V2 and never falls back to nested `codex exec` processes. Claude Fire uses the bundled host-native agents directly.

The catalog ships `eclipse`, `shannon`, and `offcut`. `eclipse` is the Codex default and is also compiled for Claude Code, `shannon` is the Claude default, and `offcut` is cross-host. `offcut` requires a Kimi K3/max root orchestrator, uses Grok 4.5/high for Implementer, and Sol/xhigh for Reviewer and Judge. Fire selects profiles by name and never substitutes a model.

## Invocation

Interpret tokens after the skill name as installer arguments:

```text
herder:install [--host codex|claude|all] [--scope project|user]
               [--dry-run] [--force]
```

- Default host: the current agent host. Pass it explicitly to the script; never infer a different host merely because its configuration directory exists.
- Default scope: `project`.
- `--force`: replace differing installed profiles after preserving backups. Never add it unless the user explicitly asks to replace or refresh customized profiles.

Codex users invoke `$herder:install`; Claude Code users invoke `/herder:install`.

## Install

1. Resolve the skill directory to the directory containing this `SKILL.md`.
2. Identify the current host as `codex` or `claude`. If the user requests both, use `all`.
3. Run:

```bash
node <skill-dir>/scripts/install-herder.mjs \
  --host <codex|claude|all> \
  --scope <project|user> \
  <remaining user arguments>
```

4. Report every installed, bundled, unchanged, or conflicted role definition and each named profile's required root-orchestrator model/effort.
5. On Codex, report the installer's Multi-Agent V2 check. If it is disabled, explain that installation is incomplete for Fire and run `codex features enable multi_agent_v2` only with the user's authorization to change Codex configuration. Then, with the same authorization, replace the boolean feature entry with the namespaced configuration below. If the current release does not expose the flag, report that it is unsupported rather than suggesting an execution fallback. The deterministic Run Manager consumes no child slot, so default five-worker execution requires five available child threads.
6. On Codex, require a new session when the agent directory was first created or profiles changed. Native custom agents and feature flags are resolved when a session starts.
7. On Claude, report that active worker transport requires addressable agent IDs and `SendMessage`. If unavailable, direct the user to start a session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` before Fire.

Codex project scope installs to `<repo>/.codex/agents/`; user scope installs to `~/.codex/agents/`. Claude agents load directly from the plugin's `agents/` directory, so the installer only verifies their bundled definitions.

After installation, show the user `$herder:fire ... --profile <name>` for a bundled profile. Use installer `--force` only when the user explicitly wants to replace differing installed definitions.

## Codex Requirement

`$herder:fire` requires a live Multi-Agent V2 spawn interface that accepts a custom `agent_type` and long waits. Scheduling and accounting run in the deterministic TypeScript manager. Codex's reserved generic spawn schema can hide custom-agent metadata, so Herder uses a dedicated namespace. Configure exactly one form of `multi_agent_v2`; replace `multi_agent_v2 = true` under `[features]` with:

```toml
[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false
tool_namespace = "herder_agents"
```

Do not set legacy `agents.max_threads` with Multi-Agent V2. Use Fire's `--max-parallel` for plan-worker scheduling. If a host-level limit is needed, use `max_concurrent_threads_per_session` inside the block above; for example, `--max-parallel 5` needs a host limit of at least `5`. The installer checks the effective feature state through the current Codex executable, but it cannot inspect a session's already-frozen tool schema. Installing profiles does not silently edit `config.toml`; it prints the required configuration and a feature-enable command when configuration is missing.

## Conflict Policy

Install automatically when a target is absent or byte-identical. If a target differs, stop without changing any profile and show the conflict. Preserve user customization by default. Use `--force` only with explicit user authorization; the installer saves replaced files under `<Codex config root>/.plan-herder-backups/<timestamp>/`, alongside rather than inside `agents/`, before writing the new set.

Do not execute profile contents. Read only files named in the bundled manifest, require paths to remain inside the expected plugin profile trees, and verify every SHA-256 digest before writing anything.
