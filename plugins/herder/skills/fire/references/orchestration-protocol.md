# Plan Herder Orchestration Protocol

Use this protocol for every `fire` and `resume` run. The coordinator owns scheduling and integration. Agents own bounded candidate work; no child agent may spawn another child.

## Contents

1. Establish the run
2. Preflight without mutation
3. Branch and worktree layout
4. Dispatch ready plans
5. Transactional integration
6. Rescue before escalation
7. Resume semantics
8. Completion

## 1. Establish the Run

Resolve:

- `repo_root`: absolute repository root.
- `plan_dir`: absolute Improve-style plan directory.
- `base_commit`: current `HEAD` for a new run, or current integration HEAD for a resumed run.
- `run_id`: a filesystem- and branch-safe UTC timestamp or the suffix of the resumed integration branch.
- `integration_branch`: explicit argument or `plan-herder/integration-<run_id>`.
- `worktree_root`: a temporary directory outside the user's checkout.

Read applicable repository instructions before dispatch. Inspect the user's checkout but do not clean, stash, reset, stage, or commit it.

For a new run, refuse an already-existing integration branch rather than repurposing it. For a resumed run, refuse a missing branch. Create or reopen an integration worktree for that branch.

If the plan directory is not present at `base_commit`, or its working-copy content differs, copy the exact plan snapshot into the integration worktree and commit only that directory. Do not copy unrelated dirty files.

## 2. Preflight Without Mutation

Complete all checks before creating branches or worktrees:

1. Confirm `git rev-parse --show-toplevel` and `git worktree list` succeed.
2. Run `scripts/plan-graph.mjs` and reject graph errors.
3. Confirm every indexed non-rejected plan file exists and is readable.
4. Resolve or probe the three logical roles. On Codex use `plan_implementer`, `plan_reviewer`, and `plan_saver`; on Claude Code use `herder:plan-implementer`, `herder:plan-reviewer`, and `herder:plan-saver`. A probe may only ask the mapped role to return `AVAILABLE`; do not give it repository work.
5. Determine the repository-wide verification commands from repository instructions, CI configuration, and plan command tables. Do not guess commands when the plans specify them.
6. Check that branch names and intended worktree locations do not collide.

Also confirm that the host permission profile permits writes to Git metadata before mutation. Some Codex `workspace-write` profiles protect `.git`, which prevents `git worktree add` even when ordinary repository files are writable. In a controlled disposable environment, select an adequate permission profile before launching the run; otherwise stop at preflight and report the required permission rather than partially creating the run.

If a role probe cannot run, report the missing logical role and expected host identifier. Role configuration—including its model and reasoning effort—is the user's responsibility; generic fallback selection is forbidden.

## 3. Branch and Worktree Layout

Use names equivalent to:

```text
plan-herder/integration-<run-id>
plan-herder/<run-id>/<plan-id>-candidate
plan-herder/<run-id>/<plan-id>-stage-<attempt>
```

The coordinator creates branches and worktrees. When the host can spawn directly into a supplied isolated worktree, use that facility. Otherwise create the Git worktree first and pass its absolute path to the agent.

Keep the coordinator shell anchored in the user's stable original checkout or another stable directory. Execute every Git command with `git -C <absolute-worktree>` and every non-Git command with an explicit tool workdir or scoped `(cd <absolute-worktree> && ...)` subshell. Never depend on an ambient `cwd`, and never remove or recreate the directory containing the coordinator process.

Keep one candidate branch per plan. On resume, inspect an existing candidate branch and its commits rather than overwriting it. Recreate a missing worktree from the branch when necessary.

## 4. Dispatch Ready Plans

At each scheduling pass:

1. Re-run the graph parser against the integration worktree's plan directory.
2. Select actionable plans whose dependencies are all `DONE`.
3. Find each dependency's coordinator completion commit by its exact `plan-herder(<id>): mark plan done` subject.
4. Verify every completion commit is an ancestor of integration HEAD.
5. Create the candidate branch from that exact integration HEAD and record the candidate base SHA.
6. Verify the dependency commits are ancestors of the candidate base.
7. Mark the plan `IN PROGRESS` in coordinator-owned state/index as a batch before dispatch when persistence is needed; workers never edit the index.
8. Dispatch up to the available concurrency limit.

Do not serialize independent plans unnecessarily. Do not dispatch a dependent merely because a dependency's implementer finished; wait for reviewed integration and `DONE` status.

### Implementer prompt contract

Give the resolved implementer role (`plan_implementer` on Codex or `herder:plan-implementer` on Claude Code):

- its role and the prohibition on spawning agents;
- the absolute candidate worktree path and branch;
- the candidate base SHA;
- the complete plan text, inlined even when also available as a file;
- applicable repository instructions;
- an override to skip any plan instruction to update `plans/README.md`;
- a requirement to stay in scope, honor STOP conditions, run every gate, and commit all intended changes;
- this exact response shape:

```text
STATUS: COMPLETE | STOPPED | FAILED
COMMITS: <ordered SHAs, or none>
CHECKS: <command — result, one per line>
FILES CHANGED: <paths>
STOPPED BECAUSE: <only when not COMPLETE>
NOTES: <material facts only>
```

Treat missing commits, dirty intended changes, unverifiable checks, STOPPED, tool errors, or silence as failure and enter rescue.

## 5. Transactional Integration

Never test a candidate by first advancing the integration branch.

Run each coordinator transaction fail-fast (`set -e` or one checked command per tool call). Treat every nonzero exit as the end of that transaction; do not continue with empty or stale shell variables. Before retrying, prove that canonical integration HEAD still equals the transaction's recorded staging-base SHA.

For each candidate:

