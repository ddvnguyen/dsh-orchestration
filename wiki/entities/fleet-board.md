---
type: entity
title: fleet-board
tags: [plugin, visibility, transparency]
related: [fleet-bus, fleet-feed-tool]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-board

Transparency feed — a read/tail surface over the fleet-bus event store with a CLI (`fleet log/status`), an HTTP endpoint, a single-file web page, and the `fleet_feed` tool.

## What It Does

- Renders fleet-bus events as a human-readable feed
- CLI: `fleet log` (text feed), `fleet status` (per-actor summary)
- HTTP: `/events`, `/health`, `/fleet-board*` routes
- Web page: output-first single-file page with expandable events
- Tool: `fleet_feed` — any agent asks "what is everyone working on?"
- Standalone server on port 3090

## Key Files

- `plugins/fleet-board/src/feed.ts` — Feed rendering logic
- `plugins/fleet-board/src/page.ts` — Web page HTML
- `plugins/fleet-board/src/server.ts` — HTTP server
- `plugins/fleet-board/src/cli.ts` — CLI implementation
- `plugins/fleet-board/src/bin.ts` — Standalone server entry

## Port

3090 (standalone), also mounted on dsh webServer via fleet-web.patch.yml
