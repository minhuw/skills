# Herder Plan Protocol

## Contents

1. Directory and ownership
2. Index contract
3. Plan-file contract
4. Status lifecycle
5. Tracking and worktree behavior
6. Execution usage

## 1. Directory and ownership

Store the backlog at the repository root:

```text
herder-plans/
  README.md
  001-short-imperative-slug.md
  002-another-plan.md
  .herder/                 # optional runtime artifacts; never plan truth
```

`README.md` and the numbered Markdown files are the plan truth. Do not require YAML execution configuration, a database, or `.herder/state.json`. Fire may recover execution evidence from the index plus its Git branches and completion-marker commits.

Improve owns plan content. Plans owns parsing and status transitions. Fire owns execution side effects.

## 2. Index contract

`README.md` must contain one Markdown table with these headers; additional columns are allowed:

```markdown
| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | Establish baseline | P1 | S | — | TODO |
| [002](002-second.md) | Refactor safely | P1 | M | 001 | TODO |
```

Requirements:

- Use a unique numeric ID per plan. Format filenames with at least three digits.
- Link each Plan cell to its local `NNN-*.md` file, or omit the link only when exactly one matching file exists.
- Express dependencies as numeric IDs. Use `—` or `none` for no dependencies.
- Keep every numbered plan file indexed and every indexed plan file present.
- Keep the dependency list in the index identical to the plan file's `Depends on` metadata.
- Keep the graph acyclic.

## 3. Plan-file contract

Every plan must be self-contained and include:

```markdown
# Plan NNN: <imperative title>

## Status

- **Priority**: P1 | P2 | P3
- **Effort**: S | M | L
- **Risk**: LOW | MED | HIGH
- **Depends on**: herder-plans/NNN-*.md (or "none")
- **Category**: bug | security | perf | tests | tech-debt | migration | dx | docs | direction
- **Planned at**: commit `<short SHA>`, <YYYY-MM-DD>
```

Also include why the work matters, current-state evidence, exact commands, in-scope and out-of-scope files, ordered implementation steps, a test plan, machine-checkable done criteria, specific STOP conditions, and maintenance notes.

The executor has the repository plus this one plan, but no advisor-session context and no guarantee that sibling plans are present in its worktree. Inline every required fact.

## 4. Status lifecycle

Supported statuses:

```text
TODO
IN PROGRESS
DONE
BLOCKED — <one-line reason>
REJECTED — <one-line rationale>
```

Normal transitions:

```text
TODO → IN PROGRESS | BLOCKED | REJECTED
IN PROGRESS → TODO | DONE | BLOCKED | REJECTED
BLOCKED → TODO | IN PROGRESS | REJECTED
DONE → BLOCKED                 # verification later regressed
REJECTED → TODO                # finding intentionally reopened
```

Only the root coordinator writes status during Fire. A DONE status is necessary but not sufficient for dependency execution: Fire must also verify the corresponding completion-marker commit is reachable from integration HEAD.

The manager's `ready` set contains dependency-satisfied `TODO` plans only. `IN PROGRESS` plans require resume reconstruction, and `BLOCKED` plans require Saver recovery; neither is fresh implementer work.

## 5. Tracking and worktree behavior

Default initialization adds `/herder-plans/` to `.git/info/exclude`, making the backlog local without changing repository policy. Tracking is opt-in. When tracked, keep `.herder/` ignored because logs and runtime artifacts may change frequently.

An ignored backlog is absent from newly created Git worktrees. Fire must obtain each plan through the manager's `snapshot` command and inline `planText` into implementer, reviewer, and saver prompts. Do not copy the entire backlog into candidate or integration branches.

## 6. Execution usage

`README.md` may contain a manager-generated `## Execution usage` section with summaries by plan, role, and model/effort plus one row per agent attempt. Only the root Fire coordinator writes this section through `herder-plans record-usage`; workers return their usage envelope instead of editing the shared README.

Record model, effort, outcome, and an idempotent attempt ID for every implementer, reviewer, saver, and run-wide agent attempt. Copy numeric token or USD fields only from host telemetry or authoritative billing data. Keep unavailable values as `unknown`; never estimate tokens from transcript length or apply API prices to a subscription-backed run. Input-plus-output token subtotals do not add cached-input or reasoning detail again, and incomplete coverage must remain visible.
