# Plan Herder Orchestration Protocol

Use this protocol for every `fire` and `resume` run. The coordinator owns scheduling, gates, lifecycle state, and integration. Each plan owns one stable branch/worktree and advances independently through a bounded Implementer → Reviewer loop. Judge is an escalation filter beginning at unresolved round 3. Only final integration is serialized.

## Contents

1. Establish the plan set
2. Preflight without mutation
3. Branch, worktree, and lease layout
4. Independent plan scheduling
5. Six-round plan loop
6. Integration lock
7. Usage and interruption accounting
8. Resume and legacy compatibility
9. Completion
10. Cleanup

## 1. Establish the Plan Set

Resolve:

- `repo_root`: absolute repository root.
- `plan_dir`: absolute Herder plan directory, normally `<repo_root>/herder-plans`.
- `plan_name`: explicit `--plan-name`, otherwise the validated lowercase Git-safe basename of `plan_dir`.
- `integration_branch`: `herder/<plan_name>/integration`.
- `plan_branch(<id>)`: `herder/<plan_name>/<id>`.
- `base_ref`: `refs/plan-herder/<plan_name>/base`.
- `completion_ref(<id>)`: `refs/plan-herder/<plan_name>/completed/<id>`.
- `checkpoint_ref(<id>, <generation>, <ordinal>)`: `refs/plan-herder/<plan_name>/checkpoints/<id>/<generation>-<ordinal>`.
- `plan_manager`, `namespace_runner`, `checkout_guard`, `assignment_manager`, `codex_evidence_reader`, `gate_runner`, `round_policy`, and `cleanup_runner`: absolute installed script paths.
- `base_commit`: current user-checkout `HEAD` for fresh Fire, or `base_ref` for resume.
- `worktree_root`: outside the user's checkout, with integration at `<worktree_root>/<plan_name>/integration` and plans at `<worktree_root>/<plan_name>/<id>`.
- `gate_log_root`: `<worktree_root>/<plan_name>/logs`, outside every Git worktree.
- `parallel_limit`: explicit positive `--max-parallel`, otherwise `5`, capped by host-available worker capacity. It is one global worker limit across Implementer, Reviewer, and Judge.
- `scheduler_state`: for each plan, its round 1–6, review pass, active role if any, queued next action, approved base/HEAD/tree, and integration-ready state; plus the optional integration-lock owner. Reconstruct this state from durable evidence on resume rather than writing a second state file.
- `review_state`: per-generation round count, exact review surfaces, repair deltas, finding ledger, Judge outcomes from round 3 onward, and leak records. Use a separate ledger for final cross-plan audit.
- `checkout_state_token`: the checkout guard token excluding only `plan_dir`.
- `assignment_state(<id|RUN>)`: worktree-local assignment path, bundle SHA-256, compiled snapshot SHA-256, generation base, and branch.
- `execution_runtime`: explicit `native` or `orca`, never inferred.

An **agent attempt** is one worker dispatch and always receives a unique usage row. A **substantive round** is an Implementer attempt that returns a result or may have mutated its worktree, followed by coordinator gates and Reviewer when the branch becomes reviewable. A proven clean host interruption consumes no round. Restacking an unchanged patch consumes no round.

## 2. Preflight Without Mutation

Complete every check before creating refs, branches, or worktrees:

1. Confirm repository and worktree inventory are readable.
2. Run `node <checkout_guard> --repo <repo_root> --exclude <plan_dir> --pretty`; require `ok: true` and retain its `stateToken` without exposing file contents.
3. Run Plans `validate` and `shape`. Reject graph, semantic-scope, or overlap errors. Ignore legacy review-budget metadata and every file-count or LOC STOP rule.
4. Run `node <namespace_runner> ... --mode <fire|resume> --pretty`. A namespace conflict is a deliberate stop; never invent a timestamp, adopt unknown state, or overwrite evidence.
5. Resolve Implementer, Reviewer, and Judge profiles and their configured routing. A packaged Saver profile is not part of fresh scheduling and is probed only when resuming a persisted legacy Saver state.
6. For native Codex require Multi-Agent V2 `herder_agents` spawning with `agent_type` and `fork_turns`; never fall back to `codex exec` or a generic worker. For Orca, validate the explicit runtime profile and every required route.
7. Determine required verification commands from repository instructions, CI, and plan command tables. Do not guess when the plan specifies them.
8. Confirm intended worktree paths are unused and Git metadata is writable.

