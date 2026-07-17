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
10. Cleanup

## 1. Establish the Run

Resolve:

- `repo_root`: absolute repository root.
- `plan_dir`: absolute Herder plan directory, normally `<repo_root>/herder-plans`.
- `plan_manager`: absolute path to `skills/plans/scripts/herder-plans.mjs` inside the installed plugin.
- `codex_evidence_reader`: on Codex, the absolute path to `skills/fire/scripts/read-codex-agent-evidence.mjs` inside the installed plugin.
- `gate_runner`: absolute path to `skills/fire/scripts/run-gate.mjs` inside the installed plugin.
- `base_commit`: current `HEAD` for a new run, or current integration HEAD for a resumed run.
- `run_id`: a filesystem- and branch-safe UTC timestamp or the suffix of the resumed integration branch.
- `integration_branch`: explicit argument or `plan-herder/integration-<run_id>`.
- `worktree_root`: a temporary directory outside the user's checkout.
- `gate_log_root`: `<worktree_root>/logs`, outside every integration, candidate, staging, and rescue worktree.
- `usage_attempts`: stable per-role ordinals reconstructed from the README ledger on resume.
- `recovery_state`: per-plan generation IDs, substantive saver rounds, clarification cycles, bounded non-capacity interruption restarts, transient-capacity backoff state, accepted replans, and compact failure signatures for the current invocation.
- `review_state`: per-plan-generation broad-pass count, reviewed artifact SHAs, ordered repair deltas, and a coordinator-owned stable finding ledger. Use a separate ledger with the same rules for the final cross-plan audit.
- `candidate_replay`: the coordinator-recorded replay-base SHA, candidate HEAD, and ordered merge-free commit list for each candidate or rescue artifact.

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
plan-herder/<run-id>/<plan-id>-rescue-<attempt>
```

The coordinator creates branches and worktrees. When the host can spawn directly into a supplied isolated worktree, use that facility. Otherwise create the Git worktree first and pass its absolute path to the agent.

Lock a candidate, staging, or rescue worktree with `git worktree lock --reason plan-herder:<run-id>:<plan-id>:<role>:<attempt-id>:<task-name>` while an agent can still access it. Use the stable attempt ID and requested task name so a resumed coordinator can identify the prior owner before it has native agent state. Only the root coordinator may unlock it, and only after the agent is terminal and no retry can reuse that session. A lock is a cleanup lease, not lifecycle state; Plans remains the sole plan-state owner.

For a Codex attempt, call the native Multi-Agent V2 spawn tool with:

- a unique, stable `task_name` based on the run, plan, role, and ordinal;
- `agent_type` equal to `plan_implementer`, `plan_reviewer`, or `plan_saver`;
- `fork_turns: "none"` so unrelated coordinator history is not copied;
- one self-contained initial message containing the complete role prompt and immutable plan snapshot.

Omit `model`, `reasoning_effort`, and `service_tier`. The custom agent definition owns those values. Use the returned canonical task name for follow-up, wait, interrupt, and final-result handling. Treat spawn failure, terminal failure, or a native terminal state without a response envelope as an attempt failure for usage accounting, then apply Section 6 before deciding whether a saver repair round was consumed. A merely quiet running worker is not a failed attempt; continue the event-driven wait unless the user supplied a deadline. Preserve the native child transcript as execution evidence when the host exposes it.

Keep the coordinator shell anchored in the user's stable original checkout or another stable directory. Execute every Git command with `git -C <absolute-worktree>` and every non-Git command with an explicit tool workdir or scoped `(cd <absolute-worktree> && ...)` subshell. Never depend on an ambient `cwd`, and never remove or recreate the directory containing the coordinator process.

Keep one candidate branch per plan. On resume, inspect an existing candidate branch and its commits rather than overwriting it. Recreate a missing worktree from the branch when necessary.

Before creating any candidate, staging, or rescue branch, inventory the recognized branches and worktrees for that plan. Reuse an existing artifact when its branch, base, replay commits, cleanliness, and lease state match the lifecycle step. Never create a second staging or rescue artifact merely because the coordinator resumed, lost conversational context, or has not yet reconciled an old lock.

Implementers and Savers may run in parallel, but serialize staging, review, and integration advancement across the run. From creation or validated reuse of a staging artifact until its review/integration transaction reaches a terminal result, do not advance integration for another plan. This prevents an unrelated fast-forward from invalidating several live stages and forcing branch-generating replays.

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
- a requirement to summarize checks without pasting command logs;
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

Tell the worker to use `unknown` for values not explicitly exposed by the host and never estimate from transcript length. Structured host telemetry wins over the worker-authored `USAGE` line. Treat missing commits, dirty intended changes, unverifiable checks, STOPPED, tool errors, or a terminal attempt without a response as failure and enter rescue. Record the attempt through Plans even when no response or usage envelope returns.

### Coordinator wait discipline

After dispatching Codex workers, call native `wait_agent` with `timeout_ms: 600000`. It is a long poll: any agent update, including completion, ends the wait immediately; otherwise the timeout supplies a ten-minute heartbeat. The timeout caps idle wakeups, not result-delivery latency. Process every queued update before waiting again.

A timeout is not a state change. If no local scheduling or integration work became ready, do not reread transcripts, request status, or call `list_agents`; issue the next long wait. Use `list_agents` only for initial bookkeeping or reconciliation after an ambiguous, missing, or contradictory terminal event. On Claude Code, use its native blocking agent wait with the same event-first behavior.

## 5. Transactional Integration

Never test a candidate by first advancing the integration branch.

Run every coordinator-owned verification gate, including final project-wide gates, through:

```text
node <gate_runner> --cwd <absolute-worktree> --log-dir <gate_log_root>/<plan-or-RUN>/<phase> --label <stable-label> -- <command> <arguments...>
```

Pass the exact command as argv after `--`; do not add a shell unless the specified verification command itself requires one. Never place secrets in command arguments. The runner writes combined stdout/stderr to a unique private log and returns only a command fingerprint, exit status, duration, byte count, SHA-256, and log path. It returns no command output on success or failure. Treat that compact JSON as the check result; never inline, stringify, or reread a complete gate log in coordinator context. Let Saver reproduce failed gates in its isolated context instead of feeding their output to the coordinator. Preserve the log with the failed worktree evidence. Git state-inspection commands are not verification gates and need not use the runner.

Run each coordinator transaction fail-fast (`set -e` or one checked command per tool call). Treat every nonzero exit as the end of that transaction; do not continue with empty or stale shell variables. Before retrying, prove that canonical integration HEAD still equals the transaction's recorded staging-base SHA.

For each candidate:

1. Record the candidate replay base and candidate HEAD. The replay base is the coordinator-recorded branch point before the implementer or Saver changed the artifact; require it to be an ancestor of candidate HEAD.
2. Enumerate the candidate commits oldest-first with `git rev-list --reverse --first-parent <replay-base>..<candidate-head>`. Require at least one commit, and require `git rev-list --min-parents=2 <replay-base>..<candidate-head>` to be empty. A missing, ambiguous, or merge-bearing commit chain is a rescue event.
3. Reuse a clean, unlocked staging branch/worktree only when its recorded integration base, candidate HEAD, and ordered replay list exactly match this transaction and no agent can still access it. Otherwise create one new staging branch/worktree from the latest integration HEAD. Never keep two live staging transactions for the same plan.
4. Replay the exact ordered candidate commits onto staging with `git cherry-pick`. Never use `git merge`, `--no-ff`, or `--rebase-merges` to stage a plan. Any cherry-pick conflict or empty replay is a rescue event; the coordinator resolves no substantive conflict.
5. Prove every candidate patch is represented in staging with `git cherry <staging-head> <candidate-head>`: every emitted row must begin with `-`, with no `+` row. Also require `git rev-list --min-parents=2 <staging-base>..HEAD` to be empty so the plan adds no merge node.
6. Confirm material behavior is limited to the plan's scope. Apply the review acceptance policy below to incidental formatting, generated artifacts caused by gates, and other nonfunctional churn instead of treating their mere presence as a failed transaction.
7. Run every plan done criterion and the applicable project-wide gates in the staging worktree.
8. Create an empty coordinator completion-marker commit with `git commit --allow-empty -m "plan-herder(<id>): mark plan done"`.
9. Record the staging worktree's clean status and tree SHA, dispatch `plan-reviewer` against the complete staging diff from the pre-plan integration SHA to staging HEAD, and prove both are unchanged after review. Any reviewer mutation is a failed review even if its verdict says APPROVE.

### Review acceptance and convergence

The coordinator owns the acceptance gate. A review finding blocks integration only when it is one of:

1. a P0/P1 defect introduced by the candidate or repair diff;
2. a failed required acceptance criterion or required verification command; or
3. a demonstrated violation of an explicit plan requirement or material scope constraint.

P0 is reserved for a universal release, security, data-loss, or operational emergency. P1 is an urgent functional regression or explicit acceptance failure. P2 is a normal eventual fix and P3 is a nice-to-have improvement. P2 and P3 findings are advisory and never block integration, enter Saver, or prevent `DONE`.

A blocking finding must include an exact changed file and line, the triggering input/environment/scenario, reproducible evidence or a failing check, and the candidate hunk or commit that introduced it. Reject pre-existing defects, speculation, and assumptions about unstated intent as blockers. Style, formatting, documentation nits, unrelated cleanup, and generated-file churn are advisory unless the plan explicitly requires the exact result or the diff has a demonstrated P0/P1 consequence. Treat `SCOPE: FAIL` as blocking only for material out-of-plan behavior or an explicit scope violation; incidental nonfunctional churn does not make scope fail.

Maintain a monotonic ledger for each plan generation. Assign each `NEW` finding the next stable ID (`F001`, `F002`, ...), deduplicate later reports by root cause even if lines move, and store severity, gate class, first-seen reviewed SHA, file/cause, evidence, introducing diff, and status (`OPEN`, `RESOLVED`, `ADVISORY`, `DISMISSED`, or `NEEDS_ADJUDICATION`). Pass the ledger to every later reviewer. Preserve existing IDs. A resolved finding stays resolved unless its exact scenario is reproduced on the current staged HEAD; a reproduced regression reopens the same ID. Carry advisories to the final run report without automatically creating or expanding a plan.

Use two review modes:

- `DISCOVERY`: inspect the complete staged plan diff and reconcile all ledger entries. Allow at most two completed broad discovery passes per plan generation. The initial review is the first pass; after a repair, one second broad pass is allowed. A staging rebuild whose plan patch is unchanged does not earn another discovery pass.
- `VERIFICATION`: after the second broad pass, verify only open blocking IDs and inspect the coordinator-supplied repair commit list or diff range for newly introduced regressions. Never reopen the unchanged remainder of the plan diff as a fresh audit.

If verification finds an evidence-complete P0/P1 regression introduced by the repair delta, add it to the ledger and route it through the remaining Saver budget. If it reports a new blocker outside that delta after the broad-pass cap, record `NEEDS_ADJUDICATION`, transition the plan to `BLOCKED` with that exact evidence, and ask the user whether to accept it as a blocker or defer it; do not start another automatic broad review or Saver round for that finding. An accepted blocker resumes targeted repair and verification. A deferred finding becomes advisory and cannot prevent completion.

Normalize the effective gate from evidence and severity rather than blindly trusting the verdict word. A `REVISE` response containing only P2/P3, dismissed, or otherwise non-qualifying findings is an effective approval when required gates pass and effective scope is `PASS`. Only an evidence-complete open blocker can produce effective `REVISE`; reserve effective `BLOCK` for an irreducible blocker. This normalization prevents reviewer appetite from becoming an unbounded veto.

### Reviewer prompt contract

Give the resolved reviewer role (`plan_reviewer` through Codex Multi-Agent V2 or `herder:plan-reviewer` on Claude Code):

- its role and the prohibition on editing or spawning agents;
- the absolute staging worktree path and branch;
- the complete plan text;
- the base and staged HEAD SHAs;
- the actual checks run and their results;
- `REVIEW MODE: DISCOVERY | VERIFICATION`, the number of completed broad passes, and the remaining broad-pass budget;
- the complete finding ledger, or `none` on the first pass;
- for verification, the exact repair commit SHAs or diff range and the open blocking finding IDs;
- the stable attempt ID and resolved model/effort attribution;
- instructions to apply the review acceptance policy above, preserve finding IDs, and respect the supplied review mode;
- instructions to summarize checks without pasting command logs;
- this exact response shape:

```text
VERDICT: APPROVE | REVISE | BLOCK
FINDINGS: <ordered `[<existing-id|NEW>][P0|P1|P2|P3][BLOCKING|ADVISORY] file:line — issue; scenario=...; evidence=...; introduced_by=...` entries, or none>
SCOPE: PASS | FAIL
CHECKS: <independently verified commands/results>
RATIONALE: <concise>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Tell the reviewer never to estimate unavailable usage. Prefer structured host telemetry over the reviewer-authored `USAGE` line. Integrate only after the normalized gate is effective `APPROVE` with effective `SCOPE: PASS`, all required checks pass, and the ledger contains no `OPEN` or `NEEDS_ADJUDICATION` blocker. Verify the integration branch still points to the staging base SHA and the reviewed range contains no merge commit, then fast-forward it to staging HEAD. If it moved, discard/rebuild staging from the new integration HEAD, replay the candidate commits again, and verify the unchanged plan patch without consuming another discovery pass. Record staging HEAD as the plan's completion commit, then transition the plan to `DONE` through the plan manager. If the transition fails, stop dependency dispatch and reconcile the index from the reachable marker before continuing.

