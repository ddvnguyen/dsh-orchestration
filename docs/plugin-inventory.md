# Plugin Inventory — all 19 fleet plugins

## ENABLED — composed into :3080 web profile (9)

| # | Plugin | Port | Acceptance |
|---|---|---|---|
| 1 | fleet-agent | 3093 (admin) | agent identity + `/admin` + `/api/agents` + 15 tools (8 admin + 7 heartbeat) |
| 2 | fleet-teams | — | teams + rooms + grants + team_post + room memory |
| 3 | fleet-teams-ui | 3092 | rooms chat UI + sender identity + team settings dialog |
| 4 | fleet-board | 3090 | transparency feed: CLI + HTTP + page + fleet_feed tool |
| 5 | fleet-bus | — | durable event store + pub/sub/replay + followup/inject delivery |
| 6 | fleet-budget | — | cost tracking + scoped caps + soft warnings + escalation |
| 7 | fleet-policy | — | Strict/Auto/Dangerous postures + hard denials |
| 8 | fleet-settings | 3094 | sessions + fleet settings page |
| 9 | ui-fleet-settings | — | client-side fleet settings in DSH dialog |

## STANDALONE-ONLY — own bin/port or headless team plane (8)

| # | Plugin | Notes |
|---|---|---|
| 9 | fleet-heartbeat | in-memory registry + stall engine (service-plane base) |
| 10 | fleet-mcp | stdio MCP server (`dsh-fleet-mcp` bin) |
| 11 | fleet-inject | agent-plane tool injection on `agent/created` |
| 12 | subagent-claude-code-fleet | provider fork for out-of-process children |
| 13 | fleet-tasks | SQLite task queue (service, no UI) |
| 14 | fleet-supervisor | scheduler/wake/supervision engine (headless) |
| 15 | fleet-watchdog | verification gate on stopped work (headless) |
| 16 | fleet-agent-provider | DSH-native agent spawning with worktree isolation (Phase 1 MVP) |
| 17 | fleet-schedule | JSON schedule store (`schedules.json`) + 1 s tick + `fleet_heartbeat_*` tool surface (service, no UI) |

## DISABLED (1)

| # | Plugin | Rationale |
|---|---|---|
| 18 | fleet-extras | hcom watch/subscribe/collision — no live consumer yet |

## Ports

| Port | Service |
|---|---|
| 3080 | DSH web UI (fleet-web.patch.yml overlay) |
| 3090 | fleet-board standalone |
| 3091 | host fleet-exporter (NOT a fleet plugin) |
| 3092 | fleet-teams-ui standalone |
| 3093 | fleet-agent-admin standalone |
| 3094 | fleet-settings standalone |

## Test evidence

`npm test` from `dsh-orchestration/` — **20/21 suites PASS** (~8 s; schedule-smoke added).
Pre-existing, unrelated: `mcp-smoke` spawns a hardcoded `../../external/deepseek-harness/node_modules/.bin/tsx`
path that does not exist in this worktree (test bug, present in HEAD — not caused by the schedule work).
