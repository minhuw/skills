# Herder Plan Protocol

## Contents

1. Directory and ownership
2. Index contract
3. Plan-file contract
4. Status lifecycle
5. Tracking and worktree behavior

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

Plans owns the canonical plan contract, parsing, validation, and status transitions. Grill produces plans from confirmed user intent and repository facts. Improve produces plans from verified repository findings. Fire owns execution side effects.

Both producers write the same format. Plan provenance must not change what Fire receives or require Fire to recover hidden session context.

Before manager validation, the producer must reread each draft from disk and perform the semantic Producer self-review in [plan-template.md](plan-template.md). Manager validation checks structure and graph integrity; it does not prove that a plan captures confirmed intent, cites sufficient evidence, or is executable without hidden context.

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
- **Category**: feature | bug | security | perf | tests | tech-debt | migration | dx | docs | direction
- **Planned at**: commit `<short SHA>`, <YYYY-MM-DD>
```

Also include why the work matters, accepted decisions and explicit non-goals, current-state evidence, exact commands, in-scope and out-of-scope files, ordered implementation steps, a test plan, machine-checkable done criteria, specific STOP conditions, and maintenance notes. Use [plan-template.md](plan-template.md) as the shared producer template.

When an accepted decision changes project terminology or an architectural constraint, the plan must identify the relevant `CONTEXT.md`, `CONTEXT-MAP.md`, or ADR file, describe the required content, include the file in scope and ordered steps, and add a done criterion. Keep implementation details out of domain glossaries.

The executor has the repository plus this one plan, but no Grill interview or Improve audit context and no guarantee that sibling plans are present in its worktree. Inline every required fact and durable decision.

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