After `DONE`, prove no worker can still access any recognized candidate, rescue, or staging artifact for that plan, unlock its worktrees, and invoke the cleanup runner with `--plan <id>`. Cleanup refusal or failure is a reported maintenance warning, not a reason to roll back reviewed integration or block dependents; preserve every artifact the runner skips.

If any replay, check, review, or compare-and-advance step fails, leave integration HEAD unchanged and enter rescue.

## 6. Rescue Before Escalation

Prepare the rescue environment; do not ask `plan-saver` to reconstruct missing candidate changes from a different checkout. Reuse the candidate branch/worktree when it safely contains the failed work. For integration-only failures, create a rescue branch/worktree from the latest integration HEAD and combine the candidate there first.

An **agent attempt** is one host spawn and always receives a unique usage row. A **saver repair round** is a substantive saver result or a saver attempt that may have changed the rescue branch. Host interruption alone does not consume a repair round when all no-mutation invariants below are proven.

A **plan generation** starts with an immutable plan snapshot, integration-base SHA, fresh implementer candidate, empty finding ledger, and zero completed broad review passes. Number the initial generation `0`; increment only after accepting `REPLAN`, validating the revised plan, and dispatching a fresh implementer from integration HEAD. Record the SHA-256 of the exact snapshotted `planText` with the generation. `REPAIRED`, staging rebuilds, rebases needed for unrelated integrations, clarification answers, and interrupted attempts remain in the same generation and never reset its recovery or review budget.

