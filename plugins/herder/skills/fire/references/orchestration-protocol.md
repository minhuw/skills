# Plan Herder Orchestration Protocol

Use this protocol for every `fire` and `resume` run. The coordinator owns scheduling and integration. Agents own bounded work on one stable branch/worktree per plan; no child agent may spawn another child.

## Contents

1. Establish the plan set
2. Preflight without mutation
3. Branch, worktree, and lease layout
4. Dispatch ready plans
5. Restack, verify, review, and integrate
6. Recover before escalation
7. Usage accounting
8. Resume semantics
9. Completion
10. Cleanup

## 1. Establish the Plan Set

Resolve:

- `repo_root`: absolute repository root.
- `plan_dir`: absolute Herder plan directory, normally `<repo_root>/herder-plans`.
- `plan_name`: explicit `--plan-name`, otherwise the basename of `plan_dir`; require a lowercase Git-safe basename matching `[a-z0-9][a-z0-9._-]*` with no `..`, trailing `.`, or trailing `.lock`.
- `namespace`: `herder/<plan_name>`.
- `integration_branch`: `herder/<plan_name>/integration`.
- `plan_branch(<id>)`: `herder/<plan_name>/<id>`.
- `base_ref`: `refs/plan-herder/<plan_name>/base`.
- `completion_ref(<id>)`: `refs/plan-herder/<plan_name>/completed/<id>`.
- `checkpoint_ref(<id>, <generation>, <ordinal>)`: `refs/plan-herder/<plan_name>/checkpoints/<id>/<generation>-<ordinal>`.
- `plan_manager`, `namespace_runner`, `codex_evidence_reader`, `gate_runner`, and `cleanup_runner`: absolute paths to the installed plugin scripts.
- `base_commit`: current user-checkout `HEAD` for a new plan set, or `base_ref` for resume.
- `worktree_root`: a directory outside the user's checkout, with integration at `<worktree_root>/<plan_name>/integration` and plans at `<worktree_root>/<plan_name>/<id>`.
- `gate_log_root`: `<worktree_root>/<plan_name>/logs`, outside every Git worktree.
- `usage_attempts`: stable per-role ordinals reconstructed from the README ledger on resume. Use attempt IDs `<plan-name>-<plan-id|RUN>-<role>-<ordinal>`; never reuse an ID.
- `recovery_state`: per-plan generation IDs, substantive Saver rounds, clarification cycles, bounded non-capacity interruption restarts, transient-capacity backoff state, accepted replans, and compact failure signatures.
- `review_state`: per-plan-generation broad-pass count, exact reviewed base/HEAD/tree/status, ordered repair deltas, and a coordinator-owned stable finding ledger. Use a separate ledger with the same rules for the final cross-plan audit.

Read applicable repository instructions before dispatch. Inspect the user's checkout but do not clean, stash, reset, stage, or commit it. Treat `plan_dir` as coordinator-owned local state; it may be Git-ignored and must not be copied into execution worktrees. Obtain immutable worker input through `plan_manager snapshot`.

## 2. Preflight Without Mutation

Complete every check before creating a ref, branch, or worktree:

1. Confirm `git rev-parse --show-toplevel` and `git worktree list` succeed.
2. Run `node <plan_manager> validate <plan_dir> --pretty` and reject graph errors.
3. Confirm every indexed non-rejected plan file exists and is readable.
4. Run `node <namespace_runner> --repo <repo_root> --plan-dir <plan_dir> [--plan-name <plan_name>] --mode <fire|resume> --pretty`.
5. For fresh `fire`, require the complete branch and private-ref namespace to be unused. For `resume`, require the integration branch and base ref, and reject unknown, unindexed, parent-blocking, or contradictory state. A namespace conflict is a deliberate stop: report every conflict and tell the user to inspect it, explicitly resume it, clean it, or choose another name. Never invent a timestamp, adopt a branch, delete evidence, or overwrite a ref.
6. Resolve the three logical roles and their configured model/effort values. On Codex, require a live Multi-Agent V2 spawn schema in the `herder_agents` namespace containing both `agent_type` and `fork_turns`, and inspect the installed `plan_implementer`, `plan_reviewer`, and `plan_saver` definitions. Each must pin its expected model and effort. Never use a task name as a substitute for `agent_type`, and never perform a speculative model call during preflight. On Claude Code, probe the three native roles; a probe may only return `AVAILABLE`, is a usage-bearing `RUN` attempt, and must be recorded even when preflight later fails.
7. Determine repository-wide verification commands from repository instructions, CI configuration, and plan command tables. Do not guess commands when plans specify them.
8. Check intended worktree paths for collisions and confirm the host permission profile permits writes to Git metadata.

