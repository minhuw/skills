# Plan Herder Orchestration Protocol

Use this protocol for every `fire` and `resume` run. The coordinator owns scheduling and integration. Implementer, Reviewer, Judge, and Saver agents own bounded serial work on one stable branch/worktree per plan; no child agent may spawn another child.

## Contents

1. Establish the plan set
2. Preflight without mutation
3. Branch, worktree, and lease layout
4. Dispatch ready plans
5. Restack, verify, review, and integrate
6. One-shot recovery implementation
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
- `plan_manager`, `namespace_runner`, `checkout_guard`, `assignment_manager`, `codex_evidence_reader`, `gate_runner`, and `cleanup_runner`: absolute paths to the installed plugin scripts.
- `base_commit`: current user-checkout `HEAD` for a new plan set, or `base_ref` for resume.
- `worktree_root`: a directory outside the user's checkout, with integration at `<worktree_root>/<plan_name>/integration` and plans at `<worktree_root>/<plan_name>/<id>`.
- `gate_log_root`: `<worktree_root>/<plan_name>/logs`, outside every Git worktree.
- `parallel_limit`: explicit positive integer `--max-parallel`, otherwise `5`, capped by host-available worker capacity. It is one global limit across Implementer, Reviewer, Judge, and Saver roles.
- `scheduler_state`: active role attempt per plan, queued mutation work, completed branches waiting for review, and the optional single transaction-lane owner/phase. One claimed transaction lane reserves one parallel slot, including its coordinator-only restack and gate phases; its active Reviewer or Judge consumes that reservation rather than another slot.
- `usage_attempts`: stable per-role ordinals reconstructed from the README ledger on resume. Use attempt IDs `<plan-name>-<plan-id|RUN>-<role>-<ordinal>`; never reuse an ID.
- `recovery_state`: per-plan generation IDs, whether the single substantive Saver attempt is consumed, one clarification cycle, bounded non-capacity interruption restarts, and transient-capacity backoff state.
- `review_state`: per-plan-generation substantive Implementation attempt count out of five, separate review-pass count, exact reviewed base/HEAD/tree/status, ordered repair deltas and guidance, per-review Judge outcomes, leak records, and a coordinator-owned stable finding ledger. Use a separate ledger with the same rules for the final cross-plan audit.
- `checkout_state_token`: the compact token returned by `checkout_guard` for the coordination checkout, excluding only `plan_dir`.
- `assignment_state(<id|RUN>)`: the absolute worktree-local assignment path, exact bundle SHA-256, compiled snapshot SHA-256, original generation-base SHA, and branch returned by `assignment_manager materialize` or `materialize-run`.
- `execution_runtime`: explicit `native` or `orca`, never inferred.
- `runtime_profile`: for Orca, the validated absolute profile path, profile hash, controller terminal, role routing, and Orca worktree/task/dispatch mappings retained outside Git worktrees.

Read applicable repository instructions before dispatch. Inspect the user's checkout but do not clean, stash, reset, stage, or commit it. Treat the source `plan_dir` as coordinator-owned local state; workers must never read it. Obtain immutable worker input through `plan_manager snapshot`, then materialize only compiled plan or plan-set snapshots into their applicable execution worktree with `assignment_manager`. Do not copy the full backlog, mutable index, usage ledger, leak drafts, raw logs, or coordinator absolute paths.

## 2. Preflight Without Mutation

Complete every check before creating a ref, branch, or worktree:

1. Confirm `git rev-parse --show-toplevel` and `git worktree list` succeed.
2. Run `node <checkout_guard> --repo <repo_root> --exclude <plan_dir> --pretty`; require `ok: true`, retain its `stateToken`, and never expose file contents. The guard fingerprints HEAD, symbolic branch, logical index state, Git status, and the bytes of pre-existing dirty tracked and untracked files while allowing only coordinator-owned plan-directory writes. A racing checkout fails preflight.
3. Run `node <plan_manager> validate <plan_dir> --pretty` and reject graph errors. Run `node <plan_manager> shape <plan_dir> --pretty`; reject invalid file budgets, local-plan/shared-context prose overflow, and unordered overlapping ready-plan write scopes. A legacy plan with missing shape fields remains resumable, but assign the conservative fallback `files<=8` and report the compatibility warning. Accept legacy `changed_lines<=N` text for compatibility but ignore it completely: line counts are never a scope, STOP, review, repair, Saver, or integration criterion.
4. Confirm every indexed non-rejected plan file exists and is readable.
5. Run `node <namespace_runner> --repo <repo_root> --plan-dir <plan_dir> [--plan-name <plan_name>] --mode <fire|resume> --pretty`.
6. For fresh `fire`, require the complete branch and private-ref namespace to be unused. For `resume`, require the integration branch and base ref, and reject unknown, unindexed, parent-blocking, or contradictory state. A namespace conflict is a deliberate stop: report every conflict and tell the user to inspect it, explicitly resume it, clean it, or choose another name. Never invent a timestamp, adopt a branch, delete evidence, or overwrite a ref.
7. Resolve the four logical roles and their configured model/effort values. For native Codex, require a live Multi-Agent V2 spawn schema in the `herder_agents` namespace containing both `agent_type` and `fork_turns`, and inspect the installed `plan_implementer`, `plan_reviewer`, `plan_judge`, and `plan_saver` definitions. Each must pin its expected model and effort. Never use a task name as a substitute for `agent_type`, and never perform a speculative model call during preflight. On native Claude Code, probe the four native roles; a probe may only return `AVAILABLE`, is a usage-bearing `RUN` attempt, and must be recorded even when preflight later fails. For Orca, read `orca-runtime.md`, validate the explicit runtime profile, and require its live preflight to resolve the controller plus every child harness/provider/model without substitution.
8. Determine repository-wide verification commands from repository instructions, CI configuration, and plan command tables. Do not guess commands when plans specify them.
9. Check intended worktree paths for collisions and confirm the host permission profile permits writes to Git metadata.