Before every saver dispatch, record:

- integration HEAD;
- rescue branch HEAD and tree SHA;
- the exact `git status --porcelain=v1 --untracked-files=all` result and whether it is empty; and
- the plan-generation number, snapshot SHA-256, repair-round number, and attempt ordinal.

A dirty rescue worktree may contain the failed work Saver must recover, but it is ineligible for a no-cost interruption restart. Never reset, clean, stash, or discard files merely to make an attempt eligible.

Give the resolved saver role (`plan_saver` through Codex Multi-Agent V2 or `herder:plan-saver` on Claude Code) only:

- the absolute rescue worktree path;
- branch name;
- the complete snapshotted plan text, always inlined because the plan directory may be absent from the worktree;
- a compact failure envelope containing:
  - failure source (`implementer`, `merge`, `gate`, `review`, or `compare-and-advance`), plan generation, snapshot SHA-256, integration-base SHA, and immutable failed HEAD/tree SHA;
  - every open, evidence-complete blocking reviewer finding or failed-agent stop reason, preserving stable IDs, file/line evidence, and order but omitting advisories, commentary, and theories;
  - each exact reproduction command when known, plus compact `run-gate.mjs` evidence (fingerprint, exit status, duration, log SHA/path) without raw output; and
  - the finding ledger, completed broad-review count, ordered repair delta, prior Saver outcomes in this generation, and remaining review/generation/replan budget;