For a fresh plan set, create `base_ref` and the integration branch in one compare-and-swap `git update-ref --stdin` transaction whose expected old values are absent. If another process wins the namespace after preflight, the transaction must fail without replacing either ref. Then add the integration worktree from the existing branch. For resume, verify `base_ref` is an ancestor of integration HEAD and reopen a missing integration worktree without moving the branch.

If the Codex V2 interface, a custom profile, Git metadata permission, or a Claude role probe is unavailable, stop before mutation and report the missing capability. On Codex direct the user to `$herder:install`; never fall back to nested `codex exec` or a generic agent.

## 3. Branch, Worktree, and Lease Layout

The only local branches Fire owns for a plan set are:

```text
herder/<plan-name>/integration
herder/<plan-name>/<plan-id>
```

Each plan has exactly one stable branch and at most one worktree for its entire lifecycle. Implementer, reviewer, Saver, and a resumed coordinator use that same branch/worktree serially. Role, phase, attempt, generation, and failure are ledger state, not branch names. Never create candidate, stage, rescue, retry, generation, or timestamp branches.

Create a plan branch from the exact current integration HEAD with an absent-old-value `git update-ref` guard, then add its worktree. Recreate a missing worktree from the existing branch; never create a replacement branch for a missing directory.

Lock a plan worktree with `git worktree lock --reason plan-herder:<plan-name>:<plan-id>:<role>:<attempt-id>:<task-name>` while an agent can still access it. Use the stable attempt ID and requested task name so resume can identify the prior owner. Only the root coordinator may unlock, and only after the agent is terminal and no retry can reuse that session. A lock is a cleanup lease, not lifecycle state.

For a Codex attempt, call native Multi-Agent V2 with:

- a unique stable `task_name` based on plan name, plan ID, role, and ordinal;
- `agent_type` equal to `plan_implementer`, `plan_reviewer`, or `plan_saver`;
- `fork_turns: "none"`;
- one self-contained initial message containing the complete role prompt and immutable plan snapshot.

Omit model, reasoning-effort, and service-tier overrides. Use the returned canonical task name for follow-up, waits, interruption, and evidence. Treat spawn failure, terminal failure, or a terminal native state without a response envelope as an attempt failure, then apply Section 6 before deciding whether it consumed a Saver round. A quiet running worker is not a failed attempt.

Keep the coordinator shell anchored in the stable user checkout. Execute every Git command with `git -C <absolute-worktree>` and every non-Git command with an explicit workdir. Never remove or recreate the directory containing the coordinator process.

## 4. Dispatch Ready Plans

At each scheduling pass:

1. Run `node <plan_manager> ready <plan_dir> --pretty` from the coordination checkout. Route `blocked` plans to Saver and reconstruct `inProgress` plans through resume semantics; never treat either as fresh work.
2. Select `TODO` plans whose dependencies are all `DONE`.
3. Resolve every dependency from `completion_ref(<id>)` and require it to be an ancestor of integration HEAD. Accept reachable legacy completion trailers or exact-subject markers only for backward compatibility; never create them.
4. Before mutation, require `plan_branch(<id>)` not to exist. If it exists during fresh dispatch, stop that plan for namespace reconciliation; never reset or reuse it speculatively.
5. Create the plan branch from exact integration HEAD, record that replay base, add its worktree, and verify dependency commits are ancestors of the base.
6. Mark selected plans `IN PROGRESS` through `plan_manager transition` as a batch before dispatch; workers never edit the index.
7. Dispatch up to available concurrency. Independent plan implementers may run concurrently, but one plan has only one active owner.

