---
type: entity
title: fleet-settings
tags: [plugin, settings, ui]
related: [fleet-agent, fleet-teams, fleet-budget, fleet-policy]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-settings

Sessions + fleet settings page — the companion `/fleet-settings` page on the fleet HTTP server.

## What It Does

### Sessions Tab
- Reads DSH session ledger (`$DSH_HOME/sessions`, zstd JSONL)
- Per-log status (open turn = running) + title/updatedAt
- Resume via `session.prompt` RPC seam
- Archive via `workspace.archiveSession` RPC seam

### Fleet Settings Tabs
- **Agents** — fleet-agent profiles CRUD + enabled toggle
- **Teams/Rooms** — fleet-teams members/grants/rooms
- **Budgets** — fleet-budget caps + status
- **Policy** — fleet-policy postures

## Port

3094 (standalone), also mounted on dsh webServer via fleet-web.patch.yml

## Key Files

- `plugins/fleet-settings/src/service.ts` — Settings logic
- `plugins/fleet-settings/src/sessions.ts` — Session ledger reader
- `plugins/fleet-settings/src/page.ts` — Web page
- `plugins/fleet-settings/src/overlay.ts` — Settings overlay
