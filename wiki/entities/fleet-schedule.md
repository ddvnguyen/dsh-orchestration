---
type: entity
title: fleet-schedule
tags: [plugin, heartbeat, cron]
related: [fleet-heartbeat, fleet-supervisor]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-schedule

API-based heartbeat management — agents create/update/delete/pause/resume/run heartbeats via tools; 1s tick delivers each due schedule's prompt to its target agent.

## What It Does

- Cron + interval-based scheduling
- Disk persistence (`schedules.json`)
- 7 tools: fleet_heartbeat_create, fleet_heartbeat_update, fleet_heartbeat_delete, fleet_heartbeat_list, fleet_heartbeat_pause, fleet_heartbeat_resume, fleet_heartbeat_run_once
- Events: fleet/schedule-created, fleet/schedule-executed, fleet/schedule-deleted

## Key Files

- `plugins/fleet-schedule/src/schedule-service.ts` — Scheduler logic (33KB)
- `plugins/fleet-schedule/src/schedule-store.ts` — Persistence
