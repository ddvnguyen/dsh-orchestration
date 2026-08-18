---
type: concept
title: Fleet Architecture
tags: [architecture, design]
related: [cordis-composition, fleet-event-driven, v3-design]
created: 2026-08-18
updated: 2026-08-18
---

# Fleet Architecture

Three-layer architecture: DSH base → fleet core → fleet plugins.

## Layers

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

## Key Principle

The fleet layer is **plugin-composed**, not forked. DSH provides the base runtime; fleet plugins add identity, communication, task management, supervision, and verification. This keeps the fleet decoupled from the harness.

## Composition Path

Plugins compose through `fleet-web.patch.yml`, which is passed to `dsh web --patch`. This overlay inserts fleet plugin entries into the DSH web profile's cordis composition.

## See Also

- [[cordis-composition]] — How plugins compose
- [[fleet-event-driven]] — Event-driven communication
- [[v3-design]] — Phase status and owner decisions