- the expected outcome: inspect Git/repository state, reproduce relevant gates, repair and commit if possible, or classify the blocker;
- the user's answer when resuming after `NEEDS_INPUT`;
- the stable attempt ID and resolved model/effort attribution.

Pass direct failure evidence, not implementer/reviewer theories or raw gate output. Never pass P2/P3 advisories to Saver. Use `none` for unavailable findings or reproduction commands rather than inventing them. Tell Saver to repair only the supplied open blocking IDs, verify every direct finding or repro first, and broaden investigation only when that evidence indicates a systemic issue or cannot explain the failure. The immutable failed artifact may differ from the mutable rescue worktree; label both explicitly so Saver can compare them without guessing.

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

For every proven interruption:

1. Record exact available usage with outcome `INTERRUPTED` under a new attempt ID.
2. Do not increment the saver repair-round or user-clarification counters.
3. Never reuse or resume the interrupted agent session. Any retry uses a fresh agent session for the same round with the next role attempt ordinal and `fork_turns: "none"`. Give it the normal self-contained Saver prompt plus only the fact that the previous host attempt ended before any repository mutation; do not replay classifier text, partial conversation, or prior theories.

After the no-mutation proof, classify the interruption reason from explicit native host evidence:

- **Transient capacity**: the host explicitly reports temporary capacity, overload, retryable rate pressure, or concurrency exhaustion. Never infer capacity from a quiet worker, generic timeout, disconnect, or missing response.
- **Non-retryable infrastructure**: the host explicitly reports invalid credentials, authorization/configuration failure, exhausted non-renewing quota, or another condition that cannot recover by waiting.
- **Other host interruption**: any remaining platform, policy/classifier, transport, timeout, disconnect, or session-runtime failure.

