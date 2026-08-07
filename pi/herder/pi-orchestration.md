# Native Pi orchestration overlay

This document replaces only the root-dispatch/Accountant split in Herder's canonical orchestration protocol. The controller must read that canonical protocol completely. All invariants not explicitly replaced here remain binding.

## Ownership

The `herder.plan-accountant` Pi child is the sole controller for one Fire operation. It combines the old root's host-dispatch responsibility with the Accountant's deterministic control-plane responsibility.

- It invokes Herder's existing Plans, namespace, checkout, assignment, gate, round-policy, cleanup, and Git operations directly.
- It directly launches, waits for, inspects, steers, and stops its own Pi worker children through `pi-subagents`.
- It never returns `ACTIONS` for the outer Pi session to execute and never asks the outer session to run Git or accounting commands.
- It never edits repository source. Only an assigned Implementer or legacy Saver may mutate a plan worktree.
- The outer Pi extension owns only launch/resume/stop controls, status projection, dashboard lifetime, and user-visible notification.

The Plans database remains the sole attempt-accounting store. Do not add a scheduler database, journal, YAML file, or README attempt table. Pi and `pi-subagents` lifecycle files are transport evidence, not plan truth.

## Profile binding

Resolve the selected profile for host `pi` before repository mutation. Bind `host=pi`, the exact profile SHA-256, and the exact five-role mapping through the existing Plans manager. On resume, require the stored binding to match byte-for-byte.

The package-scoped Pi role identifiers are:

```text
plan-accountant  -> herder.plan-accountant
plan-implementer -> herder.plan-implementer
plan-reviewer    -> herder.plan-reviewer
plan-judge       -> herder.plan-judge
plan-saver       -> herder.plan-saver
```

The extension preflights the controller and all worker models before launch. Use the exact `model` and `effort` supplied in the task for every worker. Pi calls effort `thinking`. Do not substitute a model or role after a launch failure. Pi has no public per-child service-tier override in the `pi-subagents` workflow contract; preserve any catalog service tier in accounting metadata but do not claim it was applied by Pi.

## Worker pool

`MAX_PARALLEL` is the exact maximum number of active Implementer, Reviewer, Judge, and legacy Saver children. The controller itself is outside this nested worker count. There is no inferred host-child-capacity subtraction in Pi mode.

Maintain one rolling, role-agnostic pool:

1. Reconcile every terminal child and all immediately eligible gates, review transitions, restacks, and integrations.
2. Determine every eligible next role across plans.
3. Launch in deterministic plan/round/role order until `active_workers == MAX_PARALLEL` or no work is eligible.
4. If workers remain active, call `subagent_wait` without `all:true`. It returns on the first completion or attention event.
5. Reconcile that event and immediately backfill the freed slot. Never wait for an implementation or review wave to drain.

Each plan still has one stable branch/worktree and at most one active role. Integration is still the only cross-plan lock.

## Launching a worker

Launch each worker as its own background `workflowScript`, never as one `runs.all` wave. The shape is:

```text
subagent {
  async: true,
  workflowScript: return runs.run(<stable-attempt-key>, {
    agent: <exact package-scoped role>,
    task: <complete immutable worker message>,
    cwd: <exact stable plan worktree>,
    context: "fresh",
    model: <profile model>,
    thinking: <profile effort>,
    acceptance: false
  })
}
```

Retain the returned async run ID with the durable Herder attempt identity. A host rejection before a run ID exists consumes no attempt or round and releases the prepared lease. A child that may have mutated consumes its round according to the canonical protocol.

Every worker task must include:

- the exact worktree, branch, base/head/tree, plan, round, mode, and review state required by the canonical protocol;
- the immutable assignment path and SHA-256;
- the exact existing role contract path from `ROLE_CONTRACT_PATHS`;
- required gates and compact evidence;
- the selected role/model/thinking identity;
- the exact expected response envelope.

Never use `pi-subagents` managed temporary worktrees. Herder's stable branch/worktree and assignment verification remain authoritative.

## Terminal evidence and recovery

Use `subagent_wait` for event-driven first-completion waits. Use `subagent` status/transcript inspection only for the exact run being reconciled or when it needs attention. Treat quiet, long-running workers as normal.

Every returned async run ID is opaque. Store and reuse the entire string byte-for-byte, including separators such as `|`; never parse out a tool-call ID, provider response ID, suffix, or prefix. A `subagent_wait` completion notification does not replace the retained ID. Use that exact full ID for status, transcript, steer, and stop operations.

For each terminal child, retain its run ID, child session path when reported, model, thinking, usage, duration, result, and terminal state. Reconcile those facts with the worktree lease, assignment hash, Git state, gates, and expected response before recording usage or advancing a round. Never infer success solely from child prose.

On controller restart, reconstruct from Plans state, refs, branches, stable worktrees, locks, assignments, and `pi-subagents` run artifacts. Conversation history and the outer extension's session entry are locators only. Ownerless interrupted work follows the canonical recovery rules.

## User input and completion

When a child requests attention, inspect its exact request. If the answer is already authorized by the plan or protocol, respond narrowly. For irreducible product authority, contact the outer supervisor when the tool is available. If it is unavailable, preserve all state and finish with `NEEDS_INPUT` plus one exact question; the user can resume the controller after answering.

Do not finish while a worker is active or an eligible control-plane transition remains. At terminal completion, run the canonical final gates, RUN review/audit, reporting, and handoff checks. Return a compact report containing terminal plan counts, integration commit, required handoff, usage coverage/totals, elapsed time, dashboard plan directory, and any residual blockers.