Do not dispatch a dependent merely because an implementer finished; wait for reviewed integration, a reachable completion ref, and `DONE` status.

### Implementer prompt contract

Give the resolved implementer:

- its role and prohibition on spawning agents;
- the absolute plan worktree path and branch;
- the recorded branch base SHA;
- complete `planText` from `snapshot`, always inlined;
- applicable repository instructions;
- an instruction never to edit the plan index or statuses;
- the stable attempt ID and resolved model/effort attribution;
- requirements to stay in scope, honor STOP conditions, run every gate, and commit all intended changes;
- a requirement that commit messages describe only repository changes and reasons, without Herder or orchestration metadata;
- a requirement to summarize checks without pasting logs;
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

Tell the worker to use `unknown` for values not exposed by the host and never estimate. Structured host telemetry wins. Missing commits, dirty intended changes, unverifiable checks, `STOPPED`, tool errors, or a terminal attempt without a response enter recovery in the same plan worktree. Record every attempt through Plans.

### Coordinator wait discipline

After dispatching Codex workers, call native `wait_agent` with `timeout_ms: 1800000`. It is a long poll: an update ends the wait immediately; otherwise the timeout supplies a thirty-minute heartbeat. The timeout caps idle wakeups, not result-delivery latency. Process every queued update before waiting again.

A timeout is not a state change. If no local work became ready, do not reread transcripts, request status, or call `list_agents`; issue the next long wait. Use `list_agents` only for initial bookkeeping or reconciliation after an ambiguous, missing, or contradictory terminal event. On Claude Code, use the native blocking wait with the same event-first behavior.

## 5. Restack, Verify, Review, and Integrate

Never test a plan by first advancing integration. Serialize restacking, coordinator gates, review, and integration advancement across the plan set. Once one plan enters this lane, do not advance integration for another plan until the transaction approves, enters recovery, or stops.

Run every coordinator-owned verification gate through:

```text
node <gate_runner> --cwd <absolute-worktree> --log-dir <gate_log_root>/<plan-or-RUN>/<phase> --label <stable-label> -- <command> <arguments...>
```

Pass the exact argv after `--`; do not add a shell unless the command requires one. Never place secrets in arguments. The runner writes combined output to a private log and returns only fingerprint, exit status, duration, byte count, SHA-256, and log path. It returns no command output on success or failure. Never reread a full gate log into coordinator context; let Saver reproduce failures in its isolated context. Preserve logs with failed state.

Run transactions fail-fast. Before retrying, prove integration HEAD still equals the recorded transaction base.

For each completed plan branch:

1. Require its worktree to be clean, unlocked, and unowned. Record branch base, HEAD, tree SHA, and ordered merge-free commits. Require at least one commit and no merge commit.
2. If its recorded base differs from current integration HEAD, create a unique immutable checkpoint ref naming the pre-restack HEAD with an absent-old-value guard. Restack the same checked-out plan branch in place with `git rebase --onto <integration-head> <recorded-base>`. Never merge integration into it. A conflict or interrupted rebase remains in that exact worktree and enters Saver; never abort, reset, clean, or create another branch merely to recover cleanliness.
3. After restacking, require clean status, a merge-free unique range from the new integration base, and patch equivalence with the pre-restack checkpoint using `git cherry`. Record the new exact base, HEAD, tree, and commit list.
4. Run every plan done criterion and applicable project-wide gate in the plan worktree.
5. Dispatch the read-only reviewer against the complete diff from recorded integration base to plan HEAD. Record clean status and tree before dispatch; prove base, HEAD, tree, and status are unchanged afterward. Reviewer mutation is failure even when its verdict says `APPROVE`.