Handle the class as follows:

- For transient capacity, do not increment any retry, interruption, clarification, replan, or recovery bound. Keep the rescue lease and logical Saver round intact, then start a fresh Saver after backoff delays of 30 seconds, 60 seconds, 120 seconds, and 300 seconds, remaining capped at 300 seconds for later capacity interruptions. Use a host delayed-wakeup or wait facility when available; never spin or reuse the failed session. Continue until a fresh attempt reaches a non-capacity outcome, the user cancels, a user-supplied deadline expires, or the host cannot keep the run alive.
- If a capacity wait must stop because of cancellation, deadline, or host lifecycle, transition the plan to `BLOCKED` with detail `infrastructure capacity unavailable; recovery budget preserved`, keep the branch and worktree, and report that `resume` continues the same generation and logical Saver round. Do not describe this as exhausting any retry or repair limit.
- For non-retryable infrastructure, transition immediately to the same infrastructure `BLOCKED` state without consuming substantive recovery budget.
- For other host interruptions, permit at most two same-round non-capacity interruption restarts. If both restarts are interrupted, transition the plan to `BLOCKED` with an infrastructure/policy reason, preserve the unused substantive recovery budget in the report, and stop that plan. Do not describe this as exhausting the Saver repair limit.

Every restarted spawn is still an independently attributable usage attempt. Never reuse an interrupted agent session or attempt ID.

