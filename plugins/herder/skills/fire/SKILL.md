---
name: fire
description: Execute a validated herder-plans/ backlog as a dependency-aware multi-agent run with per-attempt token accounting. Use when the user asks to fire, run, resume, automatically complete Herder plans, or report a Fire run's token coverage using isolated implementer, reviewer, saver, and transactional integration worktrees. Do not use to create plans, repair plan formatting, or implement one ordinary task directly.
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
- Default plan directory: `herder-plans/`. If absent, stop and direct the user to `$herder:plans init` or `$herder:improve`.
- Default concurrency: the host's available worker capacity. Never exceed `--max-parallel`.
- Default integration branch: `plan-herder/integration-<UTC timestamp>`.
- `resume`: use the named integration branch. Without one, auto-select only when exactly one local `plan-herder/integration-*` branch exists.
- `status`: remain read-only. Combine Plans status and usage coverage with relevant Git branches and completion markers.

Do not introduce `plans/execution.yaml`, another required state file, or a second plan parser.

## Plans Boundary

Resolve the plugin root as two directories above this skill directory. The plan manager is:

```text
<plugin-root>/skills/plans/scripts/herder-plans.mjs
```

On Codex, the worker runner is:

```text
<plugin-root>/skills/fire/scripts/run-codex-worker.mjs
```

Use it for every plan operation:

```bash
node <manager> validate <plan-dir> --pretty
node <manager> ready <plan-dir> --pretty
node <manager> snapshot <plan-id> <plan-dir> --pretty
node <manager> transition <plan-id> "IN PROGRESS" <plan-dir> --pretty
node <manager> transition <plan-id> DONE <plan-dir> --pretty
node <manager> transition <plan-id> BLOCKED <plan-dir> --detail "<reason>" --pretty
node <manager> record-usage <plan-id|RUN> <role> <plan-dir> --attempt <id> --model <model> --effort <effort> --outcome <outcome> --source <source|unknown> --pretty
node <manager> usage <plan-dir> --pretty
```

Treat a nonzero exit as a coordinator failure. Fire must not parse or directly edit `README.md`. Only the root coordinator may run `transition` or `record-usage` during execution.

The backlog is local and Git-ignored by default, so it may not exist in any child worktree. Always run `snapshot` from the stable coordination checkout and inline its complete `planText` into implementer, reviewer, and saver prompts.

## Required Agent Roles

Require these logical roles:

- `plan-implementer` — implements one plan and commits only in its candidate worktree.
- `plan-reviewer` — independently reviews a staged candidate and never edits source.
- `plan-saver` — investigates and repairs a failed candidate in its rescue worktree; never approves or integrates it.

| Logical role | Codex profile | Claude identifier |
|--------------|---------------|-------------------|
| `plan-implementer` | `plan_implementer` | `herder:plan-implementer` |
| `plan-reviewer` | `plan_reviewer` | `herder:plan-reviewer` |
| `plan-saver` | `plan_saver` | `herder:plan-saver` |

Use each role's configured model and effort. Never hardcode models or substitute a generic role. Resolve the configured model and effort during preflight so every dispatched attempt can be attributed in the usage ledger; replace them with host-reported effective values only when the host exposes those values. Preflight all three before changing Git state. Workers must not spawn workers.

On Codex, do not call the collaboration spawn tool with only a matching task name: a task name is not proof that the custom profile was selected. Run `node <runner> --check --pretty` during preflight, then dispatch every attempt through the runner. It starts a separate `codex exec` worker with the bundled profile's explicit model, reasoning effort, developer instructions, sandbox, and nesting limit; it returns the worker's final message and structured JSONL usage. Write each complete worker prompt to a file under `<worktree-root>/prompts/` with `apply_patch`, never shell interpolation, and pass that file with `--prompt-file`.

Claude roles ship in this plugin and use the host-native identifiers above. `$herder:install` remains available to expose bundled Codex profiles for direct native use, but Fire does not depend on custom-agent discovery.

## Orchestrate

1. Read repository instructions and validate the backlog through Plans.
2. Complete preflight before mutation: Git/worktree support, role discovery, base commit, verification gates, branch names, and permissions.
3. Create a dedicated integration branch and worktree from the selected base. Never copy or commit `herder-plans/` into execution branches.
4. Ask Plans for the ready set. Transition each dispatched plan to `IN PROGRESS`, snapshot it, and create its candidate branch from the current integration HEAD.
5. Dispatch ready plans in parallel up to capacity. On Codex use the worker runner; on Claude use the host-native role. Inline the plan snapshot and require committed, scoped work plus tool-backed check results.
6. After every usage-bearing role probe or worker attempt returns, fails, or goes silent, record exactly one usage row through Plans before retrying, reviewing, rescuing, or integrating. Attribute Claude probes and cross-plan agents to `RUN`. Copy token values only from host telemetry; otherwise record `unknown`. Never estimate tokens. Codex runner preflight is configuration validation, not an agent attempt, so it does not create a usage row.
7. Stage each candidate on the latest integration HEAD, run all gates, create an empty completion-marker commit with `git commit --allow-empty` and subject `plan-herder(<plan-id>): mark plan done`, and obtain independent reviewer approval.
8. Fast-forward integration only after checks pass and the reviewer returns `APPROVE` with scope passing. Then transition the plan to `DONE` through Plans.
9. Route every implementation, staging, verification, review, or status-reconciliation failure through `plan-saver` before asking the user. A repair repeats staging, checks, marker creation, and review.
10. Recompute the ready set after every integration. Dispatch a dependent only after all dependency markers are ancestors of the new integration HEAD and their plan statuses are `DONE`.
11. Finish only when every plan is `DONE` or `REJECTED`, or remaining plans are terminally blocked after rescue. Include Plans' usage report and its coverage caveat in the final result.

If integration advances but the subsequent DONE transition fails, the completion marker is recovery evidence. Repair the plan index through Plans before dispatching dependents.

## Dependency Invariant

Never fork a dependent from a predecessor candidate. Fork from canonical integration HEAD only after every dependency is reviewed, integrated, marked `DONE`, and represented by a reachable `plan-herder(<id>): mark plan done` commit.

Independent plans may finish in any order. Stage each returned candidate onto the then-current integration HEAD so earlier integrations are present during global verification.

## Human Attention

Do not interrupt the user for ordinary engineering judgment, test failures, conflicts, plan drift, or a stopped implementer. Let `plan-saver` inspect first.

Ask one focused question only after `plan-saver` returns `NEEDS_INPUT` for genuinely missing intent, information, credentials, or authority. After the answer, automatically dispatch the saver again with the same rescue context plus the answer. Continue independent work meanwhile.

Stop for authorization before pushing, opening a pull request, deploying, publishing, changing external resources, production migrations, or destructive operations. The default result is a local verified integration branch/worktree; never merge it into the user's branch automatically.

## Safety

- Preserve the user's current branch, index, source changes, and untracked files. Plan status and usage-ledger updates made through Plans under the selected plan directory are the only allowed coordination-checkout writes.
- Keep implementation, rescue, staging, and integration isolated in worktrees.
- Anchor commands to absolute worktree paths; never depend on ambient shell state.
- On Codex, never add `--dangerously-bypass-approvals-and-sandbox` to worker runs. The runner uses noninteractive approvals, a read-only reviewer sandbox, and workspace-write sandboxes scoped to write workers plus the repository's Git common directory.
- Keep coordinator transactions fail-fast and prove integration HEAD is unchanged before retrying.
- Never expose secrets or accept worker claims without checks and independent review.
- Preserve failed branches as evidence; do not clean them without explicit authorization.
