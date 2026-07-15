# Plan Herder Orchestration Protocol

Use this protocol for every `fire` and `resume` run. The coordinator owns scheduling and integration. Agents own bounded candidate work; no child agent may spawn another child.

## Contents

1. Establish the run
2. Preflight without mutation
3. Branch and worktree layout
4. Dispatch ready plans
5. Transactional integration
6. Rescue before escalation
7. Usage accounting
8. Resume semantics
9. Completion

## 1. Establish the Run

Resolve:

- `repo_root`: absolute repository root.
- `plan_dir`: absolute Herder plan directory, normally `<repo_root>/herder-plans`.
- `plan_manager`: absolute path to `skills/plans/scripts/herder-plans.mjs` inside the installed plugin.
- `codex_evidence_reader`: on Codex, the absolute path to `skills/fire/scripts/read-codex-agent-evidence.mjs` inside the installed plugin.
- `base_commit`: current `HEAD` for a new run, or current integration HEAD for a resumed run.
- `run_id`: a filesystem- and branch-safe UTC timestamp or the suffix of the resumed integration branch.
- `integration_branch`: explicit argument or `plan-herder/integration-<run_id>`.
- `worktree_root`: a temporary directory outside the user's checkout.
- `usage_attempts`: stable per-role ordinals reconstructed from the README ledger on resume.
- `recovery_counters`: per-plan substantive saver rounds, clarification cycles, and same-round interruption restarts for the current invocation.

Read applicable repository instructions before dispatch. Inspect the user's checkout but do not clean, stash, reset, stage, or commit it.

For a new run, refuse an already-existing integration branch rather than repurposing it. For a resumed run, refuse a missing branch. Create or reopen an integration worktree for that branch.

Treat `plan_dir` as coordinator-owned local state. It is Git-ignored by default and must not be copied into integration, candidate, staging, or rescue branches. Obtain individual immutable dispatch snapshots through `plan_manager snapshot`.

## 2. Preflight Without Mutation

Complete all checks before creating branches or worktrees:

1. Confirm `git rev-parse --show-toplevel` and `git worktree list` succeed.
2. Run `node <plan_manager> validate <plan_dir> --pretty` and reject graph errors.
3. Confirm every indexed non-rejected plan file exists and is readable.
4. Resolve the three logical roles and their configured model/effort values. On Codex, require a live Multi-Agent V2 spawn schema in the `herder_agents` namespace containing both `agent_type` and `fork_turns`, and inspect the installed `plan_implementer`, `plan_reviewer`, and `plan_saver` definitions. Each must pin its expected model and effort. Never use a task name as a substitute for `agent_type`, and never perform a speculative model call during preflight. On Claude Code probe `herder:plan-implementer`, `herder:plan-reviewer`, and `herder:plan-saver`; a probe may only return `AVAILABLE`, is a usage-bearing `RUN` attempt, and must be recorded even when preflight later fails. Retain the configured values for usage attribution and replace them with host-reported effective values only when available.
5. Determine the repository-wide verification commands from repository instructions, CI configuration, and plan command tables. Do not guess commands when the plans specify them.
6. Check that branch names and intended worktree locations do not collide.

Also confirm that the host permission profile permits writes to Git metadata before mutation. Some Codex `workspace-write` profiles protect `.git`, which prevents `git worktree add` even when ordinary repository files are writable. In a controlled disposable environment, select an adequate permission profile before launching the run; otherwise stop at preflight and report the required permission rather than partially creating the run.

If the Codex V2 interface, a Codex custom profile, or a Claude role probe is unavailable, report the missing feature, logical role, model, effort, or host identifier. On Codex direct the user to `$herder:install`; do not fall back to nested `codex exec` or a generic agent.

## 3. Branch and Worktree Layout

Use names equivalent to:

```text
plan-herder/integration-<run-id>
plan-herder/<run-id>/<plan-id>-candidate
plan-herder/<run-id>/<plan-id>-stage-<attempt>
```

The coordinator creates branches and worktrees. When the host can spawn directly into a supplied isolated worktree, use that facility. Otherwise create the Git worktree first and pass its absolute path to the agent.

For a Codex attempt, call the native Multi-Agent V2 spawn tool with:

- a unique, stable `task_name` based on the run, plan, role, and ordinal;
- `agent_type` equal to `plan_implementer`, `plan_reviewer`, or `plan_saver`;
- `fork_turns: "none"` so unrelated coordinator history is not copied;
- one self-contained initial message containing the complete role prompt and immutable plan snapshot.

Omit `model`, `reasoning_effort`, and `service_tier`. The custom agent definition owns those values. Use the returned canonical task name for follow-up, wait, interrupt, and final-result handling. Treat spawn failure, terminal failure, silence, or a missing response envelope as an attempt failure for usage accounting, then apply Section 6 before deciding whether a saver repair round was consumed. Preserve the native child transcript as execution evidence when the host exposes it.