Do not add Herder metadata to a commit subject or body.

### Review acceptance and convergence

A finding blocks only when it is:

1. a P0/P1 defect introduced by the plan or repair diff;
2. a failed required acceptance criterion or verification command; or
3. a demonstrated violation of an explicit plan requirement or material scope constraint.

P0 is a universal release, security, data-loss, or operational emergency. P1 is an urgent functional regression or explicit acceptance failure. P2 and P3 findings are advisory and never block integration, enter Saver, or prevent `DONE`.

A blocker must identify an exact changed file and line, triggering scenario, reproducible evidence or failing check, and introducing hunk or commit. Reject pre-existing defects, speculation, and unstated intent. Style, formatting, documentation nits, unrelated cleanup, and generated-file churn are advisory unless explicitly required or demonstrably P0/P1.

Maintain a monotonic finding ledger per plan generation. Assign each `NEW` finding the next stable ID (`F001`, `F002`, ...), deduplicate by root cause, and store severity, gate class, first-seen reviewed SHA, file/cause, evidence, introducing diff, and status (`OPEN`, `RESOLVED`, `ADVISORY`, `DISMISSED`, or `NEEDS_ADJUDICATION`). Preserve IDs across restacks and resume.

Use two modes:

- `DISCOVERY`: inspect the complete plan diff. Allow at most two completed broad discovery passes per generation. The initial review is pass one; one post-repair broad pass is allowed. A restack whose patch is unchanged earns no new pass.
- `VERIFICATION`: after the second broad pass, verify only open blocker IDs and inspect the repair delta for regressions.

If verification finds a new evidence-complete P0/P1 regression introduced by the repair delta, add it and use remaining Saver budget. A new blocker outside that delta after the cap becomes `NEEDS_ADJUDICATION`; transition the plan to `BLOCKED` and ask whether to accept or defer it. Do not restart broad discovery. A deferred finding becomes advisory.

Normalize the effective gate from evidence. A `REVISE` response containing only P2/P3, dismissed, or non-qualifying findings is effective approval when required gates and scope pass. Only an evidence-complete open blocker produces effective `REVISE`; reserve `BLOCK` for an irreducible blocker.

### Reviewer prompt contract

Give the reviewer:

- its read-only role and prohibition on editing or spawning agents;
- the absolute plan worktree and branch;
- complete plan text;
- exact integration-base, plan-HEAD, and tree SHAs;
- actual checks and compact results;
- review mode, completed/remaining broad-pass counts, and complete finding ledger;
- for verification, exact repair commit range and open blocker IDs;
- stable attempt ID and model/effort attribution;
- instructions to preserve IDs, apply the acceptance policy, and summarize without log dumps;
- this exact response shape:

