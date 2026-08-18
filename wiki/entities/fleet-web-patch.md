---
type: entity
title: fleet-web.patch.yml
tags: [config, cordis, composition]
related: [cordis-composition, fleet-architecture]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-web.patch.yml

Cordis composition overlay for the DSH web profile. Applied via `dsh web --patch <this>`.

## What It Does

- Inserts fleet plugins into the DSH web UI at :3080
- Mounts real routes: /admin, /api/agents, /fleet-teams-ui*, /fleet-board*
- Makes fleet tools available to all sessions (injectTools: true)
- Currently includes: 7 fleet plugins + mcp-searxng

## Current Entries

1. fleet-agent (admin, profiles, 15 tools)
2. fleet-teams (teams, rooms, grants)
3. fleet-teams-ui (rooms chat UI)
4. fleet-board (transparency feed)
5. fleet-budget (cost tracking)
6. fleet-policy (command policy)
7. fleet-settings (sessions + settings)
8. mcp-searxng (web search via MCP)

## Path

`/mnt/WorkDisk/Workplace/llm-server-monitoring/dsh-fleet-container/fleet-web.patch.yml`
