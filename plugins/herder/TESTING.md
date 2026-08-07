# Testing Herder

## Deterministic suite

Run the full local suite from the repository root:

```sh
node plugins/herder/scripts/smoke-test.mjs
```

The smoke runner delegates to focused tests for profiles, Plans/SQLite, installation, Fire evidence and round policy, coordination refs, checkout containment, namespace ownership, assignment bundles and active-rebase recovery, branch/restack behavior, cleanup, dashboard state/security, the Pi extension, and the TypeScript Run Manager.

The runtime tests bind one loopback port for the combined manager/dashboard service. In a restricted sandbox, allow that local bind rather than weakening the test.

## Focused commands

```sh
npm run typecheck:pi
npm run test:pi
npm run test:runtime
node plugins/herder/agent-profiles/scripts/test.mjs
node plugins/herder/skills/plans/scripts/test.mjs
node plugins/herder/skills/install/scripts/test.mjs
node plugins/herder/skills/fire/scripts/test.mjs
node plugins/herder/skills/fire/scripts/assignment-bundle-test.mjs
node plugins/herder/skills/fire/scripts/cleanup-test.mjs
node plugins/herder/skills/dashboard/scripts/test.mjs
```

## Live host matrix

Create a fresh fixture for each host/profile pair:

```sh
node plugins/herder/scripts/live-manager-fixture.mjs create /tmp/herder-live-codex
node plugins/herder/scripts/live-manager-fixture.mjs create /tmp/herder-live-claude
node plugins/herder/scripts/live-manager-fixture.mjs create /tmp/herder-live-pi
```

Run Fire in the fixture repository through the native host:

- Codex: `$herder:fire herder-plans --profile eclipse`
- Claude Code: `/herder:fire herder-plans --profile eclipse`
- Pi: `/herder-fire herder-plans --profile offcut`

Then verify:

```sh
node plugins/herder/scripts/live-manager-fixture.mjs verify /tmp/herder-live-codex --host codex --profile eclipse
node plugins/herder/scripts/live-manager-fixture.mjs verify /tmp/herder-live-claude --host claude --profile eclipse
node plugins/herder/scripts/live-manager-fixture.mjs verify /tmp/herder-live-pi --host pi --profile offcut
```

Verification requires a complete manager run, exact profile routing, one Implementer plus plan and final Reviewers, durable usage records, a clean unchanged user checkout, a passing integration worktree, and a healthy dashboard. Judge is intentionally absent from this approval-first fixture.

## Plugin validation

Before release, validate the plugin and every changed skill with the current plugin-creator/skill-creator validators, then update the plugin cachebuster and reinstall it. Start a new host session after installation so MCP and agent definitions reload.