```text
VERDICT: APPROVE | REVISE | BLOCK
FINDINGS: <ordered `[<existing-id|NEW>][P0|P1|P2|P3][BLOCKING|ADVISORY] file:line — issue; scenario=...; evidence=...; introduced_by=...` entries, or none>
SCOPE: PASS | FAIL
CHECKS: <independently verified commands/results>
RATIONALE: <concise>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Integrate only after effective `APPROVE`, effective scope `PASS`, all required checks pass, and no `OPEN` or `NEEDS_ADJUDICATION` blocker remains. Immediately before advancing, require integration HEAD to equal the reviewed base and the plan branch HEAD/tree/status to equal the reviewed values. Fast-forward the integration worktree with `git merge --ff-only <plan-branch>`; this must add no merge node. If integration moved, approval is invalid for advancement: checkpoint and restack the same plan branch, rerun required gates, and verify the unchanged patch without granting another discovery pass.

After fast-forward, require integration HEAD to equal approved plan HEAD. Create `completion_ref(<id>)` with an absent-old-value guard, verify it is reachable, then transition the plan to `DONE`. If transition fails, stop dependency dispatch and reconcile from the private ref. After `DONE`, prove no agent can access the plan worktree, unlock it, and invoke cleanup with `--plan <id>`. Cleanup failure is a maintenance warning, not a rollback.

Any restack, gate, review, or compare-and-advance failure leaves integration unchanged and enters recovery on the same plan branch/worktree.

## 6. Recover Before Escalation

Never ask Saver to reconstruct failed work elsewhere. Dispatch it in the exact plan worktree containing committed, dirty, conflicted, or interrupted state. Do not create a recovery branch.

An **agent attempt** is one host spawn and always receives a unique usage row. A **Saver repair round** is a substantive Saver result or an attempt that may have mutated the worktree. Host interruption alone is free only when every no-mutation invariant below is proven.

A **plan generation** starts with an immutable plan snapshot, integration-base SHA, the stable plan branch reset for fresh implementation, an empty finding ledger, and zero broad passes. Number the initial generation `0`; increment only after accepted `REPLAN`, validated revised plan, checkpointed old HEAD, and controlled reset of the clean isolated plan branch to current integration. `REPAIRED`, restacks, clarification answers, and interrupted attempts remain in the same generation.

Before every Saver dispatch, record integration HEAD; plan branch HEAD and tree; exact porcelain status; generation, snapshot SHA-256, repair-round number, and attempt ordinal; and any rebase state. Dirty state may contain the work Saver must recover and is ineligible for a no-cost interruption restart. Never abort a rebase, reset, clean, stash, or discard merely to make an attempt eligible.

Give Saver only:

- the absolute plan worktree and branch;
- complete snapshotted plan text;
- a compact failure envelope containing source (`implementer`, `restack`, `gate`, `review`, or `compare-and-advance`), generation, snapshot SHA-256, integration base, immutable failed HEAD/tree, exact status/rebase state, open blocker evidence, reproduction commands, compact gate evidence, ledger, broad-pass count, repair delta, prior outcomes, and remaining budgets;
- expected behavior: reproduce, repair and commit if possible, resolve an in-progress restack when safe, or classify the blocker;
- the user's answer after `NEEDS_INPUT`;
- stable attempt ID and model/effort attribution;
- this exact response shape:

```text
OUTCOME: REPAIRED | REPLAN | NEEDS_INPUT | TERMINAL
COMMITS: <ordered SHAs, or none>
CHECKS: <command — result, one per line>
QUESTION: <one focused question only for NEEDS_INPUT>
REPLAN: <specific corrected assumption/plan text only for REPLAN>
EVIDENCE: <concise repository/tool evidence>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Pass direct evidence, not theories or raw gate logs. Never pass P2/P3 advisories. Tell Saver to repair supplied blockers first and broaden only when evidence is systemic or cannot explain failure. Saver never self-approves.

### Host interruption

Classify `INTERRUPTED` only when: native host evidence proves platform/policy/transport/session failure rather than repository failure; no parseable final Saver envelope exists; integration HEAD and plan HEAD/tree exactly match pre-dispatch; and the worktree was clean before and remains clean including untracked files. Unknown or false conditions mean `FAILED`, consume the round, and preserve exact state.

For a proven interruption, record exact usage, do not increment repair or clarification counters, and use a fresh session/attempt ID with the same self-contained prompt. Never resume the interrupted child conversation.

- For transient capacity, do not increment any retry, interruption, clarification, replan, or recovery bound. Use fresh Saver sessions after 30 seconds, 60 seconds, 120 seconds, and 300 seconds, capped at 300 seconds. Never infer capacity from quiet, timeout, disconnect, or missing response. If cancellation/deadline/host lifecycle stops waiting, transition to `BLOCKED — infrastructure capacity unavailable; recovery budget preserved` and retain the same branch/worktree.
- For explicitly non-retryable infrastructure, transition immediately to the same infrastructure `BLOCKED` state without consuming substantive recovery.
- For other host interruption, allow at most two same-round non-capacity interruption restarts, then block with infrastructure/policy reason while preserving unused substantive budget.