For a fresh native plan set, create `base_ref` and the integration branch in one compare-and-swap `git update-ref --stdin` transaction whose expected old values are absent. If another process wins the namespace after preflight, the transaction must fail without replacing either ref. Then add the integration worktree from the existing branch. For fresh Orca, follow `orca-runtime.md`: Orca creates the exact integration branch/worktree at `base_commit`, then a transaction verifies that branch target and creates absent `base_ref`. After either runtime creates integration, materialize the immutable final-audit context:

```text
node <assignment_manager> materialize-run --plan-dir <plan_dir> --worktree <absolute-integration-worktree> --expected-branch <integration-branch> --expected-head <base-commit> --pretty
```

Record and immediately verify its returned RUN bundle path, bundle SHA-256, and snapshot-set SHA-256. It contains ordered compiled plan snapshots but no mutable index, usage ledger, leaks, or coordinator metadata paths. For resume, verify `base_ref` is an ancestor of integration HEAD, reopen a missing integration worktree through its owning runtime without moving the branch, and require the originally recorded RUN bundle to verify before final-audit work.

If the required native interface/profile, Orca runtime/profile/role, Git metadata permission, or Claude role probe is unavailable, stop before mutation and report the missing capability. On native Codex direct the user to `$herder:install`; never fall back to nested `codex exec` or a generic agent. On Orca never fall back to a native child or another configured model.

## 3. Branch, Worktree, and Lease Layout

The only local branches Fire owns for a plan set are:

```text
herder/<plan-name>/integration
herder/<plan-name>/<plan-id>
```

Each plan has exactly one stable branch and at most one worktree for its entire lifecycle. Implementer, Reviewer, Judge, Saver, and a resumed coordinator use that same branch/worktree serially. Role, phase, attempt, generation, and failure are ledger state, not branch names. Never create candidate, stage, rescue, retry, generation, or timestamp branches.

In native runtime, create a plan branch from the exact current integration HEAD with an absent-old-value `git update-ref` guard, then add its worktree. In Orca runtime, have Orca create the exact plan branch/worktree from current integration and immediately verify its returned identity, symbolic branch, and exact HEAD as defined in `orca-runtime.md`. Reopen a missing worktree only through its owning runtime and existing branch; never create a replacement branch for a missing directory.

Lock a plan worktree with `git worktree lock --reason plan-herder:<plan-name>:<plan-id>:<role>:<attempt-id>:<task-name>` while an agent can still access it. Use the stable attempt ID and requested task name so resume can identify the prior owner. Only the root coordinator may unlock, and only after the agent is terminal and no retry can reuse that session. A lock is a cleanup lease, not lifecycle state.

For a Codex attempt, call native Multi-Agent V2 with:

- a unique stable `task_name` based on plan name, plan ID, role, and ordinal;
- `agent_type` equal to `plan_implementer`, `plan_reviewer`, `plan_judge`, or `plan_saver`;
- `fork_turns: "none"`;
- one self-contained initial message containing the complete role prompt, the absolute worktree-local assignment path, its exact bundle SHA-256, and the attempt-specific evidence. The compiled plan itself remains authoritative in that immutable local bundle. Require every command—including the first bundle hash/type check—to set that exact assigned worktree as its explicit workdir; `/tmp`, the coordinator checkout, and other neutral directories are forbidden command workdirs.

Omit model, reasoning-effort, and service-tier overrides. Use the returned canonical task name for follow-up, waits, interruption, and evidence. Treat spawn failure, terminal failure, or a terminal native state without a response envelope as an attempt failure, then apply Section 6 before deciding whether it consumed an Implementation attempt or the one Saver attempt. A quiet running worker is not a failed attempt.

For an Orca attempt, create a fresh configured role terminal in the stable Orca worktree and use one tracked Orca orchestration task plus the adapter's explicit lifecycle delivery, exactly as defined in `orca-runtime.md`. Matching `worker_done` task/dispatch/pane provenance replaces native terminal completion evidence. A quiet running terminal or wait heartbeat is not a failed attempt.

Keep the coordinator shell anchored in the stable user checkout. Execute every Git command with `git -C <absolute-worktree>` and every non-Git command with an explicit workdir. Never remove or recreate the directory containing the coordinator process.

Before and after every Implementer, Reviewer, Judge, or Saver attempt, run:

```text
node <assignment_manager> verify --worktree <absolute-worktree> --bundle <absolute-assignment-path> --expected-bundle-sha256 <bundle-sha256> --pretty
```

Require its branch and snapshot fields to match the recorded assignment state. A missing, writable, symlinked, moved, branch-mismatched, or hash-mismatched bundle is a containment failure: stop dispatch and integration for that plan, preserve the branch/worktree and evidence, and never regenerate the bundle silently from the current source backlog. Every worker must independently compare the supplied bundle SHA-256 before reading the applicable `planText` entry or entries, treat that compiled text as the only plan authority, and stop without mutation on mismatch. Bundle authentication reads the absolute bundle path while using the assigned worktree itself as the command workdir; it never requires a neutral directory.

Immediately before dispatching any worker, and again after it becomes terminal before acting on its result, run `node <checkout_guard> --repo <repo_root> --exclude <plan_dir> --expect <checkout_state_token> --pretty`. Verify once more before final handoff. A mismatch cannot be attributed safely to the worker or the user: stop all new scheduling, integration, and cleanup; preserve leases, branches, worktrees, and evidence; report only the changed component names; and never restore, stage, stash, hash-dump, or rewrite the user's checkout. A later explicit resume captures a new baseline after the user has reconciled the checkout.

## 4. Dispatch Ready Plans

