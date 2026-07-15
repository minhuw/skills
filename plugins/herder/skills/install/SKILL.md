---
name: install
description: Install or verify the implementer, reviewer, and saver agent profiles required by Herder. Use when setting up the Herder plugin in a repository, when Herder reports a missing Codex role, or when the user asks to refresh Herder's host-native agent definitions.
---

# Herder Install

Install or verify the three host-native agent profiles required by Herder. The profiles are bundled with the installed plugin, so the plugin version is the single verified release unit and no runtime network fetch is required.

Codex Fire uses these profiles as native custom agent types. It requires Codex Multi-Agent V2 and never falls back to nested `codex exec` processes. Claude Fire uses the bundled host-native agents directly.

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

4. Report every installed, bundled, unchanged, or conflicted profile.
5. On Codex, report the installer's Multi-Agent V2 check. If it is disabled, explain that installation is incomplete for Fire and run `codex features enable multi_agent_v2` only with the user's authorization to change Codex configuration. Then, with the same authorization, replace the boolean feature entry with the namespaced configuration below. If the current release does not expose the flag, report that it is unsupported rather than suggesting an execution fallback.
6. On Codex, require a new session when the agent directory was first created or profiles changed. Native custom agents and feature flags are resolved when a session starts.

Codex project scope installs to `<repo>/.codex/agents/`; user scope installs to `~/.codex/agents/`. Claude agents load directly from the plugin's `agents/` directory, so the installer only verifies their bundled definitions.

## Codex Requirement

`$herder:fire` requires a live Multi-Agent V2 spawn interface that accepts a custom `agent_type`. Codex's reserved generic spawn schema can hide custom-agent metadata, so Herder uses a dedicated namespace. Configure exactly one form of `multi_agent_v2`; replace `multi_agent_v2 = true` under `[features]` with:

```toml
[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false
tool_namespace = "herder_agents"
```

Do not set legacy `agents.max_threads` with Multi-Agent V2. Use Fire's `--max-parallel` for scheduling; if a host-level limit is needed, use `max_concurrent_threads_per_session` inside the block above. The installer checks the effective feature state through the current Codex executable, but it cannot inspect a session's already-frozen tool schema. Installing profiles does not silently edit `config.toml`; it prints the required configuration and a feature-enable command when configuration is missing.

## Conflict Policy

Install automatically when a target is absent or byte-identical. If a target differs, stop without changing any profile and show the conflict. Preserve user customization by default. Use `--force` only with explicit user authorization; the installer saves replaced files under `.plan-herder-backups/<timestamp>/` before writing the new set.

Do not execute profile contents. Read only files named in the bundled manifest, require paths to remain inside the expected plugin profile trees, and verify every SHA-256 digest before writing anything.
