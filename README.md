# Herder

Herder is a task orchestrator engine for Claude Code and Codex. It shapes objectives into focused semantically bounded plan graphs, executes independent six-round implementation/review loops, and uses an independent Judge to filter unresolved findings from round three onward. One persistent Accountant owns scheduling, SQLite attempt accounting and rich run reports, lifecycle transitions, gates, Git transactions, and integration while the root only dispatches and waits for workers. Its optional Orca runtime can route plan workers across different CLI harnesses while preserving one plan, review, and integration protocol.

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

Start a new Codex session and run `$herder:install`. Follow any printed Multi-Agent V2 setup instructions; if profiles or configuration change, start one more new session before using `$herder:fire`. The default five-plan-worker pool reserves one additional child thread for its Luna/max/Fast Accountant, so configure at least six concurrent child threads.

## Configure role routing

Run `$herder:configure` to choose native Codex or Orca, review each role's harness/model/effort mapping, and validate every unique route before writing configuration. Configure never accepts credentials in chat: unavailable routes stop before writing and direct you to the selected CLI's login or provider setup.

## Cross-harness execution with Orca

Run the controller inside an Orca-managed Codex terminal, then select the Orca runtime explicitly:

```text
$herder:fire herder-plans \
  --runtime orca \
  --runtime-profile /absolute/path/to/orca-runtime-profile.json
```

The bundled interoperability profile exercises Codex/GPT-5.6 Sol as controller, Grok Build/Grok 4.5 as Implementer and Saver, Pi/Kimi K3 as Reviewer, and Pi/GPT-5.6 Sol as Judge. The Orca adapter intentionally supports only Codex, Grok Build, and Pi. Native execution remains the default; Herder never silently changes runtime, harness, provider, or model.