Keep the coordinator shell anchored in the user's stable original checkout or another stable directory. Execute every Git command with `git -C <absolute-worktree>` and every non-Git command with an explicit tool workdir or scoped `(cd <absolute-worktree> && ...)` subshell. Never depend on an ambient `cwd`, and never remove or recreate the directory containing the coordinator process.

Keep one candidate branch per plan. On resume, inspect an existing candidate branch and its commits rather than overwriting it. Recreate a missing worktree from the branch when necessary.

## 4. Dispatch Ready Plans

At each scheduling pass:

1. Run `node <plan_manager> ready <plan_dir> --pretty` from the stable coordination checkout.
   Its `ready` list contains dependency-satisfied `TODO` plans only. Route `blocked` plans to Saver and reconstruct `inProgress` plans through resume semantics; never treat either list as fresh implementer work.
2. Select actionable plans whose dependencies are all `DONE`.
3. Find each dependency's coordinator completion commit by its exact `plan-herder(<id>): mark plan done` subject.
4. Verify every completion commit is an ancestor of integration HEAD.
5. Create the candidate branch from that exact integration HEAD and record the candidate base SHA.
6. Verify the dependency commits are ancestors of the candidate base.
7. Mark every selected plan `IN PROGRESS` through `plan_manager transition` as a batch before dispatch; workers never edit the index.
8. Dispatch up to the available concurrency limit.

Do not serialize independent plans unnecessarily. Do not dispatch a dependent merely because a dependency's implementer finished; wait for reviewed integration and `DONE` status.

### Implementer prompt contract

Give the resolved implementer role (`plan_implementer` through Codex Multi-Agent V2 or `herder:plan-implementer` on Claude Code):

- its role and the prohibition on spawning agents;
- the absolute candidate worktree path and branch;
- the candidate base SHA;
- the complete `planText` returned by `plan_manager snapshot`, always inlined;
- applicable repository instructions;
- an instruction never to edit `herder-plans/README.md` or any plan status;
- the stable attempt ID and resolved model/effort attribution;
- a requirement to stay in scope, honor STOP conditions, run every gate, and commit all intended changes;
- this exact response shape:

```text
STATUS: COMPLETE | STOPPED | FAILED
COMMITS: <ordered SHAs, or none>
CHECKS: <command — result, one per line>
FILES CHANGED: <paths>
STOPPED BECAUSE: <only when not COMPLETE>
NOTES: <material facts only>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Tell the worker to use `unknown` for values not explicitly exposed by the host and never estimate from transcript length. Structured host telemetry wins over the worker-authored `USAGE` line. Treat missing commits, dirty intended changes, unverifiable checks, STOPPED, tool errors, or silence as failure and enter rescue. Record the attempt through Plans even when no response or usage envelope returns.

## 5. Transactional Integration

Never test a candidate by first advancing the integration branch.

Run each coordinator transaction fail-fast (`set -e` or one checked command per tool call). Treat every nonzero exit as the end of that transaction; do not continue with empty or stale shell variables. Before retrying, prove that canonical integration HEAD still equals the transaction's recorded staging-base SHA.

For each candidate:

1. Create a new staging branch/worktree from the latest integration HEAD.
2. Merge the candidate with a non-fast-forward coordinator commit containing `plan-herder(<id>): stage candidate`, or apply its commits in order when repository policy requires linear history.
3. Resolve no substantive conflict in the coordinator. A conflict is a rescue event.
4. Confirm the diff is limited to the plan's scope, except generated artifacts explicitly caused by its gates.
5. Run every plan done criterion and the applicable project-wide gates in the staging worktree.
6. Create an empty coordinator completion-marker commit with `git commit --allow-empty -m "plan-herder(<id>): mark plan done"`.
7. Record the staging worktree's clean status and tree SHA, dispatch `plan-reviewer` against the complete staging diff from the pre-plan integration SHA to staging HEAD, and prove both are unchanged after review. Any reviewer mutation is a failed review even if its verdict says APPROVE.

### Reviewer prompt contract

Give the resolved reviewer role (`plan_reviewer` through Codex Multi-Agent V2 or `herder:plan-reviewer` on Claude Code):

- its role and the prohibition on editing or spawning agents;
- the absolute staging worktree path and branch;
- the complete plan text;
- the base and staged HEAD SHAs;
- the actual checks run and their results;
- the stable attempt ID and resolved model/effort attribution;
- instructions to inspect the diff, trace every hunk to the plan, verify scope and behavior, and run additional read-only or verification commands as needed;
- this exact response shape:

```text
VERDICT: APPROVE | REVISE | BLOCK
FINDINGS: <ordered findings with file:line evidence, or none>
SCOPE: PASS | FAIL
CHECKS: <independently verified commands/results>
RATIONALE: <concise>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Tell the reviewer never to estimate unavailable usage. Prefer structured host telemetry over the reviewer-authored `USAGE` line. Only `APPROVE` with `SCOPE: PASS` can integrate. Verify the integration branch still points to the staging base SHA, then fast-forward it to staging HEAD. If it moved, discard/rebuild staging from the new integration HEAD and review again. Record staging HEAD as the plan's completion commit, then transition the plan to `DONE` through the plan manager. If the transition fails, stop dependency dispatch and reconcile the index from the reachable marker before continuing.