Use one event-driven, role-agnostic worker pool for the whole run. The occupied capacity is every active Implementer or Saver outside the transaction lane plus the lane's single reservation; a Reviewer or Judge running in the lane uses that reservation. Never let occupied capacity exceed `parallel_limit`, and never give one plan more than one active owner.

At each scheduling pass, preserve or claim the transaction-lane reservation before allocating mutation slots, then prepare fresh implementation work for the remaining capacity:

1. Run `node <plan_manager> ready <plan_dir> --pretty` from the coordination checkout. Route `blocked` and `inProgress` plans through resume semantics; never treat either as fresh work or dispatch Saver without reconstructed five-attempt and Judge evidence.
2. Select `TODO` plans whose dependencies are all `DONE`.
3. Resolve every dependency from `completion_ref(<id>)` and require it to be an ancestor of integration HEAD. Accept reachable legacy completion trailers or exact-subject markers only for backward compatibility; never create them.
4. Before mutation, require `plan_branch(<id>)` not to exist. If it exists during fresh dispatch, stop that plan for namespace reconciliation; never reset or reuse it speculatively.
5. Create the plan branch from exact integration HEAD, record that replay base, add its worktree, and verify dependency commits are ancestors of the base.
6. Run `plan_manager snapshot` in the coordination checkout and verify every reported input/content hash. Then run:

   ```text
   node <assignment_manager> materialize --plan <id> --plan-dir <plan_dir> --worktree <absolute-worktree> --expected-branch <plan-branch> --expected-head <replay-base> --expected-snapshot-sha256 <snapshot-sha256> --pretty
   ```

   Require the returned path to be inside the exact plan worktree and Git-ignored, retain its bundle SHA-256 as generation evidence, and immediately verify it. The helper must leave visible Git status unchanged. Never hand-create, overwrite, or repair this bundle.
7. Mark selected plans `IN PROGRESS` through `plan_manager transition` as a batch before dispatch; workers never edit the index.
8. Dispatch initial Implementers only into unoccupied global slots. Independent mutation attempts may run concurrently, but one plan has only one active owner.

Do not dispatch a dependent merely because an implementer finished; wait for reviewed integration, a reachable completion ref, and `DONE` status.

After every worker event, drain all queued terminal updates, record and verify their evidence, then run another scheduling pass before waiting again:

1. Continue the current transaction-lane chain first: a completed Reviewer is followed by Judge in the same reserved slot, and a retryable read-only transport failure retains the reservation.
2. If the lane is free and a completed implementation or recovery branch is ready for restack/gates/review, claim the lane for the oldest dependency-order candidate and reserve one slot immediately. Do not fill that slot with new mutation work while coordinator gates run.
3. Fill every other available slot with dependency-ready initial Implementers, Judge-authorized guided-repair Implementers, or eligible Savers in stable dependency/attempt order.
4. Wait only after no lane transition, terminal result, or eligible dispatch can make progress. Never wait for all implementations in a wave to finish before starting the first review transaction.

Mixed roles are intentional. With effective limit `5`, one plan may use the reserved lane for Reviewer or Judge while up to four different plans run Implementer, guided-repair Implementer, or Saver attempts. Two plans may never restack, gate, review, Judge, or advance integration concurrently.

### Implementer prompt contract

Give the resolved implementer:

- its role and prohibition on spawning agents;
- the absolute plan worktree path and branch;
- the recorded branch base SHA;
- the absolute assignment-bundle path inside that worktree, exact bundle SHA-256, compiled `snapshotSha256`, and numeric file budget; require it to verify the bundle hash and read `planText` locally before any repository action;
- applicable repository instructions;
- an instruction never to read the coordinator checkout, source `plan_dir`, sibling worktrees, common Git directory, or another plan file as assignment input;
- an instruction never to edit the plan index or statuses;
- the stable attempt ID and resolved model/effort attribution;
- mode `INITIAL`, requirements to stay in declared paths and within the file budget, honor non-LOC STOP conditions, run every gate, and commit all intended changes. Explicitly state that any legacy `changed_lines` value or LOC-based STOP text is nonbinding and must not stop or block the attempt;
- a requirement that commit messages describe only repository changes and reasons, without Herder or orchestration metadata;
- a requirement to summarize checks without pasting logs;
- this exact response shape:

```text
STATUS: COMPLETE | STOPPED | FAILED
COMMITS: <ordered SHAs, or none>
ADDRESSED: <finding IDs, or none>
CHECKS: <command — result, one per line>
FILES CHANGED: <paths>
STOPPED BECAUSE: <only when not COMPLETE>
NOTES: <material facts only>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Tell the worker to use `unknown` for values not exposed by the host and never estimate. Structured host telemetry wins. Missing commits, dirty intended changes, unverifiable checks, `STOPPED`, tool errors, or a terminal attempt without a response preserve the same plan worktree. Record every attempt through Plans. While the five-attempt Implementation budget remains, dispatch a fresh Implementer in `GUIDED_REPAIR` with exact coordinator-proven operational evidence; never send an ordinary implementation, restack, or gate failure directly to Saver.

### Coordinator wait discipline

After dispatching native Codex workers, call native `wait_agent` with `timeout_ms: 1800000`. For Orca workers, call `orca orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 1800000` from the recorded controller terminal. Either is a long poll: an update ends the wait immediately; otherwise the timeout supplies a thirty-minute heartbeat. The timeout caps idle wakeups, not result-delivery latency. Process every queued update and immediately backfill eligible global slots before waiting again.

A timeout is not a state change. If no local work became ready, do not reread transcripts, request status, or call `list_agents`; issue the next long wait. Use `list_agents` only for initial bookkeeping or reconciliation after an ambiguous, missing, or contradictory terminal event. On Claude Code, use the native blocking wait with the same event-first behavior.

## 5. Restack, Verify, Review, and Integrate

Never test a plan by first advancing integration. Serialize restacking, coordinator gates, Reviewer, Judge, and integration advancement through one transaction lane across the plan set. Claiming the lane reserves one global slot until the transaction approves and integrates, releases into mutation recovery, or stops. The lane serializes review/integration transactions, not unrelated mutation work: keep other slots available to Implementer and Saver attempts on different plans, and do not wait for a mutation wave to drain before claiming the lane.

Run every coordinator-owned verification gate through:

```text
node <gate_runner> --cwd <absolute-worktree> --log-dir <gate_log_root>/<plan-or-RUN>/<phase> --label <stable-label> -- <command> <arguments...>
```

Pass the exact argv after `--`; do not add a shell unless the command requires one. Never place secrets in arguments. The runner writes combined output to a private log and returns only fingerprint, exit status, duration, byte count, SHA-256, and log path. It returns no command output on success or failure. Never reread a full gate log into coordinator context; let the next authorized Implementer or one-shot Saver reproduce failures in its isolated context. Preserve logs with failed state.

Run transactions fail-fast. Before retrying, prove integration HEAD still equals the recorded transaction base.

For each completed plan branch:

1. Require its worktree to be clean, unlocked, and unowned. Record branch base, HEAD, tree SHA, and ordered merge-free commits. Require at least one commit and no merge commit.
2. Verify the recorded assignment bundle before any restack or gate.
3. If its recorded base differs from current integration HEAD, create a unique immutable checkpoint ref naming the pre-restack HEAD with an absent-old-value guard. Restack the same checked-out plan branch in place with `git rebase --onto <integration-head> <recorded-base>`. Never merge integration into it. A conflict or interrupted rebase remains in that exact worktree and uses the next normal guided Implementer attempt when available; after attempt 5 it must pass through Judge before one-shot Saver eligibility. Never abort, reset, clean, or create another branch merely to recover cleanliness.
4. After restacking, require clean status, a merge-free unique range from the new integration base, and patch equivalence with the pre-restack checkpoint using `git cherry`. Record the new exact base, HEAD, tree, and commit list.
5. Run every plan done criterion and applicable project-wide gate in the plan worktree.
6. Measure the exact changed-path surface from recorded integration base to plan HEAD with Git name-status/name-only evidence: deduplicate changed paths and count each path once. Use the snapshot's numeric file budget, or the conservative legacy fallback. A rename counts once. Any changed path outside the declared scope or any file-count overflow stops before broad review and requires a user-authorized, validated narrower plan generation through Grill or Improve. It never authorizes Saver. Do not compute or enforce a changed-line ceiling; numstat or LOC may be reported descriptively but never gates the plan.
7. Dispatch the read-only reviewer against the complete diff from recorded integration base to plan HEAD. Record clean status and tree before dispatch; prove base, HEAD, tree, status, and assignment-bundle verification are unchanged afterward. Reviewer mutation is failure even when its verdict says `APPROVE`.

Do not add Herder metadata to a commit subject or body.

### Review acceptance and convergence

A finding relationship is one of:

- `PLAN_REQUIREMENT`: an evidence-complete failure of explicit plan behavior, acceptance, scope, or a required check;
- `PATCH_REGRESSION`: a P0/P1 regression introduced by the plan or latest repair delta, even when the affected behavior is outside the narrow feature area;
- `FOLLOWUP`: pre-existing or unrelated B/C work that the branch did not cause;
- `INVALID`: unsupported, speculative, duplicate, stylistic, or contradicted by evidence.

Only `PLAN_REQUIREMENT` and `PATCH_REGRESSION` may block. P0 is a universal release, security, data-loss, or operational emergency. P1 is an urgent functional regression or explicit acceptance failure. P2/P3, `FOLLOWUP`, and `INVALID` findings are advisory and never block integration, enter guided repair or Saver, or prevent `DONE`.

A blocker must identify an exact changed file and line, triggering scenario, reproducible evidence or failing check, introducing hunk or commit, and relationship to either the immutable original task or branch delta. Reject pre-existing defects, speculation, unstated intent, and reviewer preferences. Style, formatting, documentation nits, unrelated cleanup, and generated-file churn are advisory unless explicitly required or demonstrably P0/P1.

Maintain a monotonic finding ledger per plan generation. Assign each `NEW` finding the next stable ID (`F001`, `F002`, ...), deduplicate by root cause, and store severity, relationship, Judge disposition, first-seen reviewed SHA, file/cause, evidence, introducing diff, repair contract, leak dedupe key, and status (`OPEN`, `AUTHORIZED`, `RESOLVED`, `ADVISORY`, `DISMISSED`, `LEAKED`, or `NEEDS_INPUT`). Preserve IDs across restacks and resume.

Allow at most five substantive normal Implementation attempts per generation, and track review passes separately:

1. An `INITIAL` or `GUIDED_REPAIR` attempt that may have mutated the branch consumes one Implementation attempt even when its envelope is missing or it fails before review. A proven clean host interruption is free. A restack whose patch is unchanged consumes no attempt.
2. Every completed, gate-passing, file-scoped frozen branch receives a Reviewer pass followed by Judge. The first evidence-complete review in a generation uses `DISCOVERY` against the complete plan diff regardless of the Implementation attempt ordinal. This is the only broad review.
3. For Judge `REPAIR`, when an Implementation attempt remains, release the transaction-lane reservation and dispatch a fresh `plan_implementer` in `GUIDED_REPAIR` mode through the global pool on the same branch/worktree. Give it only the original compiled plan, Judge-authorized blocking IDs, direct evidence, and narrowed repair contracts. Suggested directions are non-binding; the plan and observable invariants remain authoritative. Its terminal branch queues to reacquire the lane for gates and targeted verification.
4. Rerun all gates and changed-path/file-count measurement. Every review pass after the first uses `VERIFICATION`: verify only open authorized blocker IDs and inspect only the new repair delta for regressions. Never reopen broad discovery. Diff line counts may be reported descriptively but never gate the plan.

If verification discovers a new evidence-complete `PATCH_REGRESSION` in the repair delta, add it to the ledger and let Judge decide whether it authorizes another guided attempt. Judge sends valid findings outside the original task and repair delta to `leak/` rather than sending Implementer toward B or C. If actionable in-scope blockers remain after attempt 5, Judge may select the one-shot Saver path. Never start a sixth normal Implementation attempt.

When attempt 5 ends without a reviewable frozen branch, dispatch Judge directly with the immutable task plus exact attempt, Git, gate, and failure evidence. This exhaustion adjudication is not a review pass and cannot create leak records without a Reviewer finding; it may authorize Saver only for an actionable in-scope failure or return `NEEDS_INPUT`/`BLOCKED`.

Normalize reviewer output only through Judge. A `REVISE` containing only P2/P3, `FOLLOWUP`, `INVALID`, dismissed, or non-qualifying findings becomes `DONE` when required gates and scope pass. Only a Judge-confirmed, evidence-complete `BLOCKING_IN_SCOPE` `PLAN_REQUIREMENT` or `PATCH_REGRESSION` authorizes repair; reserve Reviewer `BLOCK` and Judge `BLOCKED` for irreducible blockers.

### Reviewer prompt contract

Give the reviewer:

- its read-only role and prohibition on editing or spawning agents;
- the absolute plan worktree and branch;
- the absolute worktree-local assignment path and exact bundle SHA-256; require it to verify the hash and read the complete compiled plan from `planText`;
- exact integration-base, plan-HEAD, and tree SHAs;
- actual checks and compact results;
- numeric file budget and actual changed paths/file count; legacy line-count metadata is ignored;
- review mode, Implementation attempt number, review-pass number, remaining attempt count, and complete finding ledger;
- for verification, exact repair commit range and open blocker IDs;
- stable attempt ID and model/effort attribution;
- instructions to preserve IDs, apply the acceptance policy, treat its output as Judge evidence rather than repair authority, and summarize without log dumps;
- this exact response shape:

```text
VERDICT: APPROVE | REVISE | BLOCK
FINDINGS: <ordered `[<existing-id|NEW>][P0|P1|P2|P3][BLOCKING|ADVISORY][PLAN_REQUIREMENT|PATCH_REGRESSION|FOLLOWUP|INVALID] file:line — issue; scenario=...; evidence=...; introduced_by=...` entries, or none>
FIX_GUIDANCE: <one `[finding-id] observed=...; expected=...; reproduction=...; constraints=...; suggested_direction=...` entry per open blocker, or none>
SCOPE: PASS | FAIL
CHECKS: <independently verified commands/results>
RATIONALE: <concise>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

