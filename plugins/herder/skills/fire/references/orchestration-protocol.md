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
- `codex_runner`: on Codex, the absolute path to `skills/fire/scripts/run-codex-worker.mjs` inside the installed plugin.
- `base_commit`: current `HEAD` for a new run, or current integration HEAD for a resumed run.
- `run_id`: a filesystem- and branch-safe UTC timestamp or the suffix of the resumed integration branch.
- `integration_branch`: explicit argument or `plan-herder/integration-<run_id>`.
- `worktree_root`: a temporary directory outside the user's checkout.
- `prompt_root`: `<worktree_root>/prompts`, containing one immutable prompt file per Codex worker attempt.
- `usage_attempts`: stable per-role ordinals reconstructed from the README ledger on resume.

Read applicable repository instructions before dispatch. Inspect the user's checkout but do not clean, stash, reset, stage, or commit it.

For a new run, refuse an already-existing integration branch rather than repurposing it. For a resumed run, refuse a missing branch. Create or reopen an integration worktree for that branch.

Treat `plan_dir` as coordinator-owned local state. It is Git-ignored by default and must not be copied into integration, candidate, staging, or rescue branches. Obtain individual immutable dispatch snapshots through `plan_manager snapshot`.

## 2. Preflight Without Mutation

Complete all checks before creating branches or worktrees:

1. Confirm `git rev-parse --show-toplevel` and `git worktree list` succeed.
2. Run `node <plan_manager> validate <plan_dir> --pretty` and reject graph errors.
3. Confirm every indexed non-rejected plan file exists and is readable.
4. Resolve the three logical roles and their configured model/effort values. On Codex run `node <codex_runner> --check --pretty`; this validates all bundled profiles against the current Codex model catalog without starting a model turn, so it is not a usage-bearing attempt. Never use a collaboration task name as a substitute for selecting a Codex custom-agent profile. On Claude Code probe `herder:plan-implementer`, `herder:plan-reviewer`, and `herder:plan-saver`; a probe may only return `AVAILABLE`, is a usage-bearing `RUN` attempt, and must be recorded even when preflight later fails. Retain the configured values for usage attribution and replace them with host-reported effective values only when available.
5. Determine the repository-wide verification commands from repository instructions, CI configuration, and plan command tables. Do not guess commands when the plans specify them.
6. Check that branch names and intended worktree locations do not collide.

Also confirm that the host permission profile permits writes to Git metadata before mutation. Some Codex `workspace-write` profiles protect `.git`, which prevents `git worktree add` even when ordinary repository files are writable. In a controlled disposable environment, select an adequate permission profile before launching the run; otherwise stop at preflight and report the required permission rather than partially creating the run.

If Codex runner validation or a Claude role probe cannot run, report the missing logical role, model, effort, or host identifier. Generic fallback selection is forbidden.

## 3. Branch and Worktree Layout

Use names equivalent to:

```text
plan-herder/integration-<run-id>
plan-herder/<run-id>/<plan-id>-candidate
plan-herder/<run-id>/<plan-id>-stage-<attempt>
```

The coordinator creates branches and worktrees. When the host can spawn directly into a supplied isolated worktree, use that facility. Otherwise create the Git worktree first and pass its absolute path to the agent.

For a Codex attempt, create `<prompt_root>/<attempt-id>.md` with `apply_patch`. The file must contain the complete role prompt, including the immutable plan snapshot. Invoke the runner with an absolute worktree and prompt path:

```bash
node <codex_runner> --role <plan_implementer|plan_reviewer|plan_saver> \
  --worktree <absolute-worktree> \
  --prompt-file <absolute-prompt-file> \
  --pretty
```

The runner sends the prompt to `codex exec` over stdin, pins the bundled model and effort explicitly, disables nested delegation, and returns one JSON object. Its `message` is the worker envelope; its `usage` is structured host telemetry. Treat a nonzero runner exit, `ok: false`, or a missing message as an attempt failure. The prompt files are execution evidence; never commit them.

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

Give the resolved implementer role (`plan_implementer` through the Codex runner or `herder:plan-implementer` on Claude Code):

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