Handle outcomes:

- `REPAIRED`: treat the rescue branch as the new candidate and retain the coordinator-recorded rescue branch point as its replay base. Record the repair commits as the next review delta, repeat transactional staging and all checks, then select `DISCOVERY` or `VERIFICATION` from the generation's broad-pass count. The saver never self-approves.
- `REPLAN`: validate the evidence and the replan guards below. If accepted, revise the coordinator's plan file and index, validate them through Plans, discard stale staging, increment the plan generation, reset only that new generation's recovery counters, and dispatch a fresh implementer from the new integration HEAD. Do not commit the local plan directory into execution branches.
- `NEEDS_INPUT`: ensure the question is irreducible and focused, then ask the user exactly that question. Continue unrelated ready plans. After the answer, refresh the rescue branch onto the latest integration HEAD when necessary and automatically dispatch `plan-saver` again with the answer.
- `TERMINAL`: transition the plan to `BLOCKED` through Plans with a one-line reason and report it; do not fabricate a question.

Give each plan generation two substantive autonomous Saver repair rounds and two user clarification cycles. `INTERRUPTED` usage rows do not count toward either bound. A successfully accepted `REPLAN` therefore gives the fresh implementation generation its own budget; it does not erase prior usage or attempt ordinals.

Bound replanning separately. Accept at most two `REPLAN` outcomes per plan per invocation. Derive a compact failure signature from the failure source plus normalized direct findings, or from failing command fingerprints and exit statuses when findings are absent; exclude generation numbers and commit SHAs. If the same signature survives two consecutive completed implementation generations, reject another `REPLAN` for that signature: Saver must repair it, return `NEEDS_INPUT`, or classify it `TERMINAL`. If a rejected `REPLAN` leaves a substantive round in the current generation, redispatch a fresh Saver with the guard result; otherwise transition the plan to `BLOCKED`.

After a generation's substantive, clarification, non-capacity interruption-restart, or replan bound is exhausted, transition the plan to `BLOCKED`, preserve the rescue branch, and report the generation plus the exact bound or repeated signature that ended the run. Transient capacity interruptions never exhaust this bound; they stop only under the capacity rules above. A new explicit `resume` invocation may authorize another bounded cycle.

## 7. Usage Accounting

The root coordinator is the only usage-ledger writer. After every agent attempt reaches a terminal host state, call `plan_manager record-usage` before taking the next lifecycle action. Use an idempotent attempt ID such as `<run-id>-<plan-id>-<role>-<ordinal>`; increment the ordinal for every interruption restart, including capacity retries, and use plan `RUN` for a final cross-plan reviewer or integration-rescue agent. Record the normalized outcome, including `INTERRUPTED`, so attempt count and substantive recovery count can be reconstructed separately.

Attribute the configured model and effort resolved before dispatch. Prefer host-reported effective model/effort and structured usage over configured values and the worker's envelope when those fields are exposed. On Codex, after a child reaches a terminal state, run `node <codex_evidence_reader> --agent <returned-canonical-task-name> --pretty`. Require its `agentRole` to match the requested custom profile and its `multiAgentVersion` to be `v2`; a mismatch is a routing failure. Use its `terminal.taskComplete`, `terminal.turnAborted`, and `terminal.finalEnvelopePresent` fields together with the native agent state when classifying interruptions; `taskComplete` alone is insufficient. When its `usage` is present, copy the exact fields and source `codex-multi-agent-v2-transcript`. If no uniquely attributable terminal usage exists, record every token field as `unknown` with source `unknown`. On Claude, copy structured host telemetry when available and otherwise use `unknown`. Never tokenize transcripts, subtract coordinator totals, or infer hidden reasoning.

Use `plan_manager usage <plan_dir> --pretty` for reporting. Its token subtotal is input plus output for attempts where both are known; cached-input and reasoning columns are details, not additional tokens. Always report coverage beside subtotals. The README ledger covers recorded Herder attempts, not unobservable coordinator, platform, or retry overhead.

