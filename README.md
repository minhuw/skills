# Herder

Herder is a task orchestrator engine for Pi, Claude Code, and Codex. It shapes objectives into focused semantically bounded plan graphs, executes independent six-round implementation/review loops, and uses an independent Judge to filter unresolved findings from round three onward. One shared deterministic TypeScript Run Manager owns scheduling, SQLite accounting and reports, lifecycle transitions, gates, Git transactions, and integration across all three harnesses. Its persistent local service automatically hosts the read-only graph dashboard and reconstructs state from SQLite and Git after a session or process restart.

## Pi

Install the orchestration runtime once, then install Herder as a native Pi package rather than a skill:

```sh
pi install npm:pi-subagents
pi install git:github.com/minhuw/skills
```

For development, install this checkout directly with `pi install /absolute/path/to/skills`. Start Pi with the selected profile's root model and thinking level, then launch Herder:

```text
pi --model <provider>/gpt-5.6-sol --thinking max
/herder-fire herder-plans --profile eclipse
```

Herder does not vendor or install `pi-subagents`; the first command above installs the shared runtime independently. Herder registers package-scoped role agents and provides `/herder-fire`, `/herder-resume`, `/herder-status`, `/herder-dashboard`, and `/herder-stop` plus the model-callable `herder` tool. At launch it verifies the runtime's public RPC contract and reports the installation command if the runtime is absent. Fire starts or reuses the SQLite-discovered Run Manager service, launches the dashboard on an available port, and keeps independent Implementer → Reviewer pipelines full up to `--max-parallel` (default 5).

Pi uses one generic agent definition per Herder role. A profile supplies each launch's exact model and thinking level, so adding profiles does not multiply agent files. Herder validates the active root model, every child model, and its own package-agent metadata; the independently installed runtime validates its RPC protocol and launch execution before repository mutation.

## Claude Code

```sh
claude plugin marketplace add minhuw/skills
claude plugin install herder@herder
```

Start a new Claude Code session (or run `/reload-plugins`), then run `/herder:install` to verify the bundled Herder agents. Fire uses Claude only for worker transport; if addressable agent IDs or `SendMessage` are unavailable, start Claude Code with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

## Codex

```sh
codex plugin marketplace add minhuw/skills
codex plugin add herder@herder
```

Start a new Codex session and run `$herder:install`. Follow any printed Multi-Agent V2 setup instructions; if profiles or configuration change, start one more new session before using `$herder:fire`. The default pool uses five worker threads directly; the external Run Manager consumes no Codex child slot.

## Native role profiles

Install registers every bundled profile. Fire selects a named profile with `--profile`; without it, Codex and Pi use `eclipse`, while Claude uses `shannon`.

| Profile | Root orchestrator | Implementer | Reviewer | Judge |
|---|---|---|---|---|
| `eclipse` | GPT-5.6 Sol, max | GPT-5.6 Luna, max, Fast | GPT-5.6 Sol, xhigh | GPT-5.6 Sol, xhigh |
| `shannon` | Claude Opus 4.8, high | Claude Opus 4.8, high | Claude Opus 4.8, xhigh | Claude Opus 4.8, xhigh |
| `offcut` | Kimi K3 (`kimi-k3`), max | Grok 4.5, high | GPT-5.6 Sol, xhigh | GPT-5.6 Sol, xhigh |

All three profiles are available in Pi because Pi resolves their model identifiers through its active model registry. `eclipse` and `offcut` are available on Codex and Claude Code; `shannon` is Claude-only outside Pi. A profile declares the required root-orchestrator model and exact worker roles. Select the root model when launching Pi, Codex, or Claude Code; `--profile` validates the requirement but cannot replace the model of an already-running session.

```text
$herder:fire herder-plans --profile offcut
```

Herder validates profile structure and exact agent identifiers but does not query model catalogs or make token-consuming availability probes. If the host rejects a real dispatch before returning a worker handle, Herder reports the exact profile/role/model failure, releases the lease, consumes no attempt or round, and never substitutes another model.

## Observe a run

Every new Fire run starts the loopback dashboard on the same port as its persistent manager service and returns the effective URL. Use `$herder:dashboard herder-plans` to reconnect. The graph shows dependencies, exact manager phases, implementation/review rounds, worker leases, token coverage, completion evidence, and the integration lane. VS Code Remote uses its managed port-forwarding path. The dashboard polls every two seconds and is read-only by construction: it accepts only GET/HEAD and projects runtime state from SQLite plus Git evidence.