For fresh native Fire, create absent `base_ref` and integration branch atomically with guarded `git update-ref --stdin`, then add the integration worktree. For Orca, let Orca create the worktree/branch and verify it before creating `base_ref`. Materialize and immediately verify the immutable RUN assignment:

```text
node <assignment_manager> materialize-run --plan-dir <plan_dir> --worktree <absolute-integration-worktree> --expected-branch <integration-branch> --expected-head <base-commit> --pretty
```

For resume, verify `base_ref` is an ancestor of integration HEAD and verify the originally recorded bundle hash. Never rebuild a missing or mismatched trusted bundle from changed source plans.

## 3. Branch, Worktree, and Lease Layout

Fire owns only:

```text
herder/<plan-name>/integration
herder/<plan-name>/<plan-id>
```

Each plan has exactly one stable branch and at most one worktree for its lifecycle. Implementer, Reviewer, Judge, and resume use it serially. Never create role, candidate, retry, stage, rescue, generation, or timestamp branches.

Create a fresh plan branch from exact integration HEAD with an absent-old-value guard, add its worktree through the selected runtime, then materialize:

```text
node <assignment_manager> materialize --plan <id> --plan-dir <plan_dir> --worktree <absolute-worktree> --expected-branch <plan-branch> --expected-head <replay-base> --expected-snapshot-sha256 <snapshot-sha256> --pretty
```

Require the bundle to be inside that worktree, ignored, read-only, branch-bound, source-path-redacted, and byte-identical to its recorded SHA-256. Before and after every worker call:

```text
node <assignment_manager> verify --worktree <absolute-worktree> --bundle <absolute-assignment-path> --expected-bundle-sha256 <bundle-sha256> --pretty
```

A missing, writable, symlinked, moved, branch-mismatched, or hash-mismatched bundle is a containment failure. Do not derive a new trusted hash from the file itself.

Lock a plan worktree while a worker can access it:

```text
git worktree lock --reason plan-herder:<plan-name>:<plan-id>:<role>:<attempt-id>:<task-name>
```

One plan may have at most one active owner. A lock is a cleanup lease, not lifecycle state. The coordinator alone unlocks after the worker is terminal.

For native Codex, dispatch the exact `plan_implementer`, `plan_reviewer`, or `plan_judge` profile with `fork_turns: "none"`; omit model, effort, and service-tier overrides. For Orca use one tracked task and adapter-delivered lifecycle prompt per attempt; matching `worker_done` task/dispatch/pane provenance replaces native terminal evidence.

Immediately before and after every worker attempt, run:

```text
node <checkout_guard> --repo <repo_root> --exclude <plan_dir> --expect <checkout_state_token> --pretty
```

A mismatch stops dispatch, integration, and cleanup without rewriting user state.

## 4. Independent Plan Scheduling

Use one event-driven global worker pool. Its occupied capacity is exactly the number of active Implementer, Reviewer, and Judge agents. Coordinator gates, restacks, and the integration lock consume no worker slot. Never exceed `parallel_limit`, and never give one plan more than one active role.

There is no global review lane. Any combination of roles on different plans may overlap: an Implementer on A, Reviewer on B, and Judge on C can all run concurrently. The only cross-plan mutex is the integration lock in Section 6.

At every scheduling pass:

1. Drain every terminal worker event, verify bundle/checkout/Git evidence, record usage, and enqueue that plan's deterministic next action.
2. Advance every coordinator-only gate or state transition that can run without a worker.
3. Queue approved plans for the integration lock in dependency/plan order, but do not wait for that queue before dispatching unrelated workers.
4. Run `node <plan_manager> ready <plan_dir> --pretty`. Select `TODO` plans whose dependencies are `DONE`, whose completion refs are reachable from integration, and whose branches do not exist.
5. Create their stable branch/worktree, materialize the assignment, batch-transition them to `IN PROGRESS`, and enqueue round-1 Implementers.
6. Fill every available worker slot from eligible Implementer, Reviewer, and Judge actions in stable dependency/plan/round order.
7. Wait only when no terminal event, coordinator action, integration action, or eligible dispatch can make progress.

Do not use README `IN PROGRESS` count as an active-worker count; it means the plan lifecycle has started. Do not wait for an implementation wave to drain. A completed implementation should reach gates and Reviewer as soon as its own plan is unowned and a worker slot is available.

After native dispatch, use `wait_agent` with `timeout_ms: 1800000`; Orca uses its equivalent tracked long wait. The timeout caps idle wakeups, not result-delivery latency. A timeout is not a failure. If no local work becomes ready, do not reread transcripts, request status, or call `list_agents`; wait again.

## 5. Six-Round Plan Loop

Each fresh generation has exactly six possible substantive rounds. Call the deterministic helper after every Reviewer or Judge result:

```text
node <round_policy> review --round <1..6> --verdict <APPROVE|REVISE|BLOCK> --scope <PASS|FAIL> --open-blockers <n> --pretty
node <round_policy> judge --round <3..6> --decision <DONE|REPAIR|NEEDS_INPUT|BLOCKED> --pretty
```

The helper's action is authoritative for scheduling:

| Event | Next action |
|---|---|
| Reviewer `APPROVE`, scope `PASS`, no open blocker, any round | `READY_TO_INTEGRATE`; skip Judge |
| Reviewer `REVISE`, round 1–2 | `REPAIR_DIRECT` using only evidence-complete blocking Reviewer contracts |
| Reviewer `BLOCK`, round 1–2 | `BLOCKED`; do not pretend it is repairable |
| Reviewer nonapproval, round 3–6 | `JUDGE` |
| Judge `DONE`, round 3–6 | `READY_TO_INTEGRATE` |
| Judge `REPAIR`, round 3–5 | `REPAIR_GUIDED` and begin the next round |
| Judge `REPAIR`, round 6 | `BLOCKED_ROUND_LIMIT`; never start round 7 |
| Judge `NEEDS_INPUT` or `BLOCKED` | preserve and surface that terminal state |

This means rounds 1–2 are the simple Implementer → Reviewer repair loop. An unresolved third review triggers Judge before round 4. Every nonapproving review in rounds 4–6 is filtered by Judge. Approval always bypasses Judge.

An Implementer result that may have mutated consumes its current round even if it fails before a reviewable frozen branch exists. If rounds remain, dispatch a guided-repair Implementer with exact coordinator-proven operational evidence. Do not dispatch Judge without Reviewer findings merely to classify an implementation or gate failure. A non-reviewable round 6 becomes `BLOCKED` with exact evidence. A proven clean host interruption is free.

### Implementation and gates

Give Implementer its exact worktree/branch/base, assignment path and hashes, current round, mode `INITIAL` or `GUIDED_REPAIR`, applicable instructions, required gates, accepted discovered paths, and only coordinator-authorized repair contracts. In rounds 1–2, those contracts may come directly from Reviewer; in rounds 3–6 they must come from Judge. Never pass advisory, deferred, invalid, or unrelated findings.

Require this response:

```text
STATUS: COMPLETE | STOPPED | FAILED
COMMITS: <ordered SHAs, or none>
ADDRESSED: <finding IDs, or none>
CHECKS: <command — result, one per line>
FILES CHANGED: <paths>
DISCOVERED_PATHS: <one `<path> — necessity=...; plan_link=...` entry per changed undeclared path, or none>
STOPPED BECAUSE: <only when not COMPLETE>
NOTES: <material facts only>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Run coordinator gates through:

```text
node <gate_runner> --cwd <absolute-worktree> --log-dir <gate_log_root>/<plan-or-RUN>/<phase> --label <stable-label> -- <command> <arguments...>
```

The runner returns metadata and no command output on success or failure. Preserve full logs outside worktrees and give repair workers compact direct evidence, not theories or log dumps.

Before review, require clean status, at least one merge-free commit, exact base/HEAD/tree, all required gates passing, and assignment verification. Measure changed paths from base to HEAD and require a necessity/plan-link explanation for each undeclared path. Hard-stop for replan only when an explicit out-of-scope path changed, a path crosses the bounded subsystem or public-transition boundary, or it overlaps unordered live work. The number of changed or undeclared paths and the number of changed lines may be reported descriptively but never gate the plan.

### Review convergence

The first evidence-complete review is `DISCOVERY` against the complete plan diff regardless of round number. This is the only broad review. Later reviews are `VERIFICATION`: verify open authorized IDs and inspect only the repair delta for regressions. Never reopen broad discovery.

Relationships are `PLAN_REQUIREMENT`, `PATCH_REGRESSION`, `FOLLOWUP`, or `INVALID`. Only evidence-complete P0/P1 `PLAN_REQUIREMENT` and `PATCH_REGRESSION` findings may block. P2/P3, `FOLLOWUP`, and `INVALID` findings are advisory and never block integration. A blocker must identify exact changed location, trigger, reproducible evidence/failing check, introducing hunk, and original-task or patch-delta relationship.

Assign each `NEW` finding the next stable ID (`F001`, ...), deduplicate by root cause, and preserve the monotonic ledger across restacks and resume. In rounds 1–2, qualifying Reviewer blockers become direct repair contracts; other findings remain advisory. From round 3 onward Judge may classify valid unrelated Reviewer findings as `DEFERRED_OUT_OF_SCOPE` and the coordinator writes a non-executable draft at `<plan_dir>/leak/<source-plan-id>-<finding-id>-<slug>.md`.

Reviewer returns:

```text
VERDICT: APPROVE | REVISE | BLOCK
FINDINGS: <ordered `[<existing-id|NEW>][P0|P1|P2|P3][BLOCKING|ADVISORY][PLAN_REQUIREMENT|PATCH_REGRESSION|FOLLOWUP|INVALID] file:line — issue; scenario=...; evidence=...; introduced_by=...` entries, or none>
FIX_GUIDANCE: <one `[finding-id] observed=...; expected=...; reproduction=...; constraints=...; suggested_direction=...` entry per open blocker, or none>
DISCOVERED_PATHS: <one `<path> — JUSTIFIED|SCOPE_VIOLATION — reason` entry per discovered path, or none>
SCOPE: PASS | FAIL
CHECKS: <independently verified commands/results>
RATIONALE: <concise>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Judge is read-only and is dispatched only for a nonapproving Reviewer result at round 3–6. It cannot override failed required gates, explicit semantic done criteria or scope violations, or an evidence-complete patch regression. It filters findings under the same relationship policy and returns:

```text
DECISION: DONE | REPAIR | NEEDS_INPUT | BLOCKED
FINDINGS: <ordered `[finding-id][BLOCKING_IN_SCOPE|NONBLOCKING_IN_SCOPE|DEFERRED_OUT_OF_SCOPE|REJECTED][PLAN_REQUIREMENT|PATCH_REGRESSION|FOLLOWUP|INVALID|NEEDS_INPUT] decision; evidence=...` entries, or none>
AUTHORIZED_BLOCKERS: <ordered finding IDs, or none>
REPAIR_CONTRACTS: <one `[finding-id] observed=...; expected=...; reproduction=...; constraints=...` entry per authorized blocker, or none>
DISCOVERED_PATHS: <one `<path> — ACCEPTED|REJECTED — evidence` entry per discovered path, or none>
LEAKS: <one `[finding-id] title=...; problem=...; evidence=...; acceptance=...; non_goals=...; dedupe_key=...` entry per deferred finding, or none>
QUESTION: <one focused question only for NEEDS_INPUT>
CHECKS: <independently verified commands/results>
RATIONALE: <concise original-task closure rationale>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

A `REVISE` containing only P2/P3, `FOLLOWUP`, `INVALID`, dismissed, or nonqualifying findings is a malformed verdict: normalize it to approval only after the coordinator proves gates, scope, and discovered-path acceptance. Judge `DONE` performs the same normalization in escalated rounds.

## 6. Integration Lock

Reviewer approval or Judge `DONE` marks the exact base/HEAD/tree/status `READY_TO_INTEGRATE`. Multiple plans may wait and every other plan pipeline keeps running. The integration lock is a coordinator mutex, not a worker and not a pool reservation.

Under the lock only:

1. Require integration HEAD to equal the expected value captured when the lock was acquired.
2. Verify the approved plan branch is clean, assignment-valid, merge-free, and still at approved HEAD/tree/status.
3. If its reviewed base is stale, create a unique immutable checkpoint ref naming the pre-restack HEAD, then run `git rebase --onto <integration-head> <reviewed-base>` in the same plan worktree.
4. Prove patch equivalence with the checkpoint using `git cherry`, then rerun required gates and scope/path measurement. If the patch is equivalent and gates pass, preserve approval without another review. A conflict, material patch change, gate failure, or scope change releases the lock and consumes the next guided-repair round; never abort, reset, clean, or create another branch.
5. Recheck integration HEAD and fast-forward with `git merge --ff-only <plan-branch>`.
6. Require integration HEAD to equal the approved/restacked plan HEAD, create absent `completion_ref(<id>)`, verify reachability, and transition the plan to `DONE`.

No restack, gates, review, or Judge call globally serializes plans. Only steps 1–6 above hold the integration lock. If compare-and-advance fails, integration remains unchanged or is reconciled from exact evidence; never infer approval merely because an unmarked commit appears on integration. A crash may occur after the integration fast-forward but before the completion ref is written: recover only from exact approval, gate, HEAD/tree, and reachability evidence.

Do not add Herder metadata to commit subjects or bodies. Integration history remains repository-native and linear.

## 7. Usage and Interruption Accounting

The root coordinator alone calls `record-usage` after every terminal attempt, including attempts without a response. Continue stable per-role ordinals across resume. Copy uniquely attributable host telemetry; otherwise record `unknown`. Never estimate.

Native Codex evidence must show matching role, Multi-Agent V2, terminal response classification, and host-reported usage when available. Never parse tool-call text to infer filesystem containment. Both runtimes require checkout-guard and exact before/after Git proofs; Orca additionally requires exact worktree/task/dispatch/pane provenance.

Classify `INTERRUPTED` only when host evidence proves infrastructure rather than repository failure, no parseable envelope exists, pre/post integration and plan HEAD/tree match, and the previously clean worktree remains clean including untracked files. Then consume no round, verify the assignment, and dispatch a fresh session; never resume the interrupted child conversation.

For transient capacity, do not increment any round, retry, interruption, or clarification bound. Back off 30, 60, 120, then 300 seconds, capped at 300. Never infer capacity from quiet, timeout, disconnect, or missing response. For other proven host interruptions, allow at most two same-attempt non-capacity restarts, then block with infrastructure evidence while preserving the round budget.

## 8. Resume and Legacy Compatibility

Resume reconstructs scheduler state from Plans lifecycle/usage, refs, branches, worktree leases, assignment hashes, round and review envelopes, exact reviewed surfaces, gates, findings, and child evidence. Conversation history is never required. Count every proven-live Implementer, Reviewer, or Judge against `parallel_limit`; no durable review-lane reservation exists. If role ownership is ambiguous, preserve that plan rather than dispatch competition.

Classify retained branches:

- Active owner: keep its lease and wait.
- Terminal owner with valid envelope: record it and continue its local pipeline.
- Dirty, conflicted, or rebasing without an owner: preserve exact state and, if a round remains, dispatch guided repair; never abort or replace it.
- Clean merge-free commits not completed: reconstruct base, gates, round/review state, then continue Reviewer, Judge, or integration as evidence dictates.
- Clean no-commit `IN PROGRESS`: dispatch only when evidence proves no prior mutation was lost.
- Valid completion ref reachable from integration: reconcile `DONE` before dependents.
- Ambiguous round ledger: treat all six rounds as exhausted and preserve for user reconciliation; do not invent a Judge approval.

Resume or restack never resets the six-round count, review-pass count, or finding ledger. A fresh generation requires a user-authorized validated plan revision through Grill or Improve.

For runs created by an older Herder version, preserve the recorded five-attempt-plus-Saver semantics only when the durable ledger proves that generation already dispatched or was explicitly authorized for Saver. The installed legacy Saver profile may finish that one generation under its original contract. Do not convert fresh or merely five-attempt-exhausted legacy work into Saver; all new generations use the six-round state machine.

## 9. Completion

The plan set succeeds when every plan is `DONE` or `REJECTED`, every dependency completion ref is reachable from integration, final project-wide gates pass, and a read-only final Reviewer finds no evidence-complete cross-plan blocker. The final audit checks only dependency guarantees, combined migrations/public contracts, aggregate plan-set scope, and project-wide gates; it does not broadly rereview approved local hunks.

Reviewer approval completes the final audit without Judge. A final-audit nonapproval is reported with evidence and does not mutate integration or start a hidden seventh per-plan round; route it through a user-visible validated repair plan. P2/P3 findings remain advisory.

After success, verify the checkout token and invoke fail-closed `--finalize`. Never merge, push, publish, or deploy. Report integration branch/worktree, final SHA, outcomes, gates, audit, usage coverage, advisory/deferred findings, and preserved state.

When the intended target still equals `base_ref`, report:

```text
git merge --ff-only herder/<plan-name>/integration
```

If it moved, require a fresh replay/review cycle; never recommend non-fast-forward handoff. After user handoff, report the exact `herder:fire cleanup ... --finalize --handoff-target <target> --runtime <runtime>` command.

## 10. Cleanup

Cleanup is coordinator-only:

```text
node <cleanup_runner> --repo <repo_root> --plan-dir <plan_dir> [--plan-name <name>] [--plan <id>] [--dry-run] [--include-failed] [--finalize] [--handoff-target <branch>] --runtime native|orca --pretty
```

Before mutation, prove no active or ambiguous worker can access a target. The runner recognizes only `herder/<plan-name>/<indexed-id>` plan branches plus exact integration. Default cleanup removes only clean, unlocked `DONE` branches whose completion proof is reachable. Preserve clean non-`DONE` branches unless the user explicitly supplied `--include-failed`; that never overrides dirty, locked, unknown, integration, log, plan, or user-checkout safety.

Finalization requires every plan terminal, every `DONE` proof reachable, every private ref recognized, and every plan branch removable. Remove worktrees before branches, re-inventory, then delete private refs with exact expected targets. An already-finalized plan set with all plans terminal, no plan branches, and no private refs is idempotently complete.

For `--finalize --handoff-target`, require integration HEAD to be an ancestor of the local target immediately before deleting the clean, unlocked, distinct integration worktree and exact branch. Any failed proof or concurrent move preserves changed state. Report every removed item and every preservation reason.
