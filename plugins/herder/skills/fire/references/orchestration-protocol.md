# Plan Herder Orchestration Protocol

Use this protocol for every `fire` and `resume` run. The root coordinator owns only host-agent dispatch, waits, and user interaction. One persistent Accountant owns scheduling decisions, gates, lifecycle and usage state, repository proofs, Git transactions, and integration. Each plan owns one stable branch/worktree and advances independently through a bounded Implementer → Reviewer loop. Judge is an escalation filter beginning at unresolved round 3. Only final integration is serialized.

## Contents

1. Establish the plan set
1A. Persistent Accountant contract
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
- `execution_database`: `<plan_dir>/.herder/execution.sqlite3`, the manager-owned immutable attempt ledger; never scheduler state.
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
- `requested_worker_limit`: explicit positive `--max-parallel`, otherwise `5`.
- `control_slots`: exactly `1`, reserved for the persistent Accountant and excluded from the plan-worker pool.
- `host_child_capacity`: the host-confirmed concurrent child-thread capacity, excluding the root. Fire/resume requires at least `2`; if capacity cannot be confirmed, stop before mutation rather than guess.
- `parallel_limit`: `min(requested_worker_limit, host_child_capacity - control_slots)`. It is one global plan-worker limit across Implementer, Reviewer, and Judge. Default five-worker execution therefore requires child capacity of at least six.
- `accountant_thread`: the one native `plan_accountant` / `herder:plan-accountant` child addressable across the run. It never counts in `parallel_limit`.
- `scheduler_state`: Accountant-owned state for each plan: round 1–6, review pass, active role if any, queued next action, approved base/HEAD/tree, and integration-ready state; plus the optional integration-lock owner. Reconstruct this state from README lifecycle, SQLite attempts, refs, worktrees, assignments, and proofs on resume rather than writing a second state file.
- `review_state`: per-generation round count, exact review surfaces, repair deltas, finding ledger, Judge outcomes from round 3 onward, and leak records. Use a separate ledger for final cross-plan audit.
- `checkout_state_token`: the checkout guard token excluding only `plan_dir`.
- `assignment_state(<id|RUN>)`: worktree-local assignment path, bundle SHA-256, compiled snapshot SHA-256, generation base, and branch. A preserved active rebase additionally has an ephemeral `rebase_state_sha256` captured and consumed immediately before one guided-repair dispatch; it is evidence, not scheduler state.
- `execution_runtime`: explicit `native` or `orca`, never inferred.

An **agent attempt** is one worker dispatch and always receives a unique usage row. A **substantive round** is an Implementer attempt that returns a result or may have mutated its worktree, followed by Accountant-run gates and Reviewer when the branch becomes reviewable. A proven clean host interruption consumes no round. Restacking an unchanged patch consumes no round.

## 1A. Persistent Accountant Contract

Before any helper, repository Git command, or coordination write, the root spawns exactly one Accountant. On Codex use `agent_type: plan_accountant` with `fork_turns: "none"`; the installed profile pins Luna/max/Fast. On Claude use `herder:plan-accountant`; the bundled profile pins Opus/medium and requires an addressable resumed-subagent capability. The Accountant is a native controller child even when plan workers use Orca.

The Accountant is the exclusive control-plane owner. It alone runs every control-plane helper mode and repository Git command, evaluates worker envelopes, records usage, writes lifecycle or leak state, creates or removes refs/branches/worktrees/locks, runs gates, restacks, integrates, audits, and cleans. The root never duplicates or independently repairs those operations. The root may execute only exact host dispatch/wait/steer transport actions returned by the Accountant, including Orca dispatch/wait commands. The Accountant never spawns, waits for, steers, interrupts, lists, or messages agents and never asks the user a question directly.

The root sends one event at a time to the same Accountant thread:

```text
EVENT_KIND: BOOTSTRAP | RESUME | TERMINALS | DISPATCH_RESULTS | STATUS | CLEANUP | USER_INPUT
EVENT_ID: <run-unique monotonic ID>
REQUESTED_WORKER_LIMIT: <positive integer>
HOST_CHILD_CAPACITY: <confirmed integer>
ACTIVE_WORKERS: <exact host handles, roles, plans, attempts, or none>
PAYLOAD: <exact invocation, terminal envelopes/evidence, dispatch results, or user answer>
```

On `BOOTSTRAP`, the Accountant resolves the repository and installed helper paths, reads this complete protocol, records its SHA-256 in the response, and performs preflight. Every later event echoes that protocol hash; a mismatch stops without mutation. On `RESUME`, a replacement Accountant reconstructs from durable Plans state, refs, branches, worktrees, locks, assignments, gates, and supplied host inventory. Conversation history is never authority.

Process `TERMINALS` as a stable batch sorted by plan, round, and role. The Accountant applies all now-eligible control work and returns enough ordered `DISPATCH` actions to fill every available plan-worker slot. Each action contains a unique action ID, exact role, plan, attempt ID, task name, and complete immutable worker message. The root executes actions exactly, never invents one, and returns one `DISPATCH_RESULTS` batch with the real host handle or exact failure for every action. Capacity failure consumes no attempt or round; the Accountant releases an unused lease and recalculates capacity.

The Accountant response envelope is:

```text
ACCOUNTANT_STATUS: READY | ACTIONS | WAIT | NEEDS_INPUT | BLOCKED | COMPLETE
EVENT_ID: <echo>
APPLIED: yes | already | no
WORKER_POOL: requested=<n>; effective=<n>; active=<n>; available=<n>; control_reserved=1
ACTIONS: <ordered complete action blocks, or none>
STATE: <compact durable-state summary>
EVIDENCE: <protocol hash plus compact hashes/SHAs/proofs>
QUESTION: <one focused question only for NEEDS_INPUT, otherwise none>
```

The root validates only this envelope and host-handle accounting. For `ACTIONS`, it dispatches up to `available`; for `WAIT`, it performs the host's event-driven long wait; for `NEEDS_INPUT`, it asks the user and returns `USER_INPUT`; for terminal states, it relays the Accountant's compact report. Accountant turns are control-plane overhead like the root session and do not recursively create worker usage rows.

Event replay is idempotent. The Accountant reconciles every event and action against existing SQLite attempt IDs, lifecycle state, exact refs, locks, worktrees, assignments, and completion proofs before writing. Reusing an event ID with different payload is a hard stop. Never add an event journal or second scheduler state file; the execution database contains immutable attempt metadata only.

## 2. Preflight Without Mutation

The Accountant completes every check before creating refs, branches, or worktrees:

1. Confirm repository and worktree inventory are readable.
2. Run `node <checkout_guard> --repo <repo_root> --exclude <plan_dir> --pretty`; require `ok: true` and retain its `stateToken` without exposing file contents.
3. Run Plans `validate` and `shape`. Reject graph, semantic-scope, or overlap errors. Ignore legacy review-budget metadata and every file-count or LOC STOP rule.
4. Run `node <namespace_runner> ... --mode <fire|resume> --pretty`. A namespace conflict is a deliberate stop; never invent a timestamp, adopt unknown state, or overwrite evidence.
5. Require the root to prove the Accountant thread and reserved control slot are addressable, then resolve Implementer, Reviewer, and Judge profiles and their configured routing. A packaged Saver profile is not part of fresh scheduling and is probed only when resuming a persisted legacy Saver state.
6. For native Codex require Multi-Agent V2 `herder_agents` spawning with custom `agent_type`, `fork_turns`, follow-up, and long waits; never fall back to `codex exec` or a generic worker. For Claude require resumable `SendMessage` before mutation. For Orca, validate the explicit plan-worker runtime profile and every required route.
7. Determine required verification commands from repository instructions, CI, and plan command tables. Do not guess when the plan specifies them.
8. Confirm intended worktree paths are unused and Git metadata is writable.

