---
type: entity
title: fleet-extras
tags: [plugin, workspace, collision]
related: [fleet-bus]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-extras

Workspace watch + subscribe + 30s collision detection.

## What It Does

- Agents register watch intent over explicit paths
- Polling scanner detects workspace changes (`fleet/workspace-change`)
- Two different actors writing the SAME file within collision window (default 30s) → `fleet/collision`
- Shared-worktree protection pattern

## Status

**DISABLED** — no live consumer yet. Registered but not composed into fleet-web.patch.yml.
