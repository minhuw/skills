# Deterministic Herder Run Manager Protocol

This protocol governs new native Fire runs on Codex, Claude Code, and Pi. The TypeScript Run Manager is the exclusive mutating control-plane owner. The harness root is a transport adapter; workers are semantic Implementer, Reviewer, and Judge roles.

## 1. Durable authority

The manager process is replaceable. Durable authority is reconstructed from:

1. the immutable plan specification compiled into `.herder/execution.sqlite3` at fresh start;
2. SQLite manager runs, typed plan phases, idempotent events/actions, parsed worker results, profile binding, attempts, usage, and service identity;
3. exact Git branches, stable worktrees, leases, base/completion/checkpoint refs, commits, and trees; and
4. immutable worktree-local assignment bundles and SHA-256 evidence.

`README.md` lifecycle cells are an idempotent human-readable projection of SQLite. They are never read back as scheduler authority after initial compilation.

The process owns no authoritative in-memory queue. A healthy service is identified by its random instance ID, PID, loopback port, bearer token, and authenticated `/health` response matching the SQLite row. PID liveness alone is insufficient. A replacement process may overwrite only a stale service row and must read the run before accepting an event.

## 2. Fresh start

Before repository mutation the manager:

1. validates the complete plan graph and shape;
2. resolves the exact host profile and binds its immutable name/hash/roles in SQLite;
3. captures the byte-sensitive user-checkout token excluding only the plan directory;
4. requires an unused `herder/<plan-name>/` branch and `refs/plan-herder/<plan-name>/` namespace;
5. creates one integration branch/worktree at the user's current HEAD and one immutable base ref;
6. materializes the ignored read-only RUN assignment; and
7. records the run before returning any worker action.

Each ready plan is forked from canonical integration HEAD into exactly `herder/<plan-name>/<id>` at the stable worktree path. The manager materializes one ignored read-only assignment bundle, transitions the plan to `IN PROGRESS`, acquires an action-specific Git worktree lease, and returns an Implementer action.

For a fresh Codex run, stable worktrees are registered beneath the ignored `<plan-dir>/.herder/worktrees/<plan-name>/` root. Codex's native spawn API does not accept a child cwd, and its patch tool is confined to the coordinator project; the contained root lets the child use absolute worktree paths without granting access outside the project. Claude Code and Pi retain the sibling `<repo>-herder-worktrees/<plan-name>/` root. Resume always preserves the exact recorded root and rejects any other location.

## 3. Action identity and transport

An action is identified semantically by run, plan, generation, round, role, and ordinal. It includes exact role identifier, declared model/effort/tier evidence, worker mode, worktree, branch, assignment path/hash, lease, task name, and complete prompt. The prompt is deterministically reconstructed and not stored in SQLite.

The adapter must return exactly one dispatch result per proposed action. A rejection before a host handle exists cancels the proposal, releases its unused lease, and records no attempt. Only an explicit host-capacity rejection may be retried without pausing. There is no model or role fallback.

Accepted actions become `dispatched` with their real host handle. Only a terminal event containing the same action ID and, when available, matching handle may close it. For Codex, the adapter must resolve that exact handle through `read-codex-agent-evidence.mjs` after `task_complete` and attach its verified native token and timing object; the worker envelope is not accounting evidence. Duplicate event IDs with byte-equivalent canonical payload are idempotent; a different payload under the same ID stops.

## 4. Plan loop

The manager fills every available global worker slot across independent plans and roles:

```text
Implementer -> manager gates -> Reviewer -> integrate
                              \-> repair Implementer (rounds 1-2)
                              \-> Judge -> repair Implementer (rounds 3-6)
```

An Implementer must leave an attached expected branch, immutable assignment, clean worktree, at least one commit beyond generation base, and passing manager-run gates. A failure consumes the substantive round when mutation may have occurred. Proven clean host interruption records an attempt but does not consume a round.

The first evidence-complete review is broad `DISCOVERY`; later reviews are targeted `VERIFICATION`. Only evidence-complete P0/P1 `PLAN_REQUIREMENT` or `PATCH_REGRESSION` findings block. P2/P3, follow-up, invalid, and unrelated findings remain advisory. `APPROVE` with scope pass and no blockers is integration-ready in any round. `REVISE` in rounds 1-2 directly authorizes the next bounded repair. Beginning at unresolved round 3, Judge filters findings before another repair.

Reviewer and Judge may not mutate. The manager compares frozen branch HEAD, tree, status, assignment, and user checkout around their action.

## 5. Integration

Only the manager integrates, one plan at a time. It freezes approved base/HEAD/tree. If base equals integration HEAD, it fast-forwards. If stale, it creates an immutable checkpoint, rebases the same plan branch/worktree onto current integration, proves patch equivalence, reruns gates, and then fast-forwards.

A conflicted restack remains preserved in place and advances to a GUIDED_REPAIR Implementer when a round remains. Detached HEAD is never generally accepted. Before dispatch, the manager acquires the exact action lease and explicitly invokes `inspect-active-rebase`, then `verify --verification-mode active-rebase` with the captured state hash and its recorded worktree, branch, assignment hash, checkpoint ref/target, rebase `onto`, original head, detached HEAD, and lease. Any mismatch fails closed and releases the unused lease. The worker may resolve only that sealed conflict and complete `git rebase --continue`; its terminal result must pass ordinary attached-branch assignment verification again.

After integration, the manager creates the absent exact completion ref, proves reachability, and transitions the plan to `DONE`. Newly dependency-ready plans may then start immediately. Other workers continue while one integration transaction runs.

## 6. Completion and recovery

When every plan is terminal and no worker is active, the manager schedules one read-only RUN Reviewer over the immutable run assignment, integrated tree, dependency guarantees, combined public transitions, and project-wide gates. Approval marks the run complete. A final blocker becomes `needs_input` or failed evidence; it does not silently reopen arbitrary implementation. Completion reporting and dashboard phases are projected from the same SQLite plan specification, phases, attempts, and timing records, never inferred from conversation history or leases.

On process restart, the service reloads the same database, proposed/dispatched actions, and Git leases. The host adapter restores known handles from its own session state; unknown ownership preserves the action for explicit host reconciliation rather than dispatching a competitor. Conversation history is never recovery authority.

The manager keeps the dashboard alive with the service so status remains visible while root sessions change. The dashboard remains loopback-only and read-only.
