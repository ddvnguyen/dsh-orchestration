---
type: concept
title: Fleet Policy Postures
tags: [policy, postures, safety]
related: [fleet-policy, leader-contract]
created: 2026-08-18
updated: 2026-08-18
---

# Fleet Policy Postures

Three command-policy postures controlling what commands agents can run.

## Postures

### Strict (deny-by-default)
- Only allowlisted commands run
- Everything else is blocked
- Use for untrusted agents or high-risk environments

### Auto (routine-safe by default)
- Routine commands allowed by default
- Hard denials (destructive commands) block
- Soft denials (risky commands) block
- Default for most agents

### Dangerous (permissive)
- Only hard denials block
- Everything else is allowed
- Use for trusted agents in controlled environments

## Hard Denials (always block)

- `force-push`, `reset --hard`
- `mkfs`, `dd`, `shutdown`
- Mutating `/etc`, `/boot`, `/root`

## Scoping

- Fleet-wide default: `policy_set_posture({ scope: 'context', posture: 'Auto' })`
- Per-agent override: `policy_set_posture({ scope: 'dev-1', posture: 'Strict' })`
