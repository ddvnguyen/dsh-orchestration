---
type: entity
title: fleet-heartbeat
tags: [plugin, liveness, stall]
related: [fleet-agent, fleet-supervisor]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-heartbeat

Agent registry + per-agent heartbeat (lastSeen, status, stall detection), 30s tick timer, and fleet/event records.

## What It Does

- Registers `ctx.fleet` service (agent registry)
- Tracks agent liveness via heartbeats
- 30s scan: no heartbeat for 10min → `stalled`
- Events: heartbeat, stall, resume (mirrored into DSH session logs)
- 7 tools: fleet_list_agents, fleet_get_status, fleet_send_message, fleet_wait_for_agent, fleet_events, fleet_subscribe, fleet_publish

## Agent Status Lifecycle

```
active → (no heartbeat 10min) → stalled → (heartbeat resumes) → active
offline → (registered) → active
```

## Key Files

- `plugins/fleet-heartbeat/src/index.ts` — Registry + stall engine
