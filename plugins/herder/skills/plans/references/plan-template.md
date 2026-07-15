# Canonical Herder Plan Template

Every plan is written for an executor model that has **zero context**: it has not seen the Grill interview, Improve audit, other plans, or prior conversation. It may be a smaller/cheaper model. Assume it is competent at following explicit instructions and weak at filling gaps, recovering from ambiguity, or knowing when to stop.

Three properties make a plan executable by a weaker model:

1. **Self-contained context** — everything needed is in the file: paths, code excerpts, conventions, commands.
2. **Verification gates** — every step ends with a command and its expected result. The executor never has to *judge* whether it succeeded.
3. **Hard boundaries and escape hatches** — explicit out-of-scope list, and "STOP and report" conditions instead of letting the model improvise when reality doesn't match the plan.

File naming: `herder-plans/NNN-short-slug.md`, numbered in recommended execution order.

---

## Template

```markdown
# Plan NNN: <Imperative title — what will be true after this plan>

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Never edit `herder-plans/README.md` during a
> Herder run; the root coordinator owns status transitions.
>
> **Drift check (run first)**: `git diff --stat <planned-at SHA>..HEAD -- <in-scope paths>`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 | P2 | P3
- **Effort**: S | M | L
- **Risk**: LOW | MED | HIGH
- **Depends on**: herder-plans/NNN-*.md (or "none")
- **Category**: feature | bug | security | perf | tests | tech-debt | migration | dx | docs | direction
- **Planned at**: commit `<short SHA>`, <YYYY-MM-DD>

## Why this matters

2–5 sentences. State the requested or discovered outcome, its concrete value,
and what improves when this lands. Written so the executor (and a human
reviewer) understands the intent — intent is what lets a correct judgment call
happen when a detail is off.

### Accepted decisions

- The behavior, terminology, and trade-offs confirmed during Grill or selected
  from Improve's verified findings.
- Explicit non-goals and rejected alternatives that constrain implementation.
- Omit conversation history; state only the durable decisions and their reasons.

## Current state

The facts the executor needs, inlined — never "as discussed" or "see audit":

- The relevant files, each with one line on its role:
  - `src/orders/api.ts` — order-list endpoint; contains the N+1 (lines 130–160)
- Excerpts of the code as it exists today (short, with `file:line` markers),
  enough that the executor can confirm it's looking at the right thing.
- The repo conventions that apply here, with a pointer to one exemplar file:
  "Error handling follows the Result pattern — see `src/lib/result.ts` and its
  use in `src/users/api.ts:40-60`. Match it."
- Any documented vocabulary or design constraints the plan must honor, inlined
  from the intent/design docs found in recon: the relevant `CONTEXT.md` terms
  the executor should use in names and comments, the `DESIGN.md` tokens/components
  to reuse, or the ADR whose decision this work must stay consistent with. Quote
  the specific lines — the executor has not read those docs.
- Any accepted glossary or architecture changes this work must record. Name the
  target `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/` file and describe the
  intended content without relying on the planning session.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `pnpm install`           | exit 0              |
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Tests     | `pnpm test -- <filter>`  | all pass            |
| Lint      | `pnpm lint`              | exit 0              |

(Exact commands from this repo — verified during recon, not guessed.)

## Suggested executor toolkit

(Optional — include only when relevant skills/tools plausibly exist in the
executor's environment. Skip the section otherwise.)

- Skills the executor should invoke if available, and for what:
  "use `vercel-react-best-practices` when writing the memoization in step 3".
- Reference docs worth reading before starting, by path or URL.

## Scope

**In scope** (the only files you should modify):
- `src/orders/api.ts`
- `src/orders/api.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/orders/legacy-api.ts` — deprecated path, scheduled for deletion;
  changing it wastes effort and risks the v1 clients still pinned to it.
- Any change to the public response shape — clients depend on it.
- Every explicit product or implementation non-goal accepted during planning.

## Git workflow

(Filled from recon — match the repo's observed conventions.)

- Branch: follow the repo's branch-naming convention; otherwise use `herder/NNN-<slug>`
- Commit per step or per logical unit; message style: <match repo, e.g. conventional commits — include an example from `git log`>
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: <imperative title>

What to do, precisely. Reference exact files/symbols. Include the target code
shape when it's load-bearing (the pattern to produce, not necessarily every
line).

**Verify**: `<command>` → <expected output>

### Step 2: ...

(Each step small enough to verify independently. Order steps so the codebase
is never broken between steps when possible — e.g. add new path, switch
callers, then remove old path.)

When accepted terminology or architectural constraints changed, include the
corresponding `CONTEXT.md` or ADR update as an ordered, verifiable step. Keep
domain glossaries free of implementation detail.

## Test plan

- New tests to write, in which file, covering which cases (list them:
  happy path, the specific bug/regression this plan fixes, named edge cases).
- Which existing test to use as the structural pattern:
  "model after `src/users/api.test.ts`".
- Verification: `<test command>` → all pass, including N new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests for <X> exist and pass
- [ ] `grep -rn "<old pattern>" src/` returns no matches
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] Required `CONTEXT.md` or ADR changes, when applicable, are present and match the accepted decision
- [ ] All done criteria above pass; the Herder coordinator owns status updates

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- You discover the assumption "<key assumption>" is false.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- What future changes will interact with this (e.g. "if pagination is added
  to this endpoint, the batching in step 2 must be revisited").
- What a reviewer should scrutinize in the PR.
- Any follow-up explicitly deferred out of this plan (and why).
```

