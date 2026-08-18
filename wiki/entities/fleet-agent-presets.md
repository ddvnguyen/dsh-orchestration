---
type: entity
title: Fleet Agent Presets
tags: [presets, config, agents]
related: [fleet-agent-model, fleet-tool-injection]
created: 2026-08-18
updated: 2026-08-18
---

# Fleet Agent Presets

Per-agent preset YAML + cordis.yml files written by bootstrap into `$DSH_HOME/.agent-presets/`.

## Presets

| Preset | Agent | Fleet Tools |
|--------|-------|-------------|
| fleet-lead | lead | agent, teams, board, policy, budget |
| fleet-arch | arch | agent, board, policy |
| fleet-dev-1 | dev-1 | agent, board |
| fleet-dev-2 | dev-2 | agent, board |
| fleet-devops | devops | agent, board, teams |
| fleet-qa | qa | agent, board |

## Location

`$DSH_HOME/.agent-presets/fleet-<role>/`

Each preset contains:
- `preset.yml` — preset configuration
- `agent.cordis.yml` — cordis composition for the agent