## 8. Resume Semantics

Reconstruct state from:

- `node <plan_manager> status <plan_dir> --pretty`;
- completion commits containing `plan-herder(<id>):`;
- candidate and staging branch names;
- branch ancestry and worktree cleanliness.
- the manager-generated usage ledger and existing attempt IDs.

Treat saver ledger rows with outcome `INTERRUPTED` as attempts but not substantive repair rounds. Anchor the resumed cycle's initial generation to the current validated snapshot and usable candidate; prior `REPLAN` rows remain history, but their old counter buckets need not be recreated. Reconstruct review state from retained reviewer final envelopes, reviewed staging artifacts, and stable finding IDs; a resume or staging rebuild never resets the broad-review count or finding ledger. If review state cannot be reconstructed unambiguously, treat the broad-pass budget as exhausted and route any new blocker outside a proven repair delta to human adjudication rather than restarting discovery. Never infer a reset from a staging rebuild or Saver commit. Continue attempt ordinals after every prior row. When the plan is `BLOCKED` with detail `infrastructure capacity unavailable; recovery budget preserved` and the no-mutation proof still holds, resume the same generation and logical Saver round with a fresh session and restart capacity backoff at 30 seconds. Other explicit resumes start a new bounded recovery cycle but do not reset review state. Never rewrite or drop prior usage.

Treat worktree locks as leases. On resume, reconcile native agent states before unlocking a stale Herder lock; keep the worktree locked whenever an agent is active, ambiguous, or could still be retried in the same session. On Codex, use `node <codex_evidence_reader> --workdir <absolute-worktree> --pretty` to find persisted child sessions that used the artifact, then correlate their canonical task names, roles, terminal envelopes, and attempt IDs with the structured lock reason and usage ledger.

Subagent conversational context is not a resume dependency. Never ask a fresh child to continue an interrupted child's conversation, and never assume a new coordinator can attach to a child owned by another root session. Reconstruct direct state from Git, the worktree, compact gate evidence, the finding ledger, usage rows, and persisted child telemetry; every replacement child receives a fresh self-contained prompt with `fork_turns: "none"`.

Classify every retained artifact before creating a branch or dispatching a child:

- If its recorded owner is active, keep the lease and let the same coordinator wait. A fresh coordinator must not dispatch a competing child.
- If the owner is terminal with a parseable envelope, record its usage, unlock the worktree, and continue from that outcome.
- If the owner was interrupted and the worktree is clean with unchanged HEAD and tree, record `INTERRUPTED` and use a fresh agent for the same logical attempt.
- If a dirty candidate, rescue, or staging worktree has no active owner or final envelope, preserve and lock the exact worktree, classify the prior attempt as failed, and dispatch a fresh Saver there. Never reset, clean, stash, or replace half-finished edits merely to recover a clean branch.
- If a clean candidate or rescue contains committed merge-free work, treat it as the usable candidate and stage those commits.
- If a clean staging artifact still has the exact current base and replay, continue the first missing gate, review, or compare-and-advance step. Rerun evidence that cannot be reconstructed; do not create a replacement stage solely because coordinator context was compacted.
- If ownership or mutation state remains ambiguous, keep the artifact locked and stop that plan for reconciliation instead of guessing.

Reconstruct each candidate or rescue replay base with `git merge-base <artifact-head> <integration-head>`, then verify that the artifact's unique first-parent range is nonempty and merge-free before staging. Never infer the replay set from `integration..artifact`, because integration may contain unrelated plans that landed after the artifact forked.

For `IN PROGRESS`, inspect its candidate branch. If it contains committed work, stage and review it; if it has no usable work, dispatch a fresh implementer. For `BLOCKED`, start with a saver when a rescue branch exists; otherwise create a fresh candidate from integration HEAD and let the saver investigate the plan and repository.