After every preflight check passes and before creating Git refs, branches, or worktrees, run `node <plan_manager> migrate-usage <plan_dir> --pretty`. This transactionally imports any legacy generated README attempt table into `execution_database` and only then removes that section. A malformed or conflicting legacy ledger stops without rewriting README. `status` remains read-only and never runs migration.

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

Normal verification is branch-bound and rejects every detached HEAD. There is one explicit pre-dispatch exception for an ownerless conflicted rebase preserved by Section 8. It is available only to an Implementer in `GUIDED_REPAIR` mode while a substantive round remains. The Accountant must first prove from durable plan-set evidence—not by trusting the detached state—that the stable worktree and plan branch are the expected ones, the assignment path/hash/branch are unchanged, the immutable checkpoint ref and target are the recorded pre-restack proof, the rebase `onto` and original branch commit are the expected integration and plan commits, and no live or durable worker owns the plan. It then acquires the new attempt's exact lease and explicitly captures the sealed state:

```text
node <assignment_manager> inspect-active-rebase \
  --worktree <absolute-worktree> --bundle <absolute-assignment-path> \
  --expected-bundle-sha256 <bundle-sha256> --expected-worktree <absolute-worktree> \
  --expected-branch <plan-branch> --expected-worker-mode GUIDED_REPAIR \
  --expected-detached-head <detached-head> --expected-rebase-onto <onto> \
  --expected-rebase-orig-head <original-plan-commit> --expected-plan-head <plan-ref-target> \
  --expected-checkpoint-ref <checkpoint-ref> --expected-checkpoint <checkpoint-target> \
  --expected-lease-reason <new-attempt-lease> --pretty
```

The helper requires real Git rebase metadata, exact `head-name`, `onto`, `orig-head`, detached HEAD, unchanged plan and checkpoint refs, exact stable worktree registration and lease, the original read-only assignment hash and branch, unresolved conflicts, and a sealed hash over the rebase metadata, index stages, conflicts, relevant refs, tracked/cached diffs, status, and untracked-file fingerprints. The Accountant must immediately repeat the same exact arguments with `verify --verification-mode active-rebase --expected-rebase-state-sha256 <captured-sha256>`. Never enter this mode through detached-HEAD detection, never use it for Reviewer, Judge, RUN, an unrelated detached checkout, or a rebase without an immutable Herder checkpoint, and never attach HEAD, move a ref, abort/reset/clean, recreate the worktree, or rematerialize the assignment to satisfy it.

After that Implementer terminates, active-rebase verification is no longer sufficient. Before gates, review, or integration, require the rebase metadata to be absent, the exact plan branch to be attached, the worktree to be clean, the checkpoint and resulting branch history to reconcile, and the ordinary branch-bound assignment verification above to pass. An unfinished or changed rebase consumes the attempted round and remains preserved; if another round remains, only a fresh explicit durable-state reconstruction, capture, and active-rebase verification may authorize another guided repair.

Lock a plan worktree while a worker can access it:

```text
git worktree lock --reason plan-herder:<plan-name>:<plan-id>:<role>:<attempt-id>:<task-name>
```

One plan may have at most one active owner. A lock is a cleanup lease, not lifecycle state. The Accountant alone acquires and releases it around a root-dispatched worker.

For native Codex, the Accountant returns a complete action for the exact `plan_implementer`, `plan_reviewer`, or `plan_judge` profile with `fork_turns: "none"`; the root dispatches it without model, effort, or service-tier overrides. For Orca the Accountant prepares one tracked task and adapter-delivered lifecycle prompt per attempt, and the root delivers it; matching `worker_done` task/dispatch/pane provenance replaces native terminal evidence.

The Accountant runs immediately before authorizing and after receiving every worker attempt:

```text
node <checkout_guard> --repo <repo_root> --exclude <plan_dir> --expect <checkout_state_token> --pretty
```