Handle outcomes:

- `REPAIRED`: record repair commits/delta and rerun restack if necessary, all gates, and `DISCOVERY` or `VERIFICATION` according to the existing broad-pass count.
- `REPLAN`: validate evidence and guards. If accepted, revise/validate the plan, create a unique checkpoint for current HEAD, require clean unowned worktree, reset the same isolated plan branch to exact integration HEAD, increment generation, and dispatch a fresh implementer. This controlled reset is permitted only after the checkpoint succeeds; never reset dirty or ambiguously owned state.
- `NEEDS_INPUT`: ask the one irreducible question, continue unrelated plans, then automatically redispatch Saver in the same worktree with the answer.
- `TERMINAL`: transition to `BLOCKED` with a one-line reason.

Give each generation two substantive autonomous Saver rounds and two clarification cycles. Accept at most two `REPLAN` outcomes per plan per invocation. Derive compact failure signatures without generation numbers or SHAs. If the same signature survives two consecutive completed generations, reject another replan for it. When a bound is exhausted, transition to `BLOCKED`, preserve the single plan branch/worktree, and report the exact bound. A new explicit resume authorizes another bounded recovery cycle but does not reset review state.

## 7. Usage Accounting

The root coordinator is the only usage-ledger writer. After every terminal attempt, call `record-usage` before the next lifecycle action. Continue ordinals across resume and new invocations for the same plan directory. Use plan `RUN` for final-audit attempts. Record normalized outcomes including `INTERRUPTED`.

Prefer host-reported effective routing and structured usage. On Codex, after terminal state run `node <codex_evidence_reader> --agent <canonical-task-name> --pretty`; require matching role and `multiAgentVersion: v2`. Use terminal fields plus native state; `taskComplete` alone is insufficient. Copy exact transcript usage when uniquely attributable, otherwise record all fields/source as `unknown`. Never tokenize transcripts, subtract coordinator totals, or infer reasoning.

Use `plan_manager usage` for reporting. Always report coverage beside known subtotals; the ledger excludes unobservable coordinator/platform overhead.

## 8. Resume Semantics

Run namespace preflight in `resume` mode, then reconstruct from Plans status, `base_ref`, completion/checkpoint refs, the exact integration/plan branches, worktree leases/status/rebase state, persisted child evidence, gate evidence, reviewer envelopes, finding IDs, and usage rows. Conversation history is never a dependency; every replacement child receives a fresh self-contained prompt.

Treat locks as leases. On Codex, run `node <codex_evidence_reader> --workdir <absolute-worktree> --pretty` and correlate the structured lock reason with persisted child evidence. If owner is active, keep the lease and let the owning coordinator wait; a fresh coordinator must not dispatch competition. If terminal with a parseable envelope, record usage and continue. If interrupted with proven clean unchanged state, record `INTERRUPTED` and use a fresh agent. If ownership remains ambiguous, preserve the lock and stop that plan.

Classify each retained plan branch:

- Dirty, conflicted, or rebasing with no active owner: preserve exact worktree and dispatch Saver there; never abort or replace it.
- Clean with merge-free unique commits not yet completed: reconstruct its base/checkpoint, then restack if needed, gate, and review.
- Clean with no unique commits and `IN PROGRESS`: dispatch a fresh implementer only when evidence proves no prior mutation was lost; otherwise stop for reconciliation.
- `BLOCKED`: dispatch Saver on the existing plan branch. If the branch is absent, create it only when the ledger and evidence prove no failed work existed; otherwise stop.
- Valid completion ref reachable from integration: reconcile `DONE` before dependencies. `DONE` without proof or with failed cheap verification transitions to `BLOCKED` and recovery.

Reconstruct review state from reviewer envelopes and exact reviewed base/HEAD/tree. Resume or restack never resets broad-pass count or ledger. If reconstruction is ambiguous, treat broad discovery as exhausted and send new outside-delta blockers to human adjudication. Continue all ordinals and never rewrite usage.

