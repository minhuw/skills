# Herder Plan Protocol

## 1. Truth and Ownership

Store plan truth at the repository root:

```text
herder-plans/
  README.md
  001-short-imperative-slug.md
  002-another-plan.md
  .herder/                 # optional runtime artifacts; never plan truth
```

Do not require YAML execution configuration, a database, or `.herder/state.json`. Plans owns format, parsing, validation, and transitions; Grill and Improve produce the same format; Fire owns execution. Provenance must not alter what Fire receives or require hidden session context.

Before manager validation, reread every draft and complete [plan-template.md](plan-template.md)'s semantic Producer self-review. Validation checks structure and graph integrity, not intent or evidence quality.

## 2. Index

`README.md` contains one plan table with these headers; extra columns are allowed:

```markdown
| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | Establish baseline | P1 | S | — | TODO |
| [002](002-second.md) | Refactor safely | P1 | M | 001 | TODO |
```

- Use unique numeric IDs and filenames padded to at least three digits.
- Link each Plan cell to its `NNN-*.md`, unless exactly one matching file makes the target unambiguous.
- Use numeric dependency IDs and `—` or `none` for no dependencies.
- Keep every numbered file indexed, every entry present, and index/file dependencies identical.
- Keep the dependency graph acyclic.

## 3. Plan File

Every plan follows the shared template and begins with:

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

Use [plan-template.md](plan-template.md) for all required evidence, decisions, scope, ordered work, tests, done criteria, STOP conditions, and maintenance guidance. When terminology or architecture decisions change, schedule the relevant `CONTEXT.md`, `CONTEXT-MAP.md`, or ADR update in scope, steps, and done criteria; keep implementation details out of glossaries.

The executor receives the repository and this plan, not the Grill interview, Improve audit, or necessarily sibling plan files. Inline every required fact and durable decision.

## 4. Status

```text
TODO
IN PROGRESS
DONE
BLOCKED — <one-line reason>
REJECTED — <one-line rationale>
```

Allowed transitions:

```text
TODO → IN PROGRESS | BLOCKED | REJECTED
IN PROGRESS → TODO | DONE | BLOCKED | REJECTED
BLOCKED → TODO | IN PROGRESS | REJECTED
DONE → BLOCKED
REJECTED → TODO
```

Only the root coordinator writes status during Fire. Dependencies require both `DONE` and a reachable completion-marker commit. `ready` returns dependency-satisfied `TODO` plans; `IN PROGRESS` needs resume reconstruction and `BLOCKED` needs Saver recovery.

## 5. Tracking and Worktrees

Default initialization adds `/herder-plans/` to `.git/info/exclude` without changing project `.gitignore`; tracking is opt-in. When tracked, ignore `.herder/` because runtime artifacts change frequently.

An ignored backlog is absent from new worktrees. Fire uses manager `snapshot` and inlines `planText` in implementer, reviewer, and saver prompts; never copy the whole backlog into execution branches.

## 6. Execution Usage

The manager may generate `README.md`'s `## Execution usage` section with summaries and one row per attempt. Only the root Fire coordinator writes it through `record-usage`; workers return usage envelopes.

Record model, effort, outcome, and an idempotent attempt ID for every implementer, reviewer, saver, and run-wide attempt. Copy only host telemetry; keep unavailable fields `unknown` and never estimate. Input-plus-output subtotals do not add cached-input or reasoning details again, and incomplete coverage must remain visible.