A mismatch stops dispatch, integration, and cleanup without rewriting user state.

## 4. Independent Plan Scheduling

Use one event-driven global plan-worker pool. Its occupied capacity is exactly the number of active Implementer, Reviewer, and Judge agents. The Accountant occupies the separate reserved control slot; its gates, restacks, and integration lock consume no plan-worker slot. Never exceed `parallel_limit`, never consume the control slot with a plan worker, and never give one plan more than one active role.

There is no global review lane. Any combination of roles on different plans may overlap: an Implementer on A, Reviewer on B, and Judge on C can all run concurrently. The only cross-plan mutex is the integration lock in Section 6.

At every scheduling pass:

1. The root drains every currently terminal worker into one `TERMINALS` event and includes the exact remaining active-worker inventory and available capacity.
2. The Accountant verifies bundle/checkout/Git evidence, records the worker attempt in SQLite with known round, generation, runtime, harness, service tier, timestamps, duration, and host token telemetry, advances every eligible gate and lifecycle transition, and enqueues deterministic next actions.
3. The Accountant advances the integration queue in dependency/plan order without withholding unrelated dispatch actions.
4. The Accountant runs `node <plan_manager> ready <plan_dir> --pretty`, selects eligible `TODO` plans, creates their stable branches/worktrees, materializes assignments, and batch-transitions them to `IN PROGRESS`.
5. The Accountant returns ordered actions for every available worker slot across eligible Implementer, Reviewer, and Judge work.
6. The root dispatches the complete action batch immediately and returns exact `DISPATCH_RESULTS`; the Accountant reconciles leases and returns replacement actions for any still-available slot.
7. The root waits only when the Accountant reports `WAIT` and no terminal event, integration action, or eligible dispatch can make progress.

Do not use README `IN PROGRESS` count as an active-worker count; it means the plan lifecycle has started. Do not wait for an implementation wave to drain. A completed implementation should reach gates and Reviewer as soon as its own plan is unowned and a worker slot is available.

After native dispatch, the root uses `wait_agent` with `timeout_ms: 1800000`; Orca uses its equivalent tracked long wait. The timeout caps idle wakeups, not result-delivery latency. A timeout is not a failure. If no worker becomes terminal, do not wake the Accountant; do not reread transcripts, request status, or call `list_agents`; wait again.

## 5. Six-Round Plan Loop

Each fresh generation has exactly six possible substantive rounds. The Accountant calls the deterministic helper after every Reviewer or Judge result:

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

An Implementer result that may have mutated consumes its current round even if it fails before a reviewable frozen branch exists. If rounds remain, dispatch a guided-repair Implementer with exact Accountant-proven operational evidence. Do not dispatch Judge without Reviewer findings merely to classify an implementation or gate failure. A non-reviewable round 6 becomes `BLOCKED` with exact evidence. A proven clean host interruption is free.

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

The Accountant runs control-plane gates through:

```text
node <gate_runner> --cwd <absolute-worktree> --log-dir <gate_log_root>/<plan-or-RUN>/<phase> --label <stable-label> -- <command> <arguments...>
```

The runner returns metadata and no command output on success or failure. Preserve full logs outside worktrees and give repair workers compact direct evidence, not theories or log dumps.

Before review, require clean status, at least one merge-free commit, exact base/HEAD/tree, all required gates passing, and assignment verification. Measure changed paths from base to HEAD and require a necessity/plan-link explanation for each undeclared path. Hard-stop for replan only when an explicit out-of-scope path changed, a path crosses the bounded subsystem or public-transition boundary, or it overlaps unordered live work. The number of changed or undeclared paths and the number of changed lines may be reported descriptively but never gate the plan.

### Review convergence

The first evidence-complete review is `DISCOVERY` against the complete plan diff regardless of round number. This is the only broad review. Later reviews are `VERIFICATION`: verify open authorized IDs and inspect only the repair delta for regressions. Never reopen broad discovery.