Never trust a `DONE` row alone. Verify its completion marker is reachable from integration HEAD and re-run cheap done criteria when resuming. If a marker is missing or verification fails, transition it to `BLOCKED` through Plans and enter rescue before allowing dependents to start. Conversely, if a reachable marker exists while the index is not DONE, reconcile that status before dispatching dependents. Continue role ordinals after the highest recorded attempt; never duplicate or rewrite a prior usage row.

## 9. Completion

The run succeeds when every plan is `DONE` or `REJECTED`, all dependency markers are ancestors of integration HEAD, the final project-wide gates pass, and the final reviewer ledger contains no evidence-complete P0/P1 cross-plan integration regression. P2/P3 final-audit findings are advisory and cannot fail the run.

Apply the same stable ledger and two-broad-pass cap to the final cross-plan audit. If a final gate or qualifying audit blocker fails, create an integration-rescue branch/worktree from integration HEAD and send `plan-saver` a synthetic plan containing the failing final criterion and expected integrated behavior. Treat any repair as a new transaction: stage it from the unchanged integration HEAD, run all final gates, and use targeted verification after the broad-pass cap before advancing integration. A new blocker outside the repair delta after the cap requires human adjudication, not another automatic audit cycle.

Do not merge, push, publish, or deploy. Proof-based automatic cleanup may remove clean `DONE` artifacts; preserve blocked/failed candidate and rescue evidence unless the user explicitly requests `--include-failed`. Report:

- integration branch and absolute worktree;
- final commit SHA;
- plans completed/rejected/blocked;
- final verification commands and results;
- compact gate evidence and retained log paths;
- usage subtotals and coverage by plan, role, and model/effort;
- advisory findings and any finding awaiting human adjudication, grouped by stable ID;
- preserved branches needing attention.

Fire never merges into the user's branch. When its original target branch still points to the run's base commit, report `git merge --ff-only <integration-branch>` as the normal handoff; this adds the reviewed linear commits and completion markers without a merge node. If the target branch moved, report that fast-forward is unavailable and require a fresh replay/review cycle on the new target. Never recommend a non-fast-forward merge, rebasing the user's branch, or removing completion markers to force the handoff.

## 10. Cleanup

Cleanup is a Fire coordinator operation, never a worker role. For automatic post-`DONE` cleanup or explicit `herder:fire cleanup`, invoke:

```text
node <cleanup_runner> --repo <repo_root> --plan-dir <plan_dir> --integration-branch <branch> [--plan <id>] [--dry-run] [--include-failed] --pretty
```

Require the exact integration branch; never infer it for cleanup. Before mutating, prove no active or ambiguous agent can access a targeted worktree. `--dry-run` may inspect an active run but must not unlock anything.

The runner owns the mechanical safety checks. It validates Plans, limits branches to the integration branch's run prefix and recognized candidate/stage/rescue names, and preserves unrecognized artifacts. By default a branch is eligible only when its plan is `DONE`, the exact completion marker is reachable, and any attached worktree is unlocked and clean. Classify an ancestor as `ancestor`, a merge-free artifact whose patch series is fully represented in integration as `patch-equivalent`, and every other recognized artifact for that completed plan as `superseded-by-completion`. The reachable reviewed completion marker is the authority for delivered code; unmatched failed attempts remain only while the plan is non-`DONE`. Delete the worktree first, then delete the ref only if it still points to the preflight SHA.

`--include-failed` is valid only when the user explicitly supplied it and the run is stopped. It additionally makes clean, unlocked non-`DONE` candidate/stage/rescue evidence eligible even when unmerged. It never overrides a dirty, locked, missing, or unrecognized worktree and never deletes the integration branch/worktree, gate logs, plan directory, user checkout, or unrelated refs. Do not invent an `--include-failed` authorization during Fire or resume.

For explicit cleanup, report every planned/removed artifact and every preserved artifact with its reason. For automatic cleanup, retain the compact result in the run report. Never ask an implementer, reviewer, Saver, or plan producer to remove Git state.