1. Create a new staging branch/worktree from the latest integration HEAD.
2. Merge the candidate with a non-fast-forward coordinator commit containing `plan-herder(<id>): stage candidate`, or apply its commits in order when repository policy requires linear history.
3. Resolve no substantive conflict in the coordinator. A conflict is a rescue event.
4. Confirm the diff is limited to the plan's scope, except generated artifacts explicitly caused by its gates.
5. Run every plan done criterion and the applicable project-wide gates in the staging worktree.
6. Update the index row to `DONE` in staging and commit it with subject `plan-herder(<id>): mark plan done`.
7. Re-run any check affected by the index commit.
8. Dispatch `plan-reviewer` against the complete staging diff from the pre-plan integration SHA to staging HEAD.

### Reviewer prompt contract

Give the resolved reviewer role (`plan_reviewer` on Codex or `herder:plan-reviewer` on Claude Code):

- its role and the prohibition on editing or spawning agents;
- the absolute staging worktree path and branch;
- the complete plan text;
- the base and staged HEAD SHAs;
- the actual checks run and their results;
- instructions to inspect the diff, trace every hunk to the plan, verify scope and behavior, and run additional read-only or verification commands as needed;
- this exact response shape:

```text
VERDICT: APPROVE | REVISE | BLOCK
FINDINGS: <ordered findings with file:line evidence, or none>
SCOPE: PASS | FAIL
CHECKS: <independently verified commands/results>
RATIONALE: <concise>
```

Only `APPROVE` with `SCOPE: PASS` can integrate. Verify the integration branch still points to the staging base SHA, then fast-forward it to staging HEAD. If it moved, discard/rebuild staging from the new integration HEAD and review again. Record staging HEAD as the plan's completion commit.

If any merge, check, review, or compare-and-advance step fails, leave integration HEAD unchanged and enter rescue.

## 6. Rescue Before Escalation

Prepare the rescue environment; do not ask `plan-saver` to reconstruct missing candidate changes from a different checkout. Reuse the candidate branch/worktree when it safely contains the failed work. For integration-only failures, create a rescue branch/worktree from the latest integration HEAD and combine the candidate there first.

Give the resolved saver role (`plan_saver` on Codex or `herder:plan-saver` on Claude Code) only:

- the absolute rescue worktree path;
- branch name;
- the complete plan text or an accessible absolute path (inline it when uncommitted or absent from the worktree);
- the statement that the previous attempt failed;
- the expected outcome: inspect Git/repository state, reproduce relevant gates, repair and commit if possible, or classify the blocker;
- the user's answer when resuming after `NEEDS_INPUT`.

Do not pass implementer or reviewer theories by default. Let the saver inspect status, log, diff, repository instructions, and tests independently. Add the exact failing command/output only when the failure is integration-only or cannot be reproduced from the rescue worktree.

Require this response shape:

```text
OUTCOME: REPAIRED | REPLAN | NEEDS_INPUT | TERMINAL
COMMITS: <ordered SHAs, or none>
CHECKS: <command — result, one per line>
QUESTION: <one focused question only for NEEDS_INPUT>
REPLAN: <specific corrected assumption/plan text only for REPLAN>
EVIDENCE: <concise repository/tool evidence>
```

Handle outcomes:

- `REPAIRED`: treat the rescue branch as the new candidate. Repeat transactional staging, all checks, and independent review. The saver never self-approves.
- `REPLAN`: validate the evidence, revise the plan/index on the integration branch, commit the revision, discard stale staging, and dispatch a fresh implementer from the new integration HEAD.
- `NEEDS_INPUT`: ensure the question is irreducible and focused, then ask the user exactly that question. Continue unrelated ready plans. After the answer, refresh the rescue branch onto the latest integration HEAD when necessary and automatically dispatch `plan-saver` again with the answer.
- `TERMINAL`: mark `BLOCKED` with a one-line reason and report it; do not fabricate a question.

Bound recovery to two autonomous saver repair rounds and two user clarification cycles per plan. After a bound is exhausted, mark the plan `BLOCKED`, preserve the rescue branch, and report the evidence. A new explicit `resume` invocation may authorize another bounded cycle.

## 7. Resume Semantics

Reconstruct state from:

- the integration branch's `README.md` status table;
- completion commits containing `plan-herder(<id>):`;
- candidate and staging branch names;
- branch ancestry and worktree cleanliness.

For `IN PROGRESS`, inspect its candidate branch. If it contains committed work, stage and review it; if it has no usable work, dispatch a fresh implementer. For `BLOCKED`, start with a saver when a rescue branch exists; otherwise create a fresh candidate from integration HEAD and let the saver investigate the plan and repository.

Never trust a `DONE` row alone. Verify its completion marker is reachable from integration HEAD and re-run cheap done criteria when resuming. If a marker is missing or verification fails, return the plan to rescue before allowing dependents to start.

## 8. Completion

The run succeeds when every plan is `DONE` or `REJECTED`, all dependency markers are ancestors of integration HEAD, the final project-wide gates pass, and a final reviewer audit finds no cross-plan integration regression.

If that final gate or audit fails, create an integration-rescue branch/worktree from integration HEAD and send `plan-saver` a synthetic plan containing the failing final criterion and expected integrated behavior. Treat any repair as a new transaction: stage it from the unchanged integration HEAD, run all final gates, obtain a fresh reviewer approval, and only then advance integration.

Do not merge, push, publish, deploy, or delete the preserved candidate/rescue evidence unless the user explicitly requests it. Report:

- integration branch and absolute worktree;
- final commit SHA;
- plans completed/rejected/blocked;
- final verification commands and results;
- preserved branches needing attention.
