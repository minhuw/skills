---
name: plans
description: Initialize, validate, inspect, and manage Herder Markdown plan backlogs and execution-usage ledgers. Use when creating or repairing herder-plans/, checking plan dependencies and readiness, changing plan tracking policy, inspecting execution status, reporting token/cost coverage, or preparing plans for $herder:fire. Do not use to implement plans or orchestrate subagents.
---

# Herder Plans

Manage the declarative plan backlog. Keep plan parsing and lifecycle state here; leave worktrees, agents, reviews, rescue, and integration to Fire.

Read [references/plan-format.md](references/plan-format.md) before creating or repairing plan files.

## Invocation

Interpret tokens after the skill name as arguments. Codex users invoke `$herder:plans ...`; Claude Code users invoke `/herder:plans ...`.

```text
herder:plans init [<plan-dir>] [--track]
herder:plans validate [<plan-dir>]
herder:plans status [<plan-dir>]
herder:plans usage [<plan-dir>]
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
- `usage` reports the execution ledger grouped by plan, role, and model/effort. Treat its numeric values as known subtotals, not invoice totals, whenever coverage is incomplete.
- `track` removes the local broad exclude and creates an internal `.gitignore` for `.herder/`. It does not stage files.
- `untrack` restores the repository-local broad exclude. Already tracked files remain tracked until the user explicitly changes the Git index.

Treat a nonzero script exit as a failed operation. Never rewrite a malformed backlog speculatively; report the exact validation error and repair only what the user requested or what is mechanically unambiguous.

## Coordinator Operations

Improve and Fire use the same manager directly:

```text
herder-plans ready [<plan-dir>]
herder-plans snapshot <plan-id> [<plan-dir>]
herder-plans transition <plan-id> <status> [<plan-dir>] [--detail <text>]
herder-plans record-usage <plan-id|RUN> <role> [<plan-dir>] --attempt <id> --model <model> --effort <effort> --outcome <outcome> [usage flags]
```

- Improve must run `init` before writing and `validate` after writing.
- Fire must use `ready` for scheduling, `snapshot` to inline complete plan text into worker prompts, and `transition` as the only status writer.
- Fire must call `record-usage` once for every implementer, reviewer, saver, and run-wide agent attempt, including failures and missing responses. Use `RUN` for work not attributable to one plan.
- Only the root Fire coordinator may transition statuses during execution. Implementers, reviewers, and savers report outcomes; they never edit the index.
- Status details are allowed only for `BLOCKED` and `REJECTED`.

Because the backlog is local by default, never assume it exists in a Git worktree. Always use `snapshot` and inline the returned `planText` into an agent prompt.

## Usage Ledger

Keep the generated `## Execution usage` section of `README.md` coordinator-owned. Workers return a usage envelope; they never edit the README themselves. The manager appends an idempotent attempt row and regenerates summaries by plan, role, and model/effort.

Use a stable attempt ID such as `<run-id>-<plan-id>-<role>-<ordinal>`. Pass token fields with `--input-tokens`, `--cached-input-tokens`, `--output-tokens`, and `--reasoning-tokens`; pass `--cost-usd` only when the host or an authoritative billing source directly reports it. Use `unknown` for unavailable fields and `--source unknown` when every numeric field is unavailable. Never infer tokens from transcript length or derive local subscription cost from API list prices.
