# V3 Design — dsh-native fleet orchestration

Run agent teams on deepseek-harness (DSH) as the base runtime, with the fleet layer built as DSH plugins.

## Architecture

```
DSH runtime (base)                Fleet core (built)              V3 plugins
──────────────────────           ───────────────────────         ─────────────────────────
sessions · ledger · compaction   fleet-heartbeat (ctx.fleet)     fleet-bus      (events/replay/notify)
subagents · ACP · schedule       fleet-mcp (MCP A2A server)      fleet-agent    (profiles + signed events)
sandbox · workspace · skills     fleet-inject (auto-tools)       fleet-teams    (teams/rooms/grants)
routes: zen ✓ claude-code ✓     claude-code-fleet (mcpServers)  fleet-board    (transparency feed UI)
web UI :3080 · typert/api                                      fleet-tasks    (queue + org chart + claim)
                                                                fleet-supervisor (takeover/digests/timers)
                                                                fleet-watchdog  (verification gate)
                                                                fleet-policy   (postures + command policy)
                                                                fleet-budget   (soft caps + escalation)
                                                                fleet-extras   (hcom subscribe/watch/collision)
                                                                fleet-settings (sessions + fleet settings)
```

## Phases

| Phase | Plugins | Status |
|---|---|---|
| 0 — Foundation | fleet-bus, fleet-agent | ✅ bus PROTOTYPE, agent WORKING |
| 1 — Visibility | fleet-board | ✅ WORKING |
| 2 — Swarm ops | fleet-tasks, fleet-supervisor, fleet-watchdog | ✅ WORKING |
| 3 — Hardening | fleet-policy, fleet-budget, fleet-extras | ✅ all WORKING (extras disabled) |
| 4 — Social | fleet-teams, fleet-teams-ui, fleet-admin, fleet-settings | ✅ all WORKING |

## Owner decisions

1. Identity: own ed25519-signed events now; Nostr export bridge later
2. fleet-board UI: standalone page via DSH HTTP server
3. GitHub intake: HOLD — spec-only this epic
4. Budgets: soft warnings + escalation (no hard stops)
5. Paseo mobile/voice/relay: not needed — Paseo retired once V3 covers web UI + supervision
6. Fleet tools: LEAD ONLY via agent presets; non-lead agents get NO fleet tools
7. Dev agents: do NOT self-wake — LEAD wakes via supervisor claimWake
8. Dev agents: keep native DSH subagent capability for research tasks
