---
name: dashboard
description: Launch and inspect a read-only local web dashboard for a validated Herder plan backlog or active Fire run. Use when the user asks for a live progress UI, dependency graph, implementation-review pipeline view, attempt statistics, integration status, or finished-run report. Do not use it to mutate lifecycle, schedule workers, integrate branches, or replace Fire status automation.
---

# Herder Dashboard

Observe one Herder plan set through a loopback-only web interface. New Fire runs serve this dashboard and the authenticated manager API from one persistent process and port; use this skill to reconnect, inspect a snapshot, or launch a standalone pre-run observer. During a run, the dashboard projects exact SQLite phases and accounting plus Git branches/worktrees/private completion refs. It exposes no write endpoint.

## Invocation

Codex uses `$herder:dashboard ...`; Claude Code uses `/herder:dashboard ...`.

```text
herder:dashboard [<plan-dir>] [--plan-name <name>] [--port <0..65535>] [--no-host-integration]
herder:dashboard snapshot [<plan-dir>] [--plan-name <name>]
```

- Default plan directory: `herder-plans/`.
- Default plan-set name: the Git-safe basename of the resolved plan directory. Pass `--plan-name` when Fire used another namespace.
- Default port: `4173`. If occupied, use `--port 0` and report the selected URL printed by the server.
- `snapshot` prints the exact JSON model once and exits without starting a server.
- Host integration is automatic. A VS Code terminal asks `code --open-url` to open the service; VS Code Remote owns the authenticated port-forwarding tunnel. Use `--no-host-integration` to keep only the printed loopback URL.

## Launch

Resolve `<skill-dir>` to this `SKILL.md`'s directory. For the web dashboard, start this command in a persistent terminal or PTY:

```bash
node <skill-dir>/scripts/herder-dashboard.mjs --plan-dir <plan-dir> [--plan-name <name>] [--port <port>]
```

Wait for `URL: http://127.0.0.1:<port>/` and report the effective URL. In VS Code, the launcher requests the host-native browser/forwarding path itself; do not open a duplicate tab unless that integration reports a failure. Keep the terminal alive while the user observes the run. Stop it with Ctrl+C when requested or when the observing session is over.

For a one-time machine-readable snapshot, run:

```bash
node <skill-dir>/scripts/herder-dashboard.mjs --snapshot --pretty --plan-dir <plan-dir> [--plan-name <name>]
```

Report validation errors exactly. If the plan directory is missing, direct planning work to Grill or `herder:plans init`; do not synthesize dashboard state.

## Observer contract

- Bind only to `127.0.0.1`. Never create a custom proxy or public tunnel, publish the service, or change the host binding.
- Host-native access must remain private: VS Code owns its authenticated forwarding tunnel. Never change forwarded-port visibility or start a public tunnel. Permit only the exact VS Code proxy hostname derived from `VSCODE_PROXY_URI`; retain DNS-rebinding rejection for every other Host value.
- Keep the dashboard read-only. It permits only GET and HEAD, polls every two seconds, and never invokes the Run Manager mutation API or any worker.
- Do not add lifecycle controls, scheduling controls, Git actions, SQL writes, another state file, or a second plan parser.
- During a run, treat the SQLite plan specification and phases as lifecycle truth, README as a projection, and Git refs/worktrees as execution and integration evidence.
- Paths and worker metadata are local operational data. Do not expose the dashboard beyond the loopback interface.
- Use `$herder:fire status` when the user needs the Run Manager's durable control-plane state; the dashboard is an observer, not a controller.

The graph view supports active, attention, and finished filters. Selecting a plan shows its dependency state, current worktree lease, attempts grouped by round, model/tier/timing metadata, and token coverage. The integration section is derived from the same snapshot.
