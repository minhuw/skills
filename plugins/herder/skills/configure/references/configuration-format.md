# Configuration format

Use schema version 1. The temporary answers file contains no credentials:

```json
{
  "schemaVersion": 1,
  "backend": "orca",
  "name": "project-orca",
  "roles": {
    "controller": {
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "max"
    },
    "plan-implementer": {
      "harness": "grok-build",
      "model": "grok-4.5",
      "effort": "high"
    },
    "plan-reviewer": {
      "harness": "pi",
      "model": "kimi-coding/k3",
      "effort": "max"
    },
    "plan-judge": {
      "harness": "pi",
      "model": "openai/gpt-5.6-sol",
      "effort": "max"
    },
    "plan-saver": {
      "harness": "grok-build",
      "model": "grok-4.5",
      "effort": "high"
    }
  }
}
```

`backend` is `orca` or `native-codex`. The answers schema still contains the controller and four configurable worker roles; every native harness must be `codex`. Its controller mapping becomes a launch command, the four worker mappings become project or user agent profiles, and generation also copies the fixed bundled `plan_accountant` profile. The Accountant is always Luna/max/Fast and is never an Orca-routed role.

For native Codex profiles and Orca roles backed by Codex, the generator adds `service_tier = "fast"` to child roles whose model ID ends in `-luna`. It removes that setting from non-Luna child profiles and never enables Fast tier for the controller.

Validation and probing add the fixed native `plan-accountant` route (`gpt-5.6-luna`, `max`, Fast tier) to the configurable routes before deduplication. This applies to both backends because Orca routes plan workers only; it does not host the Accountant.

Role names are exact. Unknown or missing roles fail validation.

Harness rules:

- `codex`: model is a Codex model ID; effort is `low`, `medium`, `high`, `xhigh`, or `max`.
- `grok-build`: model is a Grok model ID; effort is `low`, `medium`, or `high`.
- `pi`: model is the exact `provider/model` route; effort is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The generator derives providers, commands, permission modes, and credential-free probes. Do not add raw command arrays to the answers file.
