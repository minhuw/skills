---
name: fire
description: Execute a validated herder-plans/ backlog as a dependency-aware multi-agent run. Use when the user asks to fire, run, resume, or automatically complete Herder plans with isolated implementer, reviewer, saver, and transactional integration worktrees. Do not use to create plans, repair plan formatting, or implement one ordinary task directly.
---

# Herder Fire

Execute a Herder backlog from TODO to a verified integration branch while keeping the user's source checkout untouched. Delegate plan parsing and lifecycle state to Herder Plans; own only scheduling, agents, worktrees, review, rescue, and integration.

Read [references/orchestration-protocol.md](references/orchestration-protocol.md) completely before starting a `fire` or `resume` run.

## Invocation

Interpret tokens after the skill name as arguments. Codex users invoke `$herder:fire ...`; Claude Code users invoke `/herder:fire ...`.

```text
herder:fire [<plan-dir>] [--integration-branch <branch>] [--max-parallel <n>]
herder:fire resume [<plan-dir>] [--integration-branch <branch>] [--max-parallel <n>]
herder:fire status [<plan-dir>] [--integration-branch <branch>]
```

- Default command: `fire`.
- Default plan directory: `herder-plans/`. If absent, stop and direct a user-defined change to `$herder:grill <change>`, a repository audit to `$herder:improve`, or backlog setup to `$herder:plans init`.
- Default concurrency: the host's available worker capacity. Never exceed `--max-parallel`.
- Default integration branch: `plan-herder/integration-<UTC timestamp>`.
- `resume`: use the named integration branch. Without one, auto-select only when exactly one local `plan-herder/integration-*` branch exists.
- `status`: remain read-only. Combine Plans status with relevant Git branches and completion markers.

Do not introduce `plans/execution.yaml`, another required state file, or a second plan parser.

## Plans Boundary

Resolve the plugin root as two directories above this skill directory. The plan manager is:

```text
<plugin-root>/skills/plans/scripts/herder-plans.mjs
```

Use it for every plan operation:

```bash
node <manager> validate <plan-dir> --pretty
node <manager> ready <plan-dir> --pretty
node <manager> snapshot <plan-id> <plan-dir> --pretty
node <manager> transition <plan-id> "IN PROGRESS" <plan-dir> --pretty
node <manager> transition <plan-id> DONE <plan-dir> --pretty
node <manager> transition <plan-id> BLOCKED <plan-dir> --detail "<reason>" --pretty
```

Treat a nonzero exit as a coordinator failure. Fire must not parse or directly edit `README.md`. Only the root coordinator may run `transition` during execution.

The backlog is local and Git-ignored by default, so it may not exist in any child worktree. Always run `snapshot` from the stable coordination checkout and inline its complete `planText` into implementer, reviewer, and saver prompts.

## Required Agent Roles

Require these logical roles:

- `plan-implementer` — implements one plan and commits only in its candidate worktree.
- `plan-reviewer` — independently reviews a staged candidate and never edits source.
- `plan-saver` — investigates and repairs a failed candidate in its rescue worktree; never approves or integrates it.

| Logical role | Codex identifier | Claude identifier |
|--------------|------------------|-------------------|
| `plan-implementer` | `plan_implementer` | `herder:plan-implementer` |
| `plan-reviewer` | `plan_reviewer` | `herder:plan-reviewer` |
| `plan-saver` | `plan_saver` | `herder:plan-saver` |

Use each role's configured model and effort. Never hardcode models or substitute a generic role. Preflight all three before changing Git state. Workers must not spawn workers.

When a Codex role is missing, direct the user to `$herder:install`. Claude roles ship in this plugin. Do not install profiles during a Fire run because a new session may be required for discovery.

## Orchestrate

1. Read repository instructions and validate the backlog through Plans.
2. Complete preflight before mutation: Git/worktree support, role discovery, base commit, verification gates, branch names, and permissions.
3. Create a dedicated integration branch and worktree from the selected base. Never copy or commit `herder-plans/` into execution branches.
4. Ask Plans for the ready set. Transition each dispatched plan to `IN PROGRESS`, snapshot it, and create its candidate branch from the current integration HEAD.
5. Dispatch ready plans in parallel up to capacity. Inline the plan snapshot and require committed, scoped work plus tool-backed check results.
6. Stage each candidate on the latest integration HEAD, run all gates, create an empty completion-marker commit with `git commit --allow-empty` and subject `plan-herder(<plan-id>): mark plan done`, and obtain independent reviewer approval.
7. Fast-forward integration only after checks pass and the reviewer returns `APPROVE` with scope passing. Then transition the plan to `DONE` through Plans.
8. Route every implementation, staging, verification, review, or status-reconciliation failure through `plan-saver` before asking the user. A repair repeats staging, checks, marker creation, and review.
9. Recompute the ready set after every integration. Dispatch a dependent only after all dependency markers are ancestors of the new integration HEAD and their plan statuses are `DONE`.
10. Finish only when every plan is `DONE` or `REJECTED`, or remaining plans are terminally blocked after rescue.

If integration advances but the subsequent DONE transition fails, the completion marker is recovery evidence. Repair the plan index through Plans before dispatching dependents.

## Dependency Invariant

Never fork a dependent from a predecessor candidate. Fork from canonical integration HEAD only after every dependency is reviewed, integrated, marked `DONE`, and represented by a reachable `plan-herder(<id>): mark plan done` commit.

Independent plans may finish in any order. Stage each returned candidate onto the then-current integration HEAD so earlier integrations are present during global verification.

## Human Attention

Do not interrupt the user for ordinary engineering judgment, test failures, conflicts, plan drift, or a stopped implementer. Let `plan-saver` inspect first.

Ask one focused question only after `plan-saver` returns `NEEDS_INPUT` for genuinely missing intent, information, credentials, or authority. After the answer, automatically dispatch the saver again with the same rescue context plus the answer. Continue independent work meanwhile.

Stop for authorization before pushing, opening a pull request, deploying, publishing, changing external resources, production migrations, or destructive operations. The default result is a local verified integration branch/worktree; never merge it into the user's branch automatically.

## Safety

- Preserve the user's current branch, index, source changes, and untracked files. Plan status updates under the selected plan directory are the only allowed coordination-checkout writes.
- Keep implementation, rescue, staging, and integration isolated in worktrees.
- Anchor commands to absolute worktree paths; never depend on ambient shell state.
- Keep coordinator transactions fail-fast and prove integration HEAD is unchanged before retrying.
- Never expose secrets or accept worker claims without checks and independent review.
- Preserve failed branches as evidence; do not clean them without explicit authorization.
