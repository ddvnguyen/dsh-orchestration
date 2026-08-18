# Fleet status — 2026-08-18 (dsh-orchestration dogfooding)

## Fleet summary
- All 18 plugins migrated to dsh-orchestration
- Supervisor: systemd fleet-dsh.service from /mnt/WorkDisk/Workplace/dsh-orchestration
- Web UI: :3080, Board: :3090
- opencode-go provider: opencode.ai/zen/go/v1 (deepseek-v4-flash, mimo-v2.5, + 6 more)
- Compaction: thresholdRatio=0.4, retainRatio=0.20, maxTokens=30K (all fleet presets)

## Ready queue
(empty)

## In-flight
(empty — leader just started, no tasks dispatched yet)

## Completed
- [done] Q1 config-HMR verification
- [done] Q4 settings layout (right-side panel)
- [done] Q3 settings surface
- [done] E2E host-native suite
- [done] Leader preset implementation
- [done] Host-services migration (container → systemd)
- [done] V3 P0-P4.4 all plugins verified (20/20 suites)
- [done] Contract cleanup (0 Paseo refs, AGENTS.md 14K→4.3K)
- [done] dsh-orchestration repo setup + full plugin migration
- [done] settings.yaml opencode-go provider config
- [done] Compaction config in all fleet presets
- [done] §5.1 heartbeat & wake system documented
- [done] §14 status file binding

## Blocked / hold
- [hold] fleet-intake — owner HOLD
- [hold] nostr-bridge — deferred

## Follow-ups
- dsh-orchestration standalone dev (pnpm workspace for @deepseek-ai/* imports)
- fleet-agent-provider Phase 2-4 (preset param, worktree lifecycle, background+wake)
- fleet-mcp cross-process ACP wiring (blocked on upstream DSH)

## In-flight
- [running] fleet-schedule implementation — worker c9febf78 dispatched
  - New plugin: fleet-schedule (heartbeat API)
  - Agent tools: fleet_heartbeat_create/update/delete/list/pause/resume/run_once
  - Settings UI panel
  - Cron/interval-based scheduler

## Completed (this session)
- [done] fleet-schedule plugin — API-based heartbeat management (worker c9febf78)
  - Files: plugins/fleet-schedule/src/index.ts, src/schedule-service.ts, src/schedule-store.ts
  - 7 agent tools: fleet_heartbeat_create/update/delete/list/pause/resume/run_once
  - Cron + interval cadence, disk persistence, 105 tests passing
  - Follow-up: add fleet-schedule to container/fleet-web.patch.yml for deployment

## In-flight
- [running] fleet-sidebar plugin — worker dd34b259 dispatched
  - Two sidebar icons: Scheduler + Orchestration
  - Slide-out panels for each
  - Backend API routes for heartbeats/fleet data

## Completed (this session)
- [done] fleet-sidebar plugin — two sidebar icons + slide-out panels (worker dd34b259)
  - Files: plugins/ui-fleet-sidebar/ (13 files)
  - Scheduler icon → heartbeat list/form panel
  - Orchestration icon → agents/teams/sessions/budgets/policy tabs
  - Backend API: /api/fleet/* routes verified 28/28
  - Follow-up: register client in DSH web host plugin manifest

## Pending
- [queue] Trajectory context summary row (Option A: add slot in DSH fork)
- [queue] Status bar override (show context size instead of input/output)
- [queue] Hide header tabs (CSS injection)
- [queue] Remove ContextMeter ring (slot override)

## In-flight
- [running] DSH trajectory slot — worker bbfb3906 (add trajectory.context.summary slot)
- [running] UI overrides — worker 0580a096 (FleetStatsLine, ContextSummaryRow, CSS tab hiding)

## Completed (this session)
- [done] DSH trajectory slot — minimal change (1 new file + 14 lines in 2 files)
  - New: packages/client/ui-trajectory/src/client/trajectory-context-slot.ts
  - Modified: TrajectoryView.tsx (+7/-2), index.ts (+7)
  - Zero upstream conflict surface

## Completed (this session)
- [done] DSH trajectory slot — fully complete (wrapper div + CSS added)
  - trajectory-context-slot.ts: slot declaration + readTrajectoryContextSummary helper
  - TrajectoryView.tsx: renderSlot call with wrapper div
  - views.module.css: .contextSummary sticky styles
  - index.ts: export + children declaration

## Completed (this session)
- [done] DSH trajectory slot — minimal change (1 new file + 14 lines in 2 files)
- [done] UI overrides plugin — worker 0580a096 (FleetStatsLine, ContextSummaryRow, CSS hiding)
  - Files: plugins/ui-fleet-ui-overrides/ (7 files)
  - Slot priority: -1 (lowest wins, not last-wins)
  - CSS selectors verified against running bundle class names
  - Follow-up: register in DSH web host plugin manifest

## Session Summary
Fleet-schedule system (heartbeat API) + Fleet-sidebar (2 icons + panels) + UI overrides (stats/context/hiding) + DSH trajectory slot — all implemented and verified.
