---
name: install
description: Install or verify the implementer, reviewer, and saver agent profiles required by Herder. Use when setting up the Herder plugin in a repository, when Herder reports a missing Codex role, or when the user asks to refresh Herder's host-native agent definitions.
---

# Herder Install

Install or verify the three host-native agent profiles required by Herder. The profiles are bundled with the installed plugin, so the plugin version is the single verified release unit and no runtime network fetch is required.

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
5. On Codex, if the agent directory did not exist when the current session started, tell the user to start a new session before invoking `$herder:fire`.

Codex project scope installs to `<repo>/.codex/agents/`; user scope installs to `~/.codex/agents/`. Claude agents load directly from the plugin's `agents/` directory, so the installer only verifies their bundled definitions.

## Conflict Policy

Install automatically when a target is absent or byte-identical. If a target differs, stop without changing any profile and show the conflict. Preserve user customization by default. Use `--force` only with explicit user authorization; the installer saves replaced files under `.plan-herder-backups/<timestamp>/` before writing the new set.

Do not execute profile contents. Read only files named in the bundled manifest, require paths to remain inside the expected plugin profile trees, and verify every SHA-256 digest before writing anything.