Tell the worker to use `unknown` for values not explicitly exposed by the host and never estimate from transcript length. On Codex, ignore the worker-authored `USAGE` line when the runner provides structured `usage`; the runner envelope wins. Treat missing commits, dirty intended changes, unverifiable checks, STOPPED, tool errors, or silence as failure and enter rescue. Record the attempt through Plans even when no response or usage envelope returns.

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
7. Dispatch `plan-reviewer` against the complete staging diff from the pre-plan integration SHA to staging HEAD.

### Reviewer prompt contract

Give the resolved reviewer role (`plan_reviewer` through the Codex runner or `herder:plan-reviewer` on Claude Code):

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

Tell the reviewer never to estimate unavailable usage. On Codex, prefer the runner's structured `usage` over the reviewer-authored `USAGE` line. Only `APPROVE` with `SCOPE: PASS` can integrate. Verify the integration branch still points to the staging base SHA, then fast-forward it to staging HEAD. If it moved, discard/rebuild staging from the new integration HEAD and review again. Record staging HEAD as the plan's completion commit, then transition the plan to `DONE` through the plan manager. If the transition fails, stop dependency dispatch and reconcile the index from the reachable marker before continuing.

If any merge, check, review, or compare-and-advance step fails, leave integration HEAD unchanged and enter rescue.

## 6. Rescue Before Escalation

Prepare the rescue environment; do not ask `plan-saver` to reconstruct missing candidate changes from a different checkout. Reuse the candidate branch/worktree when it safely contains the failed work. For integration-only failures, create a rescue branch/worktree from the latest integration HEAD and combine the candidate there first.

Give the resolved saver role (`plan_saver` through the Codex runner or `herder:plan-saver` on Claude Code) only:

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

Tell the saver never to estimate unavailable usage. On Codex, prefer the runner's structured `usage` over the saver-authored `USAGE` line. Record each saver round separately, including a round that ends in `NEEDS_INPUT`, `REPLAN`, or `TERMINAL`.

Handle outcomes:

- `REPAIRED`: treat the rescue branch as the new candidate. Repeat transactional staging, all checks, and independent review. The saver never self-approves.
- `REPLAN`: validate the evidence, revise the coordinator's plan file and index, validate them through Plans, discard stale staging, and dispatch a fresh implementer from the new integration HEAD. Do not commit the local plan directory into execution branches.
- `NEEDS_INPUT`: ensure the question is irreducible and focused, then ask the user exactly that question. Continue unrelated ready plans. After the answer, refresh the rescue branch onto the latest integration HEAD when necessary and automatically dispatch `plan-saver` again with the answer.
- `TERMINAL`: transition the plan to `BLOCKED` through Plans with a one-line reason and report it; do not fabricate a question.

Bound recovery to two autonomous saver repair rounds and two user clarification cycles per plan. After a bound is exhausted, transition the plan to `BLOCKED`, preserve the rescue branch, and report the evidence. A new explicit `resume` invocation may authorize another bounded cycle.

## 7. Usage Accounting

The root coordinator is the only usage-ledger writer. After every agent attempt reaches a terminal host state, call `plan_manager record-usage` before taking the next lifecycle action. Use an idempotent attempt ID such as `<run-id>-<plan-id>-<role>-<ordinal>`; use plan `RUN` for a final cross-plan reviewer or integration-rescue agent.

Attribute the configured model and effort resolved before dispatch. Prefer host-reported effective model/effort and structured usage over configured values and the worker's envelope when those fields are exposed. On Codex, copy `inputTokens`, `cachedInputTokens`, `outputTokens`, and `reasoningTokens` from the runner result and use source `codex-exec-jsonl`; the runner's `totalTokens` is only a convenience and is not passed to `record-usage`. If the runner reaches no terminal usage event, record every token field as `unknown` with source `unknown`. On Claude, copy structured host telemetry when available and otherwise use `unknown`. Never tokenize transcripts or infer hidden reasoning.

Use `plan_manager usage <plan_dir> --pretty` for reporting. Its token subtotal is input plus output for attempts where both are known; cached-input and reasoning columns are details, not additional tokens. Always report coverage beside subtotals. The README ledger covers recorded Herder attempts, not unobservable coordinator, platform, or retry overhead.

## 8. Resume Semantics

Reconstruct state from:

- `node <plan_manager> status <plan_dir> --pretty`;
- completion commits containing `plan-herder(<id>):`;
- candidate and staging branch names;
- branch ancestry and worktree cleanliness.
- the manager-generated usage ledger and existing attempt IDs.

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
