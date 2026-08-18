---
type: entity
title: fleet-supervisor
tags: [plugin, scheduler, wake]
related: [fleet-tasks, fleet-heartbeat, fleet-watchdog]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-supervisor

Fleet timers, scheduler, wake queue, takeover on stall, orphan recovery, periodic digests, ready-queue rollup, verification-gated merge queue.

## What It Does

- 30s heartbeat tick
- Durable wake queue with coalescing + budget checks
- Workspace resolution + skill loading
- Agent wake via `agent.followup`
- Takeover on stall
- Orphan recovery
- Periodic fleet digests
- Ready-queue rollup
- Verification-gated merge queue

## Tools

5 tools: fleet_wake, fleet_queue_status, fleet_digest_now, fleet_merge_enqueue, fleet_merge_status

## Key Files

- `plugins/fleet-supervisor/src/service.ts` — Core supervisor logic
- `plugins/fleet-supervisor/src/queue.ts` — Wake queue
- `plugins/fleet-supervisor/src/types.ts` — Types
