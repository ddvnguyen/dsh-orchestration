---
type: concept
title: Fleet Agent Model
tags: [agents, roster, tiers]
related: [fleet-agent, fleet-agent-presets, leader-contract]
created: 2026-08-18
updated: 2026-08-18
---

# Fleet Agent Model

Six roster agents with defined roles, tiers, providers, and claim routing.

## Roster

| Agent ID | Name | Role | Tier | Provider | Claim Role |
|----------|------|------|------|----------|------------|
| lead | Lead | lead | t2 | opencode-go/mimo-v2.5 | lead |
| arch | Architect | arch | t1 | claude/claude-sonnet-5 | arch |
| dev-1 | Developer 1 | dev-1 | t2 | opencode-go/mimo-v2.5 | dev-1 |
| dev-2 | Developer 2 | dev-2 | t2 | opencode-go/mimo-v2.5 | dev-2 |
| devops | Devops | devops | t2 | opencode-go/mimo-v2.5 | devops |
| qa | QA | qa | t1 | claude/claude-sonnet-5 | qa |

## Tier Routing

| Tier | Provider | Use Case |
|------|----------|----------|
| t1 | claude/claude-sonnet-5 | Planning, architecture, QA review |
| t2 | opencode-go/mimo-v2.5 | Implementation, devops, default workers |

## Claim Routing

Tasks are routed to agents via `claimRole`. When a task is created with `claimRole: dev-1`, the supervisor wakes the dev-1 agent to claim it.

## Owner

The human operator is NOT a fleet-agent profile. They stay an inbound-gate concept — admitted by the gate but no ed25519 keypair and no claimWake capability.