A crash may occur after the integration fast-forward but before the completion ref is written. Recover only when evidence proves exact plan HEAD/tree received effective approval, every gate passed, no mutation followed, and that exact commit is current/reachable integration. Then create the missing ref with absent-old-value guard and reconcile `DONE`. Never infer approval merely because an unmarked commit is present on integration.

## 9. Completion

The plan set succeeds when every plan is `DONE` or `REJECTED`, every dependency completion ref is reachable from integration, final project-wide gates pass, and the final reviewer ledger has no qualifying cross-plan blocker. P2/P3 findings remain advisory.

Apply the same finding ledger and two-broad-pass cap to the final audit. After plan scheduling is terminal, a final gate/audit repair may operate directly in the isolated integration worktree to avoid another branch: first create a unique `checkpoints/RUN/<ordinal>` ref for integration HEAD, stop all plan dispatch, and give Saver a synthetic plan. Treat added repair commits as unapproved until all final gates and reviewer approval succeed. If interruption leaves dirty or unapproved integration state, preserve and resume that exact worktree; never hand it off. Only final approved integration may be reported as complete.

After successful final gates/audit, prove no agent can access a plan worktree and invoke fail-closed `--finalize`. Finalization removes every eligible plan branch/worktree, re-inventories the namespace, and deletes recognized private coordination refs only when no plan branch remains. Dirty, locked, missing, unrecognized, nonterminal, or unverifiable state preserves refs and reports a maintenance warning without rolling back approved integration.

Never merge, push, publish, or deploy. Report integration branch/worktree, final SHA, plan outcomes, checks and compact log evidence, usage/coverage, advisory/adjudication findings, and preserved branches.

Fire never merges into the user's branch. When the intended target still points to `base_ref`, report `git merge --ff-only herder/<plan-name>/integration`. If it moved, report that fast-forward is unavailable and require a fresh replay/review cycle on the new target. Never recommend a non-fast-forward merge or rebasing the user's branch to force handoff.

After the user fast-forwards, report `herder:fire cleanup <plan-dir> [--plan-name <name>] --finalize --handoff-target <target-branch>`. It never performs the merge. It removes integration only after proving the named target contains integration and the integration worktree is clean, unlocked, present, and not the user checkout.

## 10. Cleanup

Cleanup is coordinator-only. Invoke:

```text
node <cleanup_runner> --repo <repo_root> --plan-dir <plan_dir> [--plan-name <name>] [--plan <id>] [--dry-run] [--include-failed] [--finalize] [--handoff-target <branch>] --pretty
```

The runner derives the exact integration branch from the validated plan name. `--finalize` cannot combine with `--plan`; `--handoff-target` requires `--finalize`. Before mutation, prove no active or ambiguous agent can access targeted worktrees. Dry run never unlocks.

The runner recognizes only `herder/<plan-name>/<indexed-id>` plan branches plus exact integration. By default, a plan branch is eligible only when status is `DONE`, its completion proof is reachable, and its worktree is clean/unlocked. Delete worktree first, then branch with its preflight SHA as expected old value. Preserve clean non-`DONE` branches unless the user explicitly supplied `--include-failed` while the run is stopped; that flag never overrides dirty, locked, missing, unknown, integration, logs, plans, or user-checkout protection.

Finalization additionally requires every plan terminal, every `DONE` proof reachable, every private ref recognized, and every plan branch removable. Remove plan branches/worktrees, re-list, then delete private refs with exact expected targets. Preserve integration, logs, plans, and all refs whenever any prerequisite fails. An already-finalized plan set with all plans terminal, no plan branches, and no private refs is idempotently complete; later resume reruns final gates without recreating workers.

For `--finalize --handoff-target`, require integration HEAD to be an ancestor of the local target immediately before deletion. Remove a clean distinct integration worktree first, then delete its exact branch with preflight SHA. Any failed proof or concurrent move preserves changed state.

Report every planned/removed item and every preservation reason. Never ask a worker to clean Git state.
