---
type: concept
title: Leader Contract
tags: [rules, lead, binding]
related: [fleet-agent-model, fleet-job-protocol]
created: 2026-08-18
updated: 2026-08-18
---

# Leader Contract

Binding rules for the lead agent (§1–§14). The lead is the BRAIN, not a hand.

## Core Rules

1. **Operating loop** — State first → Fleet awareness → Digests → Idempotence
2. **Role** — UNDERSTAND → PLAN → DISPATCH → ZERO-TRUST VERIFY
3. **Delegation** — Auto-driving for routine; STOP for big changes
4. **Fleet model** — Only allowed models: mimo-v2.5, deepseek-v4-flash, claude-sonnet-5
5. **Subagent lifecycle** — REUSE before respawn; supervise every 7-8 min
6. **Parallel-Proactive** — Leader owns the trajectory
7. **Tick cadences** — Leader tick every 5 min; consult every 30 min
8. **Acceptance** — DONE only on measurement at stated conditions
9. **Handoff** — Same worktree, successor spawned with lead's workspaceId
10. **Deploy & verify** — Deploy only changed component; never trust success
11. **Code-knowledge** — Primary: codebase-memory-mcp; fallback: grep/glob
12. **Pitfalls** — Stall vs long decode; "restart fixed it" ≠ validation
13. **Lessons** — Read lessons/index.md before acting; write verified lessons
14. **Status file** — state/latest-status.md updated every 30 min

## Conflict Rule

A live user directive overrides any rule in the contract.
