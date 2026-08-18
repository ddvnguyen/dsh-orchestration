---
type: entity
title: fleet-agent-provider
tags: [plugin, spawning, worktree]
related: [fleet-agent, fleet-tasks]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-agent-provider

DSH-native agent spawning with worktree isolation. Phase 1 MVP.

## What It Does

- Provides the fleet provider backend for spawning agents via DSH subagent mechanism
- Manages worktree lifecycle for task-isolated workspaces
- Bridges fleet task claims to DSH agent sessions

## Key Files

- `plugins/fleet-agent-provider/src/provider.ts` — Provider implementation
- `plugins/fleet-agent-provider/src/worktree.ts` — Worktree lifecycle
- `plugins/fleet-agent-provider/src/config.ts` — Configuration schema

## Status

Phase 1 MVP — basic spawning works, worktree lifecycle in progress.
