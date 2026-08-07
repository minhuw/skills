---
name: configure
description: Interactively configure Orca cross-harness routing or legacy unqualified native Codex aliases. Use when the user invokes herder:configure, needs an older run's stable aliases, or wants to map Orca roles to Codex, Grok Build, or Pi. Fresh native Fire selects installed named profiles with herder:fire --profile.
---

# Herder Configure

Configure one backend at a time and write nothing until every selected route passes structural validation. Model identifiers are opaque configuration supplied by the user. Never request, copy, print, or store credentials.

Codex users invoke `$herder:configure`; Claude Code users invoke `/herder:configure`. This version configures Orca or the unqualified Codex aliases retained for pre-profile resume. Keep installed named profiles and Claude's plugin-bundled agents unchanged.

Resolve the skill directory to the directory containing this `SKILL.md`. Read [references/configuration-format.md](references/configuration-format.md) before generating an answers file.

## Interview

Ask one focused question at a time:

1. Ask which backend to update:
   - `native-codex`: legacy compatibility only; update the unqualified aliases used by a pre-profile run. Fresh runs use `herder:fire --profile <name>` instead.
   - `orca`: keep the controller on Codex and map every child role to Codex, Grok Build, or Pi.
2. Ask for the destination:
   - Native Codex default: project scope at `<repo>/.codex/agents/`.
   - Orca default: `<repo>/.herder/orca-runtime.json`.
   - Offer user scope for native Codex only when explicitly requested.
3. Keep the persistent `plan-accountant` fixed at bundled Luna/max/Fast; it is not an Orca-routed or user-configurable role. Walk through `controller`, `plan-implementer`, `plan-reviewer`, `plan-judge`, and `plan-saver` in that order. Show the current or bundled value, then ask for:
   - harness when the backend permits a choice;
   - exact model;
   - effort.
   For Codex child roles, any model ID ending in `-luna` automatically uses Fast tier. Keep the controller on Standard tier even when it uses Luna.
4. For Pi, require the model as `provider/model`. Do not infer a provider from a bare model.
5. Present one compact mapping table and the destination. Explain that Herder validates the harness adapter and profile shape but does not query model catalogs or spend tokens testing model availability. Ask for confirmation before writing.

For Orca, keep `controller` on Codex because Fire's root must load the Herder skill, host the native Accountant, and execute its exact worker-transport actions. Permit only `codex`, `grok-build`, and `pi`. Do not offer Amp or an arbitrary executable.

## Validate Before Writing

Create the answers JSON in a private temporary directory, not in the repository. Run:

```text
node <skill-dir>/scripts/configure-herder.mjs validate \
  --answers <temporary-answers.json> --pretty
```

For Orca, also require `orca status --json` to report a reachable runtime. Use the version-matched Orca CLI instructions; do not start or reconfigure Orca silently.

Do not run model catalogs or live model calls. On structural failure, write nothing and identify the exact role, harness adapter, model string, or effort field that is invalid. On actual Fire dispatch failure, report the exact selected profile/role/harness/model error; a pre-handle rejection consumes no attempt or round and never triggers model substitution.

## Apply

After structural validation passes, run:

```text
node <skill-dir>/scripts/configure-herder.mjs generate \
  --answers <temporary-answers.json> \
  --output <confirmed-destination> \
  --pretty
```

If the destination differs, stop and show the conflict. Ask before rerunning with `--force`; forced replacement creates a timestamped backup. Never infer overwrite authorization from the request to configure.

Delete the temporary answers file after success or failure.

For legacy native Codex, report the generated controller launch command and require a new Codex session so the unqualified custom-agent aliases enter the tool schema. Do not claim this changes `eclipse`, `offcut`, or another named profile. The legacy Accountant alias remains bundled Luna/max/Fast regardless of worker-route customization.

For Orca, validate the written profile once more:

```text
node <plugin-root>/skills/fire/scripts/orca-runtime.mjs validate \
  --profile <confirmed-destination> --pretty
```

Report the exact controller launch command and Fire invocation with `--runtime orca --runtime-profile <confirmed-destination>`. Do not launch Fire automatically.

## Completion

Report:

- backend and destination;
- exact role routing without credentials;
- the derived service tier for every Codex role;
- structural validation status;
- backups created, if any;
- whether a new Codex session is required;
- the exact next command.

Do not claim that a configured model is available. Herder deliberately discovers that only when the host accepts or rejects the real Fire dispatch.
