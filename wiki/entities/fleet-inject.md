---
type: entity
title: fleet-inject
tags: [plugin, tool-injection]
related: [fleet-heartbeat, fleet-agent]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-inject

Auto-injects fleet tools into in-process DSH agents via `agent.ctx.tools` on `agent/created`.

## What It Does

- Listens for `agent/created` events
- Injects fleet tools (list/get_status/send_message/wait_for_agent) into new agents
- Documents the ACP mcpServers seam for out-of-process children

## Tool Injection

Fleet tools reach agent sessions through this plugin. When a new DSH agent is created, fleet-inject registers the appropriate fleet tools on its tool registry based on the agent's preset configuration.
