---
type: purpose
title: DSH Fleet Orchestration Knowledge Base
created: 2026-08-18
updated: 2026-08-18
---

# Purpose

## Why This Wiki Exists

This wiki is the authoritative knowledge base for the DSH (DeepSeek Harness) fleet orchestration system — the V3 agent-team runtime that composes on top of DSH as cordis plugins. It captures architecture decisions, deployment procedures, plugin inventory, operational runbooks, and development patterns for the fleet running on ddv-server.

## Key Questions

1. How is the fleet architecture structured, and what does each layer do?
2. How do you deploy, operate, and troubleshoot the fleet in PROD?
3. What plugins exist, what do they do, and how do they compose?
4. How does the fleet agent model work (roles, tiers, providers, claim routing)?
5. What are the operational patterns for lead-agent orchestration?

## Scope

### In Scope
- DSH fleet orchestration plugins (18+ plugins)
- V3 team roster, bootstrap, and agent presets
- Production deployment on ddv-server (systemd host services)
- Leader contract and job protocol
- Fleet bus, tasks, supervisor, watchdog, policy, budget systems
- Settings, MCP integration, web UI composition
- Troubleshooting and operational procedures

### Out of Scope
- DSH harness internals (upstream dependency, not forked)
- Individual model performance tuning
- Non-fleet DSH usage patterns

## Thesis

The DSH fleet is a **plugin-composed** agent-team runtime: DSH provides the base (sessions, tools, shell, ACP, compaction), and the fleet layer adds identity, communication, task management, supervision, and verification — all as cordis plugins composed through `fleet-web.patch.yml`. This architecture keeps the fleet decoupled from the harness and enables incremental feature delivery.
