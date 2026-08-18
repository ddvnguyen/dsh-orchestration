---
type: source
title: V3 Design Document
tags: [design, architecture, phases]
related: [fleet-architecture, plugin-inventory]
created: 2026-08-18
updated: 2026-08-18
---

# V3 Design Document

DSH-native fleet orchestration — run agent teams on deepseek-harness as the base runtime.

## Phases

| Phase | Plugins | Status |
|-------|---------|--------|
| 0 — Foundation | fleet-bus, fleet-agent | ✅ WORKING |
| 1 — Visibility | fleet-board | ✅ WORKING |
| 2 — Swarm ops | fleet-tasks, fleet-supervisor, fleet-watchdog | ✅ WORKING |
| 3 — Hardening | fleet-policy, fleet-budget, fleet-extras | ✅ WORKING |
| 4 — Social | fleet-teams, fleet-teams-ui, fleet-admin, fleet-settings | ✅ WORKING |

## Owner Decisions

1. Identity: ed25519-signed events now; Nostr bridge later
2. Board UI: standalone page via DSH HTTP server
3. GitHub intake: HOLD
4. Budgets: soft warnings + escalation (no hard stops)
5. Paseo: retired once V3 covers web UI + supervision
6. Fleet tools: LEAD ONLY via presets
7. Dev agents: do NOT self-wake
8. Dev agents: keep native DSH subagent capability

Source: [[v3-design]] (docs/v3-design.md)
