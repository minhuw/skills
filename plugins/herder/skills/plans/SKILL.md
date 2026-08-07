---
name: plans
description: Initialize, shape, validate, inspect, and manage Herder Markdown plan backlogs, compiled snapshots, and SQLite execution accounting. Use when creating or repairing herder-plans/, checking semantic scope, dependencies and readiness, changing tracking policy, inspecting execution status, reporting run statistics, or preparing plans for $herder:fire. Do not use to implement plans or orchestrate subagents.
---

# Herder Plans

Own the Markdown backlog contract, parsing, and lifecycle state. Grill and Improve produce plans; Fire owns execution.

Read [references/plan-format.md](references/plan-format.md) and [references/plan-template.md](references/plan-template.md) before creating or repairing plans.

## Invocation

Codex uses `$herder:plans ...`; Claude Code uses `/herder:plans ...`.

```text
herder:plans init [<plan-dir>] [--track]
herder:plans validate [<plan-dir>]
herder:plans shape [<plan-dir>]
herder:plans status [<plan-dir>]
herder:plans usage [<plan-dir>]
herder:plans report <plan-id|RUN> [<plan-dir>]
herder:plans track [<plan-dir>]
herder:plans untrack [<plan-dir>]
```

Default to `herder-plans/`. The manager owns only one accounting database, `herder-plans/.herder/execution.sqlite3`. Never add `plans/execution.yaml`, another database, an event journal, or another scheduler-state file.

## Manager

Resolve `<skill-dir>` to this `SKILL.md`'s directory, then run:

```bash
node <skill-dir>/scripts/herder-plans.mjs <command> <remaining arguments> --pretty
```

- `init`: create the index if absent and locally exclude `/herder-plans/` via `.git/info/exclude`.
- `init --track`: keep the backlog trackable and ignore only `herder-plans/.herder/`.
- `validate`: check index/files, headings, metadata, dependency agreement, statuses, missing/unknown plans, cycles, and overlapping machine-readable write scopes.
- `shape`: report each plan's kind, parent objective, write paths, local line/word count, shape issues, shared-context size, and cross-plan overlaps without changing files.
- `status`: validate, then show totals, ready/waiting/terminal plans, and warnings.
- `usage`: read SQLite and group attempts by plan, role, and model/effort; numeric values are only known subtotals when coverage is incomplete.
- `report`: return rich per-plan or full-run attempt, round, outcome, model, runtime, token-coverage, and timing statistics. A successful transition to `DONE` includes that plan's report in its result.
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
report <plan-id|RUN> [<plan-dir>]
```

Producers run `init`, shape the objective into focused independently verifiable nodes, follow both shared references, reread drafts for the template's semantic Producer self-review, then run both `shape` and `validate`. New plans always declare `Kind`, `Parent objective`, `## Dependency contract`, and `## Review map`. Target 500–900 words per local plan and never exceed the manager's 1,200-word ceiling; shared context never exceeds 1,600 words.

File and line counts may be reported descriptively, but neither count determines plan scope, reviewability, repair authority, integration, or lifecycle status.

A worker may change an undeclared companion path only when it directly supports the original outcome, links to a plan step or done criterion, remains inside the declared bounded subsystem, adds no unplanned public-contract or migration transition, and does not overlap unordered live work. The Implementer must justify it and Reviewer must accept it; escalated rounds additionally require Judge acceptance. Split or replan only for a semantic boundary violation, never because of the number of changed or discovered paths.

Use optional `herder-plans/CONTEXT.md` only for verified context genuinely shared by multiple plans. At fresh start Fire compiles the graph, dependencies, gates, and lifecycle into SQLite once, then obtains immutable worktree assignments through `snapshot`. `snapshot.planText` is either the local plan or deterministic shared-context-plus-local-plan composition and includes input/content hashes. Because the backlog may be Git-ignored, Fire must inline `planText` rather than expect any plan file in worktrees.

Only the deterministic Run Manager changes status or records attempts. Workers report outcomes and usage envelopes; the root only transports those results and neither edits the index nor opens the database. Status details are valid only for `BLOCKED` and `REJECTED`.

## Usage

The manager stores the immutable compiled plan specification—including assignment text and hashes—typed runtime phases, actions, and attempt metadata in `.herder/execution.sqlite3`. SQLite is scheduler truth; README lifecycle cells are a recoverable human-readable projection, while Git refs/worktrees remain execution proofs. The manager uses built-in `node:sqlite`, short transactions, a busy timeout, integrity checks, schema versioning, and idempotent event and attempt IDs. It stores no worker prompts, responses, transcripts, unrelated repository contents, or secrets.

Fire records every Implementer, Reviewer, Judge, and plan-set-wide attempt—including failures and missing responses—using a stable ID such as `<plan-name>-<plan-id>-<role>-<ordinal>`; use `RUN` when no plan owns the work and continue ordinals across resume. Use outcome `INTERRUPTED` for a host-level attempt that Fire proves produced neither a response envelope nor worktree mutation; it remains a usage attempt but does not consume a substantive implementation round.

Pass host-reported `--input-tokens`, `--cached-input-tokens`, `--output-tokens`, and `--reasoning-tokens`. Also pass known `--round`, `--generation`, `--harness`, `--service-tier`, `--started-at`, `--finished-at`, and `--duration-ms` metadata so final reports can explain convergence and wall time. Use `unknown` for unavailable token fields and `--source unknown` when all token fields are missing. Never estimate from transcript length.

Use `$herder:dashboard` for a continuously refreshed local graph of this lifecycle, attempt ledger, and Fire's Git evidence. Dashboard is strictly an observer and never replaces manager mutations.
