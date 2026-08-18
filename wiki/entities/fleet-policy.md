---
type: entity
title: fleet-policy
tags: [plugin, policy, postures]
related: [fleet-budget, leader-contract]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-policy

QM posture + command-policy layer: Strict / Auto / Dangerous postures with hard denials.

## Postures

| Posture | Behavior |
|---------|----------|
| Strict | Deny-by-default — only allowlisted commands run |
| Auto | Routine-safe by default — hard + soft denials block |
| Dangerous | Only hard denials block |

## Hard Denials (apply in EVERY posture)

- `force-push`, `reset --hard`, `mkfs/dd/shutdown`
- Mutating `/etc`, `/boot`, `/root`

## Tools

4 tools: policy_set_posture, policy_get_posture, policy_evaluate, policy_guard

## Per-Identity Overrides

Postures can be set per-agent or fleet-wide (context default). Per-identity overrides the context default.

## Key Files

- `plugins/fleet-policy/src/service.ts` — Policy logic
- `plugins/fleet-policy/src/types.ts` — Posture and denial types
