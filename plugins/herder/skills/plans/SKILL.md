---
name: plans
description: Initialize, validate, inspect, and manage Herder Markdown plan backlogs. Use when creating or repairing herder-plans/, checking plan dependencies and readiness, changing plan tracking policy, inspecting execution status, or preparing plans for $herder:fire. Do not use to implement plans or orchestrate subagents.
---

# Herder Plans

Manage the declarative plan backlog and its canonical content contract. Keep plan parsing and lifecycle state here; let Grill and Improve produce plans, and leave worktrees, agents, reviews, rescue, and integration to Fire.

Read [references/plan-format.md](references/plan-format.md) and [references/plan-template.md](references/plan-template.md) before creating or repairing plan files.

## Invocation

Interpret tokens after the skill name as arguments. Codex users invoke `$herder:plans ...`; Claude Code users invoke `/herder:plans ...`.

```text
herder:plans init [<plan-dir>] [--track]
herder:plans validate [<plan-dir>]
herder:plans status [<plan-dir>]
herder:plans track [<plan-dir>]
herder:plans untrack [<plan-dir>]
```

Default `plan-dir` to `herder-plans/`. Do not introduce `plans/execution.yaml`, a database, or another required state file.

## Run the Manager

Resolve the skill directory to the directory containing this `SKILL.md`, then run the corresponding command:

```bash
node <skill-dir>/scripts/herder-plans.mjs <command> <remaining arguments> --pretty
```

- `init` creates `herder-plans/README.md` when absent and adds `/herder-plans/` to the repository-local `.git/info/exclude`. It does not alter the project's `.gitignore`.
- `init --track` creates the backlog without the local exclude and keeps only `herder-plans/.herder/` ignored.
- `validate` checks the index, numbered files, required headings and metadata, dependency agreement, statuses, missing plans, unknown dependencies, and cycles.
- `status` validates first, then report totals, ready plans, waiting dependencies, terminal plans, and warnings.
- `track` removes the local broad exclude and creates an internal `.gitignore` for `.herder/`. It does not stage files.
- `untrack` restores the repository-local broad exclude. Already tracked files remain tracked until the user explicitly changes the Git index.

Treat a nonzero script exit as a failed operation. Never rewrite a malformed backlog speculatively; report the exact validation error and repair only what the user requested or what is mechanically unambiguous.

## Producer and Coordinator Operations

Grill, Improve, and Fire use the same manager directly:

```text
herder-plans ready [<plan-dir>]
herder-plans snapshot <plan-id> [<plan-dir>]
herder-plans transition <plan-id> <status> [<plan-dir>] [--detail <text>]
```

- Every plan producer must run `init` before writing, follow the shared format and template, reread each draft from disk and pass the template's semantic Producer self-review, then run `validate` for mechanical contract and graph checks.
- Grill produces plans from confirmed user intent and may refine an explicitly selected plan.
- Improve produces plans from verified repository findings and may refine plans during reconciliation.
- Fire must use `ready` for scheduling, `snapshot` to inline complete plan text into worker prompts, and `transition` as the only status writer.
- Only the root Fire coordinator may transition statuses during execution. Implementers, reviewers, and savers report outcomes; they never edit the index.
- Status details are allowed only for `BLOCKED` and `REJECTED`.

Because the backlog is local by default, never assume it exists in a Git worktree. Always use `snapshot` and inline the returned `planText` into an agent prompt.
