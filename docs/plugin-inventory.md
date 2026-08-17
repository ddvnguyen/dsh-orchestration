# Plugin Inventory — all 18 fleet plugins

## ENABLED — composed into :3080 web profile (9)

| # | Plugin | Port | Acceptance |
|---|---|---|---|
| 1 | fleet-agent | 3093 (admin) | agent identity + `/admin` + `/api/agents` + 8 tools |
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

## DISABLED (1)

| # | Plugin | Rationale |
|---|---|---|
| 17 | fleet-extras | hcom watch/subscribe/collision — no live consumer yet |

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

`npm test` from `dsh-orchestration/` — **20/20 suites PASS, exit 0** (~8 s).
