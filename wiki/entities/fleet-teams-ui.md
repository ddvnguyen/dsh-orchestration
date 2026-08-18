---
type: entity
title: fleet-teams-ui
tags: [plugin, ui, chat]
related: [fleet-teams, fleet-agent]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-teams-ui

Rooms chat UI — renders each room's chat thread with sender name/avatar/role badges, grant-checked composer, and team/room settings dialog.

## What It Does

- Renders fleet/team-post events as a chat thread
- Sender identity resolved from fleet-agent profile registry
- Grant-checked composer (read/post/join)
- Team menu with room settings dialog
- Standalone server on port 3092

## Port

3092 (standalone), also mounted on dsh webServer via fleet-web.patch.yml
