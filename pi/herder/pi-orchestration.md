# Native Pi Adapter

Pi uses the same deterministic Herder Run Manager as Codex and Claude Code. The extension is a host transport adapter, not a scheduler.

## Process and dashboard

Every `/herder-fire` or `/herder-resume` call checks the authenticated service identity stored in the plan directory's existing SQLite database. It reuses a healthy process or starts a detached replacement. The service starts the loopback read-only dashboard on an ephemeral port and requests the available VS Code or Orca host integration.

The service can disappear without losing run authority. A replacement reconstructs state from SQLite, README lifecycle, exact Git refs/branches/worktrees/leases, and immutable assignments. Pi session entries are UI hints only.

## Worker transport

The manager returns a batch of exact actions. For each action, the extension starts one background `pi-subagents` run with:

- the exact profile-selected role agent, model, and thinking level;
- `context: "fresh"`;
- the manager-owned stable worktree as `cwd`;
- the complete manager prompt and immutable assignment evidence; and
- no managed temporary worktree, project-scoped debug artifacts, or auto-created mission files.

The extension immediately returns action IDs and opaque `pi-subagents` run IDs to the manager as one dispatch-results event. It maps completion events back by those IDs, extracts the exact child result instead of display summaries, records direct async token/timing evidence when available, and sends one terminal event. The manager applies gates, review policy, accounting, integration, and immediate role-agnostic slot backfill before returning the next batch.

Worker agents never spawn nested agents. `pi-subagents` is installed separately and remains responsible only for model-session transport.

## Concurrency and recovery

`maxParallel` is the complete Implementer/Reviewer/Judge pool. No control slot is reserved. Reviews and judgments for one plan may overlap implementation on another; only integration is serialized in the manager service.

On Pi session restart, the extension reloads the manager run ID, calls the service status endpoint, and reconstructs child-run mappings from durable action host handles. A stale completion that does not match an active action ID and host handle is ignored. Unknown ownership pauses rather than dispatching a competing worker.

Stopping Herder asks Pi to stop active child runs first, then marks the manager run stopped while preserving repository evidence. The service and dashboard may remain available for status until explicitly shut down.