---

## Index file: `herder-plans/README.md`

Written by a Herder plan producer and updated only by the Herder root coordinator during execution:

```markdown
# Implementation Plans

Generated by <Grill or Improve> on <date>. Execute in the order below unless
dependencies say otherwise. Each executor reads its plan fully and honors its
STOP conditions; only the Herder root coordinator updates status rows.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | ...   | P1       | S      | —          | TODO   |
| 002  | ...   | P1       | M      | 001        | TODO   |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale — finding fixed independently or approach abandoned)

## Dependency notes

- 002 requires 001 because <reason>.

## Considered and rejected

- <request, alternative, or finding>: rejected because <one line>.

<!-- Preserve the manager-generated "## Execution usage" section and its
marker comments verbatim below this point. Plan producers never write usage rows. -->
```

After `herder-plans init`, edit the descriptive and plan-index sections in place instead of replacing the entire README. Preserve the manager-generated execution-usage block so Fire can append attempt records and Plans can regenerate its plan/role/model summaries safely.

## Producer self-review — required before validation

After writing a draft, reread the saved plan from disk as if the planning session were unavailable. Check every item before running the Plans manager's mechanical validation:

1. **Intent or finding coverage** — "Why this matters", accepted decisions, non-goals, steps, tests, and done criteria all describe the same requested outcome or vetted finding. The draft introduces no unconfirmed product decision.
2. **Evidence** — current-state claims, file paths, symbols, excerpts, commands, dependencies, and conventions are verified against the repository rather than guessed. No secret value appears; name only its location and credential type.
3. **Executability** — a model new to the repository can execute the plan using only the plan and repository. Remove placeholders, "as discussed", vague references such as "the relevant module", judgment-only checks such as "make sure it works", and any hidden interview or audit context.
4. **Internal consistency** — Scope, drift-check paths, steps, test plan, done criteria, STOP conditions, dependencies, and the index agree. Every step names exact files or symbols and ends with a command plus expected result.
5. **Domain model** — accepted terminology, glossary changes, and ADR obligations are durable and consistent across current state, scope, ordered steps, and done criteria. Do not hide them in conversation history.
6. **Plan shape** — the draft is one coherent, independently testable unit. Its steps are small enough to verify, ordered by dependency, and explicit about inputs, outputs, and boundaries where those are not obvious.

Repair omissions or inconsistencies directly when doing so only clarifies already confirmed intent or verified evidence. If review exposes a missing product decision, material scope or approach choice, or a second plan, return to the producer's clarification or selection phase and obtain confirmation before finalizing. A STOP condition is not a substitute for a decision required to begin implementation.

Only after this semantic review passes, run `herder-plans validate`. Mechanical validation complements self-review; it does not replace it.