### Judge prompt contract

Judge is independent and read-only. Dispatch it after every Reviewer response, including `APPROVE`, and once at attempt-budget exhaustion when the last attempt cannot reach review. It classifies evidence rather than personalities. Give it the absolute worktree-local assignment path and exact bundle/snapshot hashes, exact base/HEAD/tree/status, current Implementation attempt, review-pass count, remaining five-attempt budget, file budget and actual changed paths/file count, all required gate evidence, the complete ledger, all completed attempt/review envelopes, latest repair delta, reviewer guidance when present, and whether the single Saver attempt remains. Require Judge to verify the local bundle before reading its compiled plan; never give it the source `plan_dir` as evidence. Tell Judge that LOC is nonbinding even when legacy plan text contains a changed-line limit.

Judge cannot override a failed required gate, explicit non-LOC done criterion, declared path/file-scope violation, or evidence-complete patch regression. It must ignore changed-line counts. It returns:

```text
DECISION: DONE | REPAIR | SAVER | NEEDS_INPUT | BLOCKED
FINDINGS: <ordered `[finding-id][BLOCKING_IN_SCOPE|NONBLOCKING_IN_SCOPE|DEFERRED_OUT_OF_SCOPE|REJECTED][PLAN_REQUIREMENT|PATCH_REGRESSION|FOLLOWUP|INVALID|NEEDS_INPUT] decision; evidence=...` entries, or none>
AUTHORIZED_BLOCKERS: <ordered finding IDs, or none>
REPAIR_CONTRACTS: <one `[finding-id] observed=...; expected=...; reproduction=...; constraints=...` entry per authorized blocker, or none>
LEAKS: <one `[finding-id] title=...; problem=...; evidence=...; acceptance=...; non_goals=...; dedupe_key=...` entry per deferred finding, or none>
QUESTION: <one focused question only for NEEDS_INPUT>
CHECKS: <independently verified commands/results>
RATIONALE: <concise original-task closure rationale>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

- `DONE`: normalize the original task to approval after coordinator gates; no authorized blocker remains.
- `REPAIR`: when an Implementation attempt remains, dispatch Implementer only with Judge-authorized IDs and narrowed repair contracts.
- `SAVER`: only after attempt 5, dispatch Saver when the original task remains incomplete, actionable Judge-authorized blockers remain, and its one substantive attempt is unused.
- `NEEDS_INPUT`: ask the one irreducible product/authority question, then redispatch Judge with the answer.
- `BLOCKED`: preserve the branch/worktree and report why no safe bounded repair exists.

For each Judge-classified `DEFERRED_OUT_OF_SCOPE` finding, the coordinator writes or deduplicates one concise, secret-free, non-executable draft under `<plan_dir>/leak/<source-plan-id>-<finding-id>-<slug>.md`. Include source plan/round, reviewer evidence, Judge rationale, severity, affected locations, dedupe key, proposed acceptance, non-goals, and status `PENDING`. Never add it to the index, dependency graph, current Fire run, or source branch. Report it after the original plan closes. The user may later promote, edit, dismiss, or reject it through Grill or Improve; only that producer allocates a numeric plan ID and validates it.

Integrate only after Judge `DONE`, effective scope `PASS`, all required checks pass, and no open Judge-authorized blocker remains. Immediately before advancing, require integration HEAD to equal the reviewed/judged base and the plan branch HEAD/tree/status to equal the approved values. Fast-forward the integration worktree with `git merge --ff-only <plan-branch>`; this must add no merge node. If integration moved, approval is invalid for advancement: checkpoint and restack the same plan branch, rerun required gates, Reviewer, and Judge against the unchanged patch without granting another discovery round.

After fast-forward, require integration HEAD to equal approved plan HEAD. Create `completion_ref(<id>)` with an absent-old-value guard, verify it is reachable, then transition the plan to `DONE`. If transition fails, stop dependency dispatch and reconcile from the private ref. After `DONE`, prove no agent can access the plan worktree, unlock it, and invoke cleanup with `--plan <id>`. Cleanup failure is a maintenance warning, not a rollback.

Any restack, gate, reviewer mutation/transport failure, Judge failure, or compare-and-advance failure leaves integration unchanged on the same plan branch/worktree. Retry proven read-only transport failures in the reserved lane without consuming an Implementation attempt; otherwise release the lane before dispatching the next normal Implementer attempt through the global pool with exact operational evidence. An evidence-complete Reviewer `REVISE` is not an operational failure: it always enters Judge gating above.

## 6. One-shot Recovery Implementation

Saver is an optional fresh recovery Implementer, not the default handler for failed work. While any of the five normal Implementation attempts remain, give ordinary implementation, restack, gate, dirty-state, or reconciliation failures to a fresh `plan_implementer` in `GUIDED_REPAIR` mode on the same branch/worktree with exact coordinator-proven evidence. That substantive mutation attempt consumes the next normal attempt and, when it reaches a frozen passing state, must be followed by Reviewer and Judge. Declared path/file-scope violations, missing authority, and containment failure are not Saver work; LOC is never relevant.

An **agent attempt** is one host spawn and always receives a unique usage row. A **substantive implementation attempt** is a result or failed attempt that may have mutated the worktree. A proven clean host interruption is free only when every no-mutation invariant below holds.

A **plan generation** starts with an immutable compiled plan snapshot, integration-base SHA, the stable plan branch prepared for fresh implementation, an empty finding ledger, zero substantive Implementation attempts, zero review passes, and one unused Saver attempt. Resume, repair, restack, clarification, and interruption never start a generation or reset either budget. Only a user-authorized, validated revision through Grill or Improve may checkpoint the old state and start a new generation.

Dispatch Saver only when all of these are true:

1. Five substantive normal Implementation attempts are exhausted.
2. The latest read-only Judge returns `SAVER` because the immutable original task is still incomplete.
3. At least one actionable `BLOCKING_IN_SCOPE` `PLAN_REQUIREMENT` or `PATCH_REGRESSION` remains with a narrowed repair contract.
4. No unresolved user input, external authority, declared path/file-scope violation, or containment failure prevents safe work.
5. The generation's one substantive Saver attempt is unused.

Never ask Saver to reconstruct failed work elsewhere. Release any transaction-lane reservation for that plan, then dispatch Saver through an available global pool slot in the exact plan worktree containing the current committed, dirty, conflicted, or interrupted state. Saver may overlap unrelated mutation attempts and another plan's single review transaction, but never another role on its own plan. Do not create a recovery branch. Before dispatch, record integration HEAD; plan branch HEAD and tree; exact porcelain status; generation and snapshot SHA-256; all five Implementation attempt outcomes; every completed review/Judge outcome; Saver attempt ordinal; and any rebase state. Never abort a rebase, reset, clean, stash, or discard to make recovery easier.

Give Saver only:

- the absolute plan worktree and branch;
- the absolute worktree-local assignment path and exact bundle/snapshot hashes; require it to verify the bundle before reading the immutable compiled plan;
- exact current Git, gate, and rebase evidence;
- compact summaries of all five normal attempts and every completed review/Judge outcome;
- only the latest Judge-authorized blocker IDs and narrowed repair contracts;
- explicit notice that this is the generation's single substantive recovery implementation;
- stable attempt ID and model/effort attribution;
- this exact response shape:

```text
OUTCOME: REPAIRED | NEEDS_INPUT | TERMINAL
COMMITS: <ordered SHAs, or none>
CHECKS: <command — result, one per line>
QUESTION: <one focused question only for NEEDS_INPUT>
EVIDENCE: <concise repository/tool evidence>
USAGE: input_tokens=<integer|unknown>; cached_input_tokens=<integer|unknown>; output_tokens=<integer|unknown>; reasoning_tokens=<integer|unknown>; source=<host source|unknown>
```

Pass direct evidence, not theories or raw gate logs. Never pass `NONBLOCKING_IN_SCOPE`, `DEFERRED_OUT_OF_SCOPE`, `REJECTED`, P2/P3, `FOLLOWUP`, or `INVALID` findings. Tell Saver to repair supplied blockers first and broaden only when direct evidence proves a systemic cause. Saver never replans, self-approves, or receives another substantive attempt in the same generation.

### Host interruption

Classify `INTERRUPTED` only when host evidence proves platform, policy, transport, or session failure rather than repository failure; no parseable final envelope exists; integration HEAD and plan HEAD/tree exactly match pre-dispatch; and the worktree was clean before and remains clean including untracked files. Unknown or false conditions consume the relevant substantive budget and preserve exact state.

For a proven interruption, record exact usage, consume no substantive or clarification budget, verify the preserved assignment bundle, and use a fresh session/attempt ID with the same self-contained task and worktree-local assignment reference. Never resume the interrupted child conversation.

- For transient capacity, do not increment any retry, interruption, clarification, implementation, or Saver bound. Use fresh sessions after 30 seconds, 60 seconds, 120 seconds, and 300 seconds, capped at 300 seconds. Never infer capacity from quiet, timeout, disconnect, or missing response. If cancellation, deadline, or host lifecycle stops waiting, transition to `BLOCKED — infrastructure capacity unavailable; recovery budget preserved` and retain the same branch/worktree.
- For explicitly non-retryable infrastructure, transition immediately to the same infrastructure `BLOCKED` state without consuming substantive recovery.
- For other host interruption, allow at most two same-attempt non-capacity interruption restarts, then block with the infrastructure or policy reason while preserving any unused substantive budget.

Handle Saver outcomes:

- `REPAIRED`: consume the one Saver attempt, record its commits/delta, and queue the branch to reacquire the transaction lane. When acquired, rerun all gates and review-surface measurement, then run one targeted `VERIFICATION` Reviewer and Judge pass over the authorized IDs plus only the Saver delta. Never reopen broad discovery. Judge may return `DONE`, record leaks, request one irreducible input, or `BLOCKED`; it may not authorize another normal repair or Saver attempt.
- `NEEDS_INPUT`: accept only when pre/post Git evidence proves no mutation. Ask one irreducible question and redispatch the same one-shot recovery with the answer; allow one clarification cycle. Mutation or a second question consumes the attempt and transitions to `BLOCKED`.
- `TERMINAL`, malformed output, or a failure that may have mutated the worktree consumes the one Saver attempt and transitions to `BLOCKED` with exact evidence.

An explicit resume does not replenish the five normal Implementation attempts or the Saver attempt. Preserve the single branch/worktree and report the exhausted bound. Further autonomous work requires a user-authorized revised plan and new generation.

## 7. Usage Accounting

The root coordinator is the only usage-ledger writer. After every terminal attempt, call `record-usage` before the next lifecycle action. Continue ordinals across resume and new invocations for the same plan directory. Use plan `RUN` for final-audit attempts. Record normalized outcomes including `INTERRUPTED`.

Prefer host-reported effective routing and structured usage. On native Codex, after terminal state run `node <codex_evidence_reader> --agent <canonical-task-name> --pretty`; require matching role and `multiAgentVersion: v2`. Use terminal fields plus native state; `taskComplete` alone is insufficient. For Orca, require the runtime-profile hash, effective routing, worktree identity, task/dispatch/pane provenance, and before/after Git proofs in `orca-runtime.md`. Copy exact host usage when uniquely attributable, otherwise record all fields/source as `unknown`. Never tokenize transcripts, subtract coordinator totals, trust model-written estimates, or infer reasoning.

The same native Codex evidence must show `mutationEvidenceComplete: true`, `unresolvedApplyPatchCalls: 0`, every recorded `executionWorkdirs` entry inside the exact assigned worktree, and every canonical `applyPatchPaths` entry inside it. A Reviewer or Judge must additionally report `applyPatchCalls: 0`. Orca non-Codex children do not claim transcript-equivalent patch evidence; require exact worktree identity and coordinator Git/checkout-guard proofs instead. Missing or escaped required evidence is a containment failure even if Git currently looks clean: record usage, stop integration and further dispatch, retain exact evidence, run the checkout guard, and report the breach without attempting to repair the user's checkout through Saver.

Use `plan_manager usage` for reporting. Always report coverage beside known subtotals; the ledger excludes unobservable coordinator/platform overhead.

## 8. Resume Semantics

Run namespace preflight in `resume` mode, then reconstruct from Plans status, `base_ref`, completion/checkpoint refs, the exact integration/plan branches, recorded assignment paths and bundle hashes, worktree leases/status/rebase state, persisted child evidence, gate evidence, reviewer envelopes, finding IDs, and usage rows. Conversation history is never a dependency; every replacement child receives a fresh self-contained task plus the verified worktree-local assignment reference.

Reconstruct `scheduler_state`; never store it as a second source of truth. Count every proven-live role attempt against `parallel_limit`, preserve its one-plan owner lease, and treat a proven-live Reviewer or Judge as holding the transaction-lane reservation. A crashed coordinator-only lane phase holds no durable reservation: queue its unchanged branch to reacquire the lane and rerun the exact gates. If role ownership or lane ownership is ambiguous, preserve the affected plan and stop it rather than risk duplicate work.

Before classifying or redispatching any retained plan branch, verify its assignment bundle against the originally recorded bundle SHA-256. Do not derive a new trusted hash from the file itself and do not rebuild it from the possibly changed source plan. If the original hash cannot be reconstructed uniquely from persisted coordinator/dispatch evidence, or if the file is missing or mismatched, preserve the worktree and stop that plan for reconciliation.

Treat locks as leases. On native Codex, run `node <codex_evidence_reader> --workdir <absolute-worktree> --pretty` and correlate the structured lock reason with persisted child evidence. On Orca, reacquire runtime-scoped terminal handles by recorded worktree identity and correlate the lock with persisted task/dispatch/pane evidence. If owner is active, keep the lease and let the owning coordinator wait; a fresh coordinator must not dispatch competition. If terminal with a parseable envelope, record usage and continue. If interrupted with proven clean unchanged state, record `INTERRUPTED` and use a fresh agent. If ownership remains ambiguous, preserve the lock and stop that plan.

Classify each retained plan branch:

- Dirty, conflicted, or rebasing with no active owner: preserve exact worktree. If a normal Implementation attempt remains, dispatch a fresh Implementer there with the exact operational envelope; otherwise dispatch Judge and use Saver only when Section 6 eligibility is proven. Never abort or replace it.
- Clean with merge-free unique commits not yet completed: reconstruct its base/checkpoint, then restack if needed, gate, and review.
- Clean with no unique commits and `IN PROGRESS`: dispatch a fresh implementer only when evidence proves no prior mutation was lost; otherwise stop for reconciliation.
- `BLOCKED`: reconstruct the round ledger and latest Judge outcome on the existing plan branch. Resume a normal guided Implementer only when its budget remains; dispatch Saver only for a round-5 Judge `SAVER` with an unused attempt. If the branch is absent, create it only when the ledger and evidence prove no failed work existed; otherwise stop.
- Valid completion ref reachable from integration: reconcile `DONE` before dependencies. `DONE` without proof or with failed cheap verification transitions to `BLOCKED` and recovery.

Reconstruct execution state from Implementer attempt envelopes, separate Reviewer/Judge envelopes, and exact reviewed base/HEAD/tree. Resume or restack never resets the Implementation attempt count, review-pass count, Saver eligibility, or ledger. If reconstruction is ambiguous, treat all five normal attempts and the Saver attempt as exhausted, preserve state, and dispatch Judge only for read-only closure classification. Continue all ordinals and never rewrite usage.

A crash may occur after the integration fast-forward but before the completion ref is written. Recover only when evidence proves exact plan HEAD/tree received effective approval, every gate passed, no mutation followed, and that exact commit is current/reachable integration. Then create the missing ref with absent-old-value guard and reconcile `DONE`. Never infer approval merely because an unmarked commit is present on integration.

## 9. Completion

The plan set succeeds when every plan is `DONE` or `REJECTED`, every dependency completion ref is reachable from integration, final project-wide gates pass, and the final reviewer ledger has no qualifying cross-plan blocker. P2/P3 findings remain advisory.

The final audit checks only cross-plan dependency guarantees, combined migrations/public contracts, plan-set scope, and project-wide gates. It must not broadly rereview every already-approved local hunk. Give each final Reviewer, Judge, Implementer, or Saver the verified integration-worktree RUN assignment path and exact bundle hash; it reads the ordered compiled snapshots under `plans[]` and never reads the source backlog. Apply the same five-attempt Implementation budget, one initial bounded discovery on the first reviewable result, targeted verification on later review passes, and Judge gating after every review to genuine cross-plan blockers. After five normal attempts, one Judge-authorized final Saver attempt may operate directly in the isolated integration worktree to avoid another branch: first create a unique `checkpoints/RUN/<ordinal>` ref for integration HEAD and stop all plan dispatch. Treat added repair commits as unapproved until all final gates and one targeted Reviewer/Judge pass succeed. If interruption leaves dirty or unapproved integration state, preserve and resume that exact worktree; never hand it off. Only final Judge-approved integration may be reported as complete.

After successful final gates/audit, verify the checkout state token, prove no agent can access a plan worktree, and invoke fail-closed `--finalize`. Finalization removes every eligible plan branch/worktree, re-inventories the namespace, and deletes recognized private coordination refs only when no plan branch remains. Dirty, locked, missing, unrecognized, nonterminal, or unverifiable state preserves refs and reports a maintenance warning without rolling back approved integration.

Never merge, push, publish, or deploy. Report integration branch/worktree, final SHA, plan outcomes, checks and compact log evidence, usage/coverage, advisory/adjudication findings, and preserved branches.

Fire never merges into the user's branch. When the intended target still points to `base_ref`, report `git merge --ff-only herder/<plan-name>/integration`. If it moved, report that fast-forward is unavailable and require a fresh replay/review cycle on the new target. Never recommend a non-fast-forward merge or rebasing the user's branch to force handoff.

After the user fast-forwards, report `herder:fire cleanup <plan-dir> [--plan-name <name>] --finalize --handoff-target <target-branch> --runtime <run-runtime>`. It never performs the merge. It removes integration only after proving the named target contains integration and the integration worktree is clean, unlocked, present, and not the user checkout.

## 10. Cleanup

Cleanup is coordinator-only. Invoke:

```text
node <cleanup_runner> --repo <repo_root> --plan-dir <plan_dir> [--plan-name <name>] [--plan <id>] [--dry-run] [--include-failed] [--finalize] [--handoff-target <branch>] --runtime native|orca --pretty
```

The runner derives the exact integration branch from the validated plan name. `--finalize` cannot combine with `--plan`; `--handoff-target` requires `--finalize`. Before mutation, prove no active or ambiguous agent can access targeted worktrees. Dry run never unlocks. Use the run's original runtime: native removal uses Git; Orca removal first verifies Orca ownership, removes through `orca worktree rm`, and then verifies Git worktree and branch state.

The runner recognizes only `herder/<plan-name>/<indexed-id>` plan branches plus exact integration. By default, a plan branch is eligible only when status is `DONE`, its completion proof is reachable, and its worktree is clean/unlocked. Delete worktree first, then branch with its preflight SHA as expected old value. Preserve clean non-`DONE` branches unless the user explicitly supplied `--include-failed` while the run is stopped; that flag never overrides dirty, locked, missing, unknown, integration, logs, plans, or user-checkout protection.

Finalization additionally requires every plan terminal, every `DONE` proof reachable, every private ref recognized, and every plan branch removable. Remove plan branches/worktrees, re-list, then delete private refs with exact expected targets. Preserve integration, logs, plans, and all refs whenever any prerequisite fails. An already-finalized plan set with all plans terminal, no plan branches, and no private refs is idempotently complete; later resume reruns final gates without recreating workers.

For `--finalize --handoff-target`, require integration HEAD to be an ancestor of the local target immediately before deletion. Remove a clean distinct integration worktree first, then delete its exact branch with preflight SHA. Any failed proof or concurrent move preserves changed state.

Report every planned/removed item and every preservation reason. Never ask a worker to clean Git state.
