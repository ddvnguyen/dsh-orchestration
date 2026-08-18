---
type: concept
title: Fleet Tool Injection
tags: [tools, injection, presets]
related: [fleet-inject, fleet-agent-presets]
created: 2026-08-18
updated: 2026-08-18
---

# Fleet Tool Injection

How fleet tools reach agent sessions through presets and auto-injection.

## Mechanism

1. Fleet plugins have `injectTools: true` in fleet-web.patch.yml
2. This makes fleet tools available to ALL sessions
3. Agent presets constrain which tools each agent role can use
4. fleet-inject auto-injects additional tools on `agent/created`

## Preset Tool Access

| Preset | Fleet Tools |
|--------|-------------|
| fleet-lead | agent, teams, board, policy, budget |
| fleet-arch | agent, board, policy |
| fleet-dev-1 | agent, board |
| fleet-dev-2 | agent, board |
| fleet-devops | agent, board, teams |
| fleet-qa | agent, board |

Non-lead agents have NO fleet tools but keep native DSH subagent capability.
