---
type: overview
title: DSH Fleet Orchestration Wiki
created: 2026-08-18
updated: 2026-08-18
---

# DSH Fleet Orchestration Wiki

## Entities — Plugins

- [[fleet-agent]] — Agent identity, ed25519 keys, profiles, admin API
- [[fleet-agent-provider]] — DSH-native agent spawning with worktree isolation
- [[fleet-board]] — Transparency feed: CLI + HTTP + web page + fleet_feed tool
- [[fleet-budget]] — Cost tracking, scoped caps, soft warnings, escalation
- [[fleet-bus]] — Durable event store with pub/sub/replay and delivery
- [[fleet-extras]] — Workspace watch, subscribe, collision detection
- [[fleet-heartbeat]] — Agent registry, liveness tracking, stall detection
- [[fleet-inject]] — Auto-inject fleet tools into new agents
- [[fleet-mcp]] — MCP server exposing fleet registry as tools
- [[fleet-policy]] — Command policy: Strict/Auto/Dangerous postures
- [[fleet-schedule]] — API-based heartbeat/schedule management
- [[fleet-settings]] — Sessions + fleet settings page
- [[fleet-supervisor]] — Scheduler, wake queue, digests, merge queue
- [[fleet-tasks]] — Task queue: create/claim/complete/cancel/escalate/accept
- [[fleet-teams]] — Teams, rooms, grants, room memory
- [[fleet-teams-ui]] — Rooms chat UI with sender identity
- [[fleet-watchdog]] — Verification gate on stopped work

## Entities — Services & Scripts

- [[fleet-supervisor-script]] — Host-side supervisor (bin/fleet-supervisor.sh)
- [[fleet-up-script]] — Service bring-up script (bin/fleet-up)
- [[fleet-dsh-service]] — systemd unit for fleet runtime
- [[fleet-web-patch]] — Cordis composition overlay for web profile
- [[fleet-bootstrap]] — Idempotent V3 team bootstrap

## Entities — Agents & Configs

- [[fleet-agent-model]] — Roster, tiers, providers, claim routing
- [[settings-yaml]] — LLM provider and runtime configuration
- [[fleet-agent-presets]] — Per-agent preset YAML + cordis.yml

## Concepts

- [[cordis-composition]] — How plugins compose through cordis.patch.yml
- [[fleet-architecture]] — Three-layer architecture: DSH base + fleet core + plugins
- [[fleet-event-driven]] — Event-driven communication via fleet-bus
- [[fleet-job-protocol]] — V2 job kinds → V3 fleet task mapping
- [[leader-contract]] — Binding rules for the lead agent (§1–§14)
- [[fleet-tool-injection]] — How fleet tools reach agent sessions
- [[heartbeat-wake-system]] — Agent liveness and wake delivery
- [[fleet-policy-postures]] — Strict/Auto/Dangerous command policy

## Sources

- [[deploy-prod]] — Production deployment on ddv-server
- [[orchestration-setup]] — Host-service setup guide
- [[v3-design]] — V3 architecture and phase status
- [[plugin-inventory]] — All 19 plugins with status
- [[job-protocol]] — V2→V3 task lifecycle mapping
- [[dsh-config-catalog]] — DSH plugin configuration reference

## Queries

- [[missing-file-tools]] — DSH lacks native file read/write/search tools
- [[missing-mcp-config]] — DSH has no settings.yaml MCP configuration
- [[fleet-exporter-status]] — fleet-exporter.service is dead

## Synthesis

- [[dsh-gaps]] — Missing primitives in DSH (file tools, search, MCP config)
- [[prod-status]] — Current production state and known issues

## Comparisons

- [[opencode-vs-dsh-mcp]] — MCP configuration in OpenCode vs DSH