Relationships are `PLAN_REQUIREMENT`, `PATCH_REGRESSION`, `FOLLOWUP`, or `INVALID`. Only evidence-complete P0/P1 `PLAN_REQUIREMENT` and `PATCH_REGRESSION` findings may block. P2/P3, `FOLLOWUP`, and `INVALID` findings are advisory and never block integration. A blocker must identify exact changed location, trigger, reproducible evidence/failing check, introducing hunk, and original-task or patch-delta relationship.

Assign each `NEW` finding the next stable ID (`F001`, ...), deduplicate by root cause, and preserve the monotonic ledger across restacks and resume. In rounds 1–2, qualifying Reviewer blockers become direct repair contracts; other findings remain advisory. From round 3 onward Judge may classify valid unrelated Reviewer findings as `DEFERRED_OUT_OF_SCOPE` and the Accountant writes a non-executable draft at `<plan_dir>/leak/<source-plan-id>-<finding-id>-<slug>.md`.

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

A `REVISE` containing only P2/P3, `FOLLOWUP`, `INVALID`, dismissed, or nonqualifying findings is a malformed verdict: the Accountant normalizes it to approval only after proving gates, scope, and discovered-path acceptance. Judge `DONE` performs the same normalization in escalated rounds.

## 6. Integration Lock

Reviewer approval or Judge `DONE` marks the exact base/HEAD/tree/status `READY_TO_INTEGRATE`. Multiple plans may wait and every other plan pipeline keeps running. The integration lock is an Accountant mutex, not a plan worker and not a pool reservation.

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

The Accountant alone calls `record-usage` after every terminal worker attempt, including attempts without a response. It writes `--round`, `--generation`, `--runtime`, `--harness`, `--service-tier`, `--started-at`, `--finished-at`, and `--duration-ms` whenever host evidence provides them. The root supplies uniquely attributable host telemetry in the `TERMINALS` event; otherwise the Accountant records unavailable token fields as `unknown`. Continue stable per-role ordinals across resume and never estimate. Accountant turns are control-plane overhead and do not recursively create usage rows.

After a successful `transition <id> DONE`, retain the returned per-plan report in the Accountant's compact state evidence. On status, use read-only `usage` and `report`; do not open SQLite directly. The report exposes attempt and round counts, outcomes, interruptions, models, runtimes, token coverage/totals, wall-clock bounds, and summed attempt duration without storing transcripts or repository content.

Native Codex evidence must show matching role, Multi-Agent V2, terminal response classification, and host-reported usage when available. Never parse tool-call text to infer filesystem containment. Both runtimes require checkout-guard and exact before/after Git proofs; Orca additionally requires exact worktree/task/dispatch/pane provenance.

Classify `INTERRUPTED` only when host evidence proves infrastructure rather than repository failure, no parseable envelope exists, pre/post integration and plan HEAD/tree match, and the previously clean worktree remains clean including untracked files. Then consume no round, verify the assignment, and dispatch a fresh session; never resume the interrupted child conversation.

For transient capacity, do not increment any round, retry, interruption, or clarification bound. Back off 30, 60, 120, then 300 seconds, capped at 300. Never infer capacity from quiet, timeout, disconnect, or missing response. For other proven host interruptions, allow at most two same-attempt non-capacity restarts, then block with infrastructure evidence while preserving the round budget.

## 8. Resume and Legacy Compatibility

On resume, the Accountant reconstructs scheduler state from Plans lifecycle/usage, refs, branches, worktree leases, assignment hashes, round and review envelopes, exact reviewed surfaces, gates, findings, and child evidence. Conversation history is never required. The root supplies the exact live host inventory. Count every proven-live Implementer, Reviewer, or Judge against `parallel_limit`; reserve the separate Accountant control slot and keep no durable review-lane reservation. If role ownership is ambiguous, preserve that plan rather than dispatch competition.

Classify retained branches:

- Active owner: keep its lease and wait.
- Terminal owner with valid envelope: record it and continue its local pipeline.
- Dirty, conflicted, or rebasing without an owner: preserve exact state and, if a round remains, dispatch guided repair; never abort or replace it.
- Clean merge-free commits not completed: reconstruct base, gates, round/review state, then continue Reviewer, Judge, or integration as evidence dictates.
- Clean no-commit `IN PROGRESS`: dispatch only when evidence proves no prior mutation was lost.
- Valid completion ref reachable from integration: reconcile `DONE` before dependents.
- Ambiguous round ledger: treat all six rounds as exhausted and preserve for user reconciliation; do not invent a Judge approval.

Resume or restack never resets the six-round count, review-pass count, or finding ledger. A fresh generation requires a user-authorized validated plan revision through Grill or Improve.

The ownerless-rebase rule does not relax normal assignment containment. The Accountant must reconcile the exact `ACTIVE_WORKERS` inventory and leases, reject competing or ambiguous ownership, and use Section 3's explicit active-rebase capture and verification before returning the guided-repair action. A detached HEAD by itself is never recovery authority.

For runs created by an older Herder version, preserve the recorded five-attempt-plus-Saver semantics only when the durable ledger proves that generation already dispatched or was explicitly authorized for Saver. The installed legacy Saver profile may finish that one generation under its original contract. Do not convert fresh or merely five-attempt-exhausted legacy work into Saver; all new generations use the six-round state machine.

## 9. Completion

The plan set succeeds when every plan is `DONE` or `REJECTED`, every dependency completion ref is reachable from integration, final project-wide gates pass, and a read-only final Reviewer finds no evidence-complete cross-plan blocker. The final audit checks only dependency guarantees, combined migrations/public contracts, aggregate plan-set scope, and project-wide gates; it does not broadly rereview approved local hunks.

Reviewer approval completes the final audit without Judge. A final-audit nonapproval is reported with evidence and does not mutate integration or start a hidden seventh per-plan round; route it through a user-visible validated repair plan. P2/P3 findings remain advisory.

After success, the Accountant runs `node <plan_manager> report RUN <plan_dir> --pretty`. The Accountant verifies the checkout token and invokes fail-closed `--finalize`. It returns integration branch/worktree, final SHA, outcomes, gates, audit, the rich run report, advisory/deferred findings, and preserved state for the root to report. Never merge, push, publish, or deploy.

When the intended target still equals `base_ref`, report:

```text
git merge --ff-only herder/<plan-name>/integration
```

If it moved, require a fresh replay/review cycle; never recommend non-fast-forward handoff. After user handoff, report the exact `herder:fire cleanup ... --finalize --handoff-target <target> --runtime <runtime>` command.

## 10. Cleanup

Cleanup is Accountant-only. The root sends one `CLEANUP` event and spawns no plan worker:

```text
node <cleanup_runner> --repo <repo_root> --plan-dir <plan_dir> [--plan-name <name>] [--plan <id>] [--dry-run] [--include-failed] [--finalize] [--handoff-target <branch>] --runtime native|orca --pretty
```

Before mutation, prove no active or ambiguous worker can access a target. The runner recognizes only `herder/<plan-name>/<indexed-id>` plan branches plus exact integration. Default cleanup removes only clean, unlocked `DONE` branches whose completion proof is reachable. Preserve clean non-`DONE` branches unless the user explicitly supplied `--include-failed`; that never overrides dirty, locked, unknown, integration, log, plan, or user-checkout safety.

Finalization requires every plan terminal, every `DONE` proof reachable, every private ref recognized, and every plan branch removable. Remove worktrees before branches, re-inventory, then delete private refs with exact expected targets. An already-finalized plan set with all plans terminal, no plan branches, and no private refs is idempotently complete.

For `--finalize --handoff-target`, require integration HEAD to be an ancestor of the local target immediately before deleting the clean, unlocked, distinct integration worktree and exact branch. Any failed proof or concurrent move preserves changed state. Report every removed item and every preservation reason.
