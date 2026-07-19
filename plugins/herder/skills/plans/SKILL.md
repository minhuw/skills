---
name: plans
description: Initialize, validate, inspect, and manage Herder Markdown plan backlogs and execution-token ledgers. Use when creating or repairing herder-plans/, checking plan dependencies and readiness, changing plan tracking policy, inspecting execution status, reporting token coverage, or preparing plans for $herder:fire. Do not use to implement plans or orchestrate subagents.
---

# Herder Plans

Own the Markdown backlog contract, parsing, and lifecycle state. Grill and Improve produce plans; Fire owns execution.

Read [references/plan-format.md](references/plan-format.md) and [references/plan-template.md](references/plan-template.md) before creating or repairing plans.

## Invocation

Codex uses `$herder:plans ...`; Claude Code uses `/herder:plans ...`.

```text
herder:plans init [<plan-dir>] [--track]
herder:plans validate [<plan-dir>]
herder:plans status [<plan-dir>]
herder:plans usage [<plan-dir>]
herder:plans track [<plan-dir>]
herder:plans untrack [<plan-dir>]
```

Default to `herder-plans/`. Never add `plans/execution.yaml`, a database, or another state file.

## Manager

Resolve `<skill-dir>` to this `SKILL.md`'s directory, then run:

```bash
node <skill-dir>/scripts/herder-plans.mjs <command> <remaining arguments> --pretty
```

- `init`: create the index if absent and locally exclude `/herder-plans/` via `.git/info/exclude`.
- `init --track`: keep the backlog trackable and ignore only `herder-plans/.herder/`.
- `validate`: check index/files, headings, metadata, dependency agreement, statuses, missing/unknown plans, and cycles.
- `status`: validate, then show totals, ready/waiting/terminal plans, and warnings.
- `usage`: group the ledger by plan, role, and model/effort; numeric values are only known subtotals when coverage is incomplete.
- `track`: remove the broad local exclude and create the internal `.gitignore`; do not stage files.
- `untrack`: restore the broad local exclude; do not change already tracked index entries.

A nonzero exit fails the operation. Do not rewrite malformed plans speculatively; report exact errors and repair only requested or mechanically unambiguous defects.

## Producer and Fire Commands

The same manager exposes:

```text
ready [<plan-dir>]
snapshot <plan-id> [<plan-dir>]
transition <plan-id> <status> [<plan-dir>] [--detail <text>]
record-usage <plan-id|RUN> <role> [<plan-dir>] --attempt <id> --model <model> --effort <effort> --outcome <outcome> [usage flags]
```

Producers run `init`, follow both shared references, reread drafts for the template's semantic Producer self-review, then run `validate`. Fire schedules only through `ready`, obtains complete plan text through `snapshot`, and changes status only through `transition`. Because the backlog may be Git-ignored, Fire must inline snapshot `planText` rather than expect plans in worktrees.

Only the root Fire coordinator changes status or records usage. Workers report outcomes and usage envelopes; they never edit the index. Status details are valid only for `BLOCKED` and `REJECTED`.

## Usage

The manager owns the generated `## Execution usage` section and appends idempotent attempts. Fire records every implementer, reviewer, Saver, and plan-set-wide attempt—including failures and missing responses—using a stable ID such as `<plan-name>-<plan-id>-<role>-<ordinal>`; use `RUN` when no plan owns the work and continue ordinals across resume. Use outcome `INTERRUPTED` for a host-level attempt that Fire proves produced neither a response envelope nor worktree mutation; it remains a usage attempt but does not consume a substantive Saver repair round.

Pass host-reported `--input-tokens`, `--cached-input-tokens`, `--output-tokens`, and `--reasoning-tokens`. Use `unknown` for unavailable fields and `--source unknown` when all token fields are missing. Never estimate from transcript length.
