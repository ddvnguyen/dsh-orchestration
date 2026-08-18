---
type: entity
title: fleet-teams
tags: [plugin, teams, rooms, grants]
related: [fleet-teams-ui, fleet-agent]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-teams

Named teams + rooms + per-room grants + team_post + shared-room memory file.

## What It Does

- Team membership + grants (agent-specific config lives in fleet-agent)
- Room-scoped bus scope validation
- Room memory: per-room durable markdown file under `$DSH_HOME/fleet/agents/<room>.memory.md`
- Joining a room delivers memory + recent room events

## Tools

13 tools: team_create, team_join, team_leave, team_list, team_grants, room_create, room_join, room_leave, room_list, room_grants, team_post, room_memory, team_scope

## Key Files

- `plugins/fleet-teams/src/service.ts` — Team/room logic
- `plugins/fleet-teams/src/types.ts` — Types
