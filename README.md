# Herder

Herder is a task orchestrator engine for Claude Code and Codex. It shapes objectives into focused semantically bounded plan graphs, executes independent six-round implementation/review loops, and uses an independent Judge to filter unresolved findings from round three onward. One persistent Accountant owns scheduling, SQLite attempt accounting and rich run reports, lifecycle transitions, gates, Git transactions, and integration while the root only dispatches and waits for workers. A read-only local dashboard visualizes dependency pipelines and execution evidence, and the optional Orca runtime can route plan workers across different CLI harnesses while preserving one plan, review, and integration protocol.

## Claude Code

```sh
claude plugin marketplace add minhuw/skills
claude plugin install herder@herder
```

Start a new Claude Code session (or run `/reload-plugins`), then run `/herder:install` to verify the bundled Herder agents. Fire requires an addressable persistent Accountant; if `SendMessage` is unavailable, start Claude Code with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

## Codex

```sh
codex plugin marketplace add minhuw/skills
codex plugin add herder@herder
```

Start a new Codex session and run `$herder:install`. Follow any printed Multi-Agent V2 setup instructions; if profiles or configuration change, start one more new session before using `$herder:fire`. The default five-plan-worker pool reserves one additional child thread for its selected persistent Accountant, so configure at least six concurrent child threads.

## Native role profiles

Install registers every bundled profile and keeps the historical unqualified roles only for old-run resume compatibility. Fire selects a named profile with `--profile`; without it, Codex uses `eclipse` and Claude uses `shannon`.

| Profile | Root orchestrator | Accountant | Implementer | Reviewer | Judge | Saver |
|---|---|---|---|---|---|---|
| `eclipse` | GPT-5.6 Sol, max | GPT-5.6 Luna, max, Fast | GPT-5.6 Luna, max, Fast | GPT-5.6 Sol, xhigh | GPT-5.6 Sol, xhigh | GPT-5.6 Sol, xhigh |
| `shannon` | Claude Opus 4.8, high | Claude Opus 4.8, medium | Claude Opus 4.8, high | Claude Opus 4.8, xhigh | Claude Opus 4.8, xhigh | Claude Opus 4.8, xhigh |
| `offcut` | Kimi K3 (`kimi-k3`), max | Grok 4.5, max | Grok 4.5, high | GPT-5.6 Sol, xhigh | GPT-5.6 Sol, xhigh | GPT-5.6 Sol, max |

`eclipse` and `offcut` are available on both native hosts; `shannon` is Claude-only. A profile declares the required root-orchestrator model and controls Herder's persistent Accountant and worker roles. Select the root model when launching Codex or Claude Code; `--profile` validates the requirement but cannot replace the model of an already-running session.

```text
$herder:fire herder-plans --profile offcut
```

Herder validates profile structure and exact agent identifiers but does not query model catalogs or make token-consuming availability probes. If the host rejects a real dispatch before returning a worker handle, Herder reports the exact profile/role/model failure, releases the lease, consumes no attempt or round, and never substitutes another model.

## Configure role routing

Run `$herder:configure` to generate an Orca runtime profile or maintain legacy unqualified Codex aliases for an older run. Fresh native Fire uses the installed named catalog and `--profile`. Configure validates schema and harness adapters before writing, never accepts credentials in chat, and leaves model availability to the real Fire dispatch.

## Observe a run

Run `$herder:dashboard herder-plans` to open a loopback-only live graph of plan dependencies, implementation/review rounds, worker leases, token coverage, completion evidence, and the integration lane. The launcher detects Orca and VS Code terminals: Orca opens a workspace-browser tab, while VS Code Remote uses its managed port-forwarding path. The dashboard follows the restrained monochrome style of [minhu.wang](https://www.minhu.wang/), polls every two seconds, and is read-only by construction: it accepts only GET/HEAD and derives state from README, SQLite, and Git.

## Cross-harness execution with Orca

Run the controller inside an Orca-managed Codex terminal, then select the Orca runtime explicitly:

```text
$herder:fire herder-plans \
  --runtime orca \
  --runtime-profile /absolute/path/to/orca-runtime-profile.json
```

The bundled interoperability profile exercises Codex/GPT-5.6 Sol as controller, Grok Build/Grok 4.5 as Implementer and Saver, Pi/Kimi K3 as Reviewer, and Pi/GPT-5.6 Sol as Judge. The Orca adapter intentionally supports only Codex, Grok Build, and Pi. Native execution remains the default; Herder never silently changes runtime, harness, provider, or model.