If any merge, check, review, or compare-and-advance step fails, leave integration HEAD unchanged and enter rescue.

## 6. Rescue Before Escalation

Prepare the rescue environment; do not ask `plan-saver` to reconstruct missing candidate changes from a different checkout. Reuse the candidate branch/worktree when it safely contains the failed work. For integration-only failures, create a rescue branch/worktree from the latest integration HEAD and combine the candidate there first.

An **agent attempt** is one host spawn and always receives a unique usage row. A **saver repair round** is a substantive saver result or a saver attempt that may have changed the rescue branch. Host interruption alone does not consume a repair round when all no-mutation invariants below are proven.

Before every saver dispatch, record:

- integration HEAD;
- rescue branch HEAD and tree SHA;
- the exact `git status --porcelain=v1 --untracked-files=all` result and whether it is empty; and
- the repair-round number plus the attempt ordinal.

A dirty rescue worktree may contain the failed work Saver must recover, but it is ineligible for a no-cost interruption restart. Never reset, clean, stash, or discard files merely to make an attempt eligible.

Give the resolved saver role (`plan_saver` through Codex Multi-Agent V2 or `herder:plan-saver` on Claude Code) only:

- the absolute rescue worktree path;
- branch name;
- the complete snapshotted plan text, always inlined because the plan directory may be absent from the worktree;
- the statement that the previous attempt failed;
- the expected outcome: inspect Git/repository state, reproduce relevant gates, repair and commit if possible, or classify the blocker;
- the user's answer when resuming after `NEEDS_INPUT`.
- the stable attempt ID and resolved model/effort attribution.

Do not pass implementer or reviewer theories by default. Let the saver inspect status, log, diff, repository instructions, and tests independently. Add the exact failing command/output only when the failure is integration-only or cannot be reproduced from the rescue worktree.

Require this response shape:

