---
name: configure
description: Interactively configure and verify Herder role routing for native Codex or Orca cross-harness execution. Use when the user invokes herder:configure, wants to change Implementer, Reviewer, Judge, or Saver models, wants to map Orca roles to Codex, Grok Build, or Pi, or needs to diagnose an unavailable configured model before Fire runs.
---

# Herder Configure

Configure one backend at a time and write nothing until every selected route passes structural, availability, and live validation. Never request, copy, print, or store credentials.

Codex users invoke `$herder:configure`; Claude Code users invoke `/herder:configure`. This version configures native Codex or Orca. Keep Claude's native plugin-bundled agents unchanged.

Resolve the skill directory to the directory containing this `SKILL.md`. Read [references/configuration-format.md](references/configuration-format.md) before generating an answers file.

## Interview

Ask one focused question at a time:

1. Ask which backend to update:
   - `native-codex`: all roles use Codex; configure their models and reasoning efforts.
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
5. Present one compact mapping table and the destination. Explain that live validation makes one minimal call per unique harness/provider/model/effort route and may consume tokens. Ask for confirmation before probing or writing.

For Orca, keep `controller` on Codex because Fire's root must load the Herder skill, host the native Accountant, and execute its exact worker-transport actions. Permit only `codex`, `grok-build`, and `pi`. Do not offer Amp or an arbitrary executable.

## Validate Before Writing

Create the answers JSON in a private temporary directory, not in the repository. Run:

```text
node <skill-dir>/scripts/configure-herder.mjs validate \
  --answers <temporary-answers.json> --pretty
```

For Orca, also require `orca status --json` to report a reachable runtime. Use the version-matched Orca CLI instructions; do not start or reconfigure Orca silently.

Then run both:

```text
node <skill-dir>/scripts/configure-herder.mjs probe \
  --answers <temporary-answers.json> --pretty

node <skill-dir>/scripts/configure-herder.mjs probe \
  --answers <temporary-answers.json> --live --pretty
```

Availability probing checks executables and model catalogs without exposing their output. The probe set always includes the fixed native Luna/max/Fast Accountant route, including when plan workers are Orca-routed. Live probing sends only `Return exactly HERDER_CONFIG_OK.` with read-only/no-tool permissions and returns status plus output hashes. Never substitute a route when either probe fails.

On failure, write nothing. Identify the exact failed harness/provider/model/effort and ask the user to configure that agent outside the conversation:

- Codex: run `codex login`, then verify the selected account/model.
- Grok Build: run `grok login`, then `grok models`.
- Pi: run `pi`, use `/login`, and verify provider extensions with `pi list` and the route with `pi --list-models <provider/model>`.
- Orca: start or repair Orca until `orca status --json` is reachable.

Do not accept an API key in chat or add one to an answers file, profile, command, log, or environment assignment. After the user reports setup complete, repeat both probes from scratch.

## Apply

Only after both probes pass, run:

```text
node <skill-dir>/scripts/configure-herder.mjs generate \
  --answers <temporary-answers.json> \
  --output <confirmed-destination> \
  --pretty
```

If the destination differs, stop and show the conflict. Ask before rerunning with `--force`; forced replacement creates a timestamped backup. Never infer overwrite authorization from the request to configure.

Delete the temporary answers file after success or failure.

For native Codex, report the generated controller launch command and require a new Codex session so the configured custom-agent types enter the tool schema. Fire continues to use fixed `plan_accountant` plus stable `plan_implementer`, `plan_reviewer`, `plan_judge`, and `plan_saver` types. The generated Accountant profile remains bundled Luna/max/Fast regardless of worker-route customization.

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
- structural, availability, and live-probe status;
- backups created, if any;
- whether a new Codex session is required;
- the exact next command.

Do not claim configuration is complete when live validation was declined, skipped, or failed.