```text
OUTCOME: REPAIRED | REPLAN | NEEDS_INPUT | TERMINAL
COMMITS: <ordered SHAs, or none>
CHECKS: <command — result, one per line>
QUESTION: <one focused question only for NEEDS_INPUT>
REPLAN: <specific corrected assumption/plan text only for REPLAN>
EVIDENCE: <concise repository/tool evidence>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Tell the saver never to estimate unavailable usage. Prefer structured host telemetry over the saver-authored `USAGE` line. Record each saver attempt separately, including one that ends in `INTERRUPTED`, `NEEDS_INPUT`, `REPLAN`, or `TERMINAL`.

### Host interruption

Classify a saver attempt as `INTERRUPTED` only when every condition holds:

1. The native host state is spawn-failed, errored, aborted, disconnected, or timed out because of platform, policy/classifier, transport, or session-runtime failure—not a repository command failure or child-authored `OUTCOME`.
2. No parseable final saver envelope exists. A transcript `task_complete` event without a final agent message is not a successful result; the native host state is authoritative.
3. Integration HEAD, rescue HEAD, and rescue tree SHA exactly match their pre-dispatch values.
4. The rescue worktree was clean before dispatch and remains clean afterward, including untracked files.

If any condition is unknown or false, record `FAILED`, consume the repair round, preserve the branch, and continue normal rescue handling. Do not infer safety from a missing response alone.

For a proven interruption:

1. Record exact available usage with outcome `INTERRUPTED` under a new attempt ID.
2. Do not increment the saver repair-round or user-clarification counters.
3. Start a fresh agent session for the same round with the next role attempt ordinal. Give it the normal minimal saver prompt plus only the fact that the previous host attempt ended before any repository mutation; do not replay classifier text or prior theories.
4. Permit at most two same-round interruption restarts. If all are interrupted, transition the plan to `BLOCKED` with an infrastructure/policy reason, preserve the unused substantive recovery budget in the report, and stop that plan. Do not describe this as exhausting the saver repair limit.

Every restarted spawn is still an independently attributable usage attempt. Never reuse an interrupted agent session or attempt ID.

Handle outcomes:

- `REPAIRED`: treat the rescue branch as the new candidate. Repeat transactional staging, all checks, and independent review. The saver never self-approves.
- `REPLAN`: validate the evidence, revise the coordinator's plan file and index, validate them through Plans, discard stale staging, and dispatch a fresh implementer from the new integration HEAD. Do not commit the local plan directory into execution branches.
- `NEEDS_INPUT`: ensure the question is irreducible and focused, then ask the user exactly that question. Continue unrelated ready plans. After the answer, refresh the rescue branch onto the latest integration HEAD when necessary and automatically dispatch `plan-saver` again with the answer.
- `TERMINAL`: transition the plan to `BLOCKED` through Plans with a one-line reason and report it; do not fabricate a question.

Bound recovery to two substantive autonomous saver repair rounds and two user clarification cycles per plan. `INTERRUPTED` usage rows do not count toward either bound. After a substantive or interruption-restart bound is exhausted, transition the plan to `BLOCKED`, preserve the rescue branch, and report which bound ended the run. A new explicit `resume` invocation may authorize another bounded cycle.

## 7. Usage Accounting

The root coordinator is the only usage-ledger writer. After every agent attempt reaches a terminal host state, call `plan_manager record-usage` before taking the next lifecycle action. Use an idempotent attempt ID such as `<run-id>-<plan-id>-<role>-<ordinal>`; increment the ordinal for same-round interruption restarts and use plan `RUN` for a final cross-plan reviewer or integration-rescue agent. Record the normalized outcome, including `INTERRUPTED`, so attempt count and substantive recovery count can be reconstructed separately.

Attribute the configured model and effort resolved before dispatch. Prefer host-reported effective model/effort and structured usage over configured values and the worker's envelope when those fields are exposed. On Codex, after a child reaches a terminal state, run `node <codex_evidence_reader> --agent <returned-canonical-task-name> --pretty`. Require its `agentRole` to match the requested custom profile and its `multiAgentVersion` to be `v2`; a mismatch is a routing failure. Use its `terminal.taskComplete`, `terminal.turnAborted`, and `terminal.finalEnvelopePresent` fields together with the native agent state when classifying interruptions; `taskComplete` alone is insufficient. When its `usage` is present, copy the exact fields and source `codex-multi-agent-v2-transcript`. If no uniquely attributable terminal usage exists, record every token field as `unknown` with source `unknown`. On Claude, copy structured host telemetry when available and otherwise use `unknown`. Never tokenize transcripts, subtract coordinator totals, or infer hidden reasoning.

Use `plan_manager usage <plan_dir> --pretty` for reporting. Its token subtotal is input plus output for attempts where both are known; cached-input and reasoning columns are details, not additional tokens. Always report coverage beside subtotals. The README ledger covers recorded Herder attempts, not unobservable coordinator, platform, or retry overhead.

## 8. Resume Semantics

Reconstruct state from:

- `node <plan_manager> status <plan_dir> --pretty`;
- completion commits containing `plan-herder(<id>):`;
- candidate and staging branch names;
- branch ancestry and worktree cleanliness.
- the manager-generated usage ledger and existing attempt IDs.

Treat saver ledger rows with outcome `INTERRUPTED` as attempts but not substantive repair rounds. Continue attempt ordinals after them. An explicit resume starts a new bounded recovery cycle, but never rewrites or drops prior interruption usage.

For `IN PROGRESS`, inspect its candidate branch. If it contains committed work, stage and review it; if it has no usable work, dispatch a fresh implementer. For `BLOCKED`, start with a saver when a rescue branch exists; otherwise create a fresh candidate from integration HEAD and let the saver investigate the plan and repository.

Never trust a `DONE` row alone. Verify its completion marker is reachable from integration HEAD and re-run cheap done criteria when resuming. If a marker is missing or verification fails, transition it to `BLOCKED` through Plans and enter rescue before allowing dependents to start. Conversely, if a reachable marker exists while the index is not DONE, reconcile that status before dispatching dependents. Continue role ordinals after the highest recorded attempt; never duplicate or rewrite a prior usage row.

## 9. Completion

The run succeeds when every plan is `DONE` or `REJECTED`, all dependency markers are ancestors of integration HEAD, the final project-wide gates pass, and a final reviewer audit finds no cross-plan integration regression.

If that final gate or audit fails, create an integration-rescue branch/worktree from integration HEAD and send `plan-saver` a synthetic plan containing the failing final criterion and expected integrated behavior. Treat any repair as a new transaction: stage it from the unchanged integration HEAD, run all final gates, obtain a fresh reviewer approval, and only then advance integration.

Do not merge, push, publish, deploy, or delete the preserved candidate/rescue evidence unless the user explicitly requests it. Report:

- integration branch and absolute worktree;
- final commit SHA;
- plans completed/rejected/blocked;
- final verification commands and results;
- usage subtotals and coverage by plan, role, and model/effort;
- preserved branches needing attention.
