/**
 * @hydra/dsh-fleet-sidebar — server half: mounts the `/api/fleet` API family
 * on the dsh webServer for the sidebar Scheduler + Orchestration panels.
 *
 * A Cordis function plugin in the dsh house style (named exports `name` /
 * `inject` / `Config` / `apply`, see `@deepseek-ai/dsh-tool-todo` as the
 * registration template). It serves:
 *
 * ```
 * GET  /api/fleet/heartbeats           → list schedules (ctx.fleetSchedule)
 * POST /api/fleet/heartbeats           → create schedule
 * GET  /api/fleet/heartbeats/:id       → schedule detail
 * PUT  /api/fleet/heartbeats/:id       → update schedule
 * DEL  /api/fleet/heartbeats/:id       → delete schedule
 * POST /api/fleet/heartbeats/:id/pause|resume|run → schedule verbs
 * GET  /api/fleet/agents               → fleet-agent profiles (ctx.fleetAgent)
 * GET  /api/fleet/teams                → fleet-teams teams/rooms/members/grants
 * GET  /api/fleet/sessions             → session ledger rows
 * GET  /api/fleet/budgets              → fleet-budget status
 * POST /api/fleet/budgets              → setBudget
 * GET  /api/fleet/policy               → fleet-policy posture status
 * POST /api/fleet/policy               → setPosture
 * GET  /api/fleet/health               → liveness + live-vs-shadow service report
 * ```
 *
 * Optional-service rule (AGENTS.md): every fleet-family service is resolved
 * with `ctx.get` at apply time and the plugin degrades gracefully — heartbeat
 * routes answer 503 (with a clear reason) when the fleet-schedule plugin is
 * not composed (never a shadow copy: a second ScheduleService would start its
 * own tick timer), while agent/team/budget/policy/session routes fall back to
 * fresh service instances over the same durable dirs (the fleet-settings
 * pattern), so the fleet data tabs work in any composition. The webServer
 * itself is optional too: without one nothing is mounted.
 *
 * ```
 * - id: ui-fleet-sidebar
 *   name: '@hydra/dsh-fleet-sidebar'
 *   config:
 *     home: ''   # default $DSH_HOME (shadow service instances only)
 * ```
 * @module @hydra/dsh-fleet-sidebar
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { ScheduleService } from '../../../src/schedule-service.ts'
import type { FleetAgentService } from '../../fleet-agent/src/service.ts'
import type { FleetTeamsService } from '../../fleet-teams/src/service.ts'
import type { FleetBudgetService } from '../../fleet-budget/src/service.ts'
import type { FleetPolicyService } from '../../fleet-policy/src/service.ts'
import { createFleetSidebarHandlers, type FleetSidebarDeps } from './server/routes.ts'

/** Cordis plugin identity (server half). */
export const name = 'ui-fleet-sidebar'
/** All fleet deps are optional (`ctx.get` at apply time) — nothing to inject. */
export const inject: string[] = []

/** Schemastery configuration schema for the plugin consumer. */
export interface Config {
  /** DSH_HOME override for shadow service instances (default resolved DSH_HOME). */
  home: string
}

export const Config: z<Config> = z.object({
  home: z.string(),
})

/**
 * Mount the `/api/fleet` family on a composed dsh webServer. Without one the
 * plugin stays inert (the sidebar API is served by whatever host owns the
 * web, exactly like the fleet-settings/fleet-board route families).
 */
export function apply(ctx: Context, config: Config): void {
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer === undefined) {
    ctx.logger.info('ui-fleet-sidebar: no webServer composed — /api/fleet routes not mounted')
    return
  }

  const home = config.home || resolveDshHome()
  const deps: FleetSidebarDeps = resolveSidebarDeps(ctx, home)

  const handlers = createFleetSidebarHandlers(deps, {
    svc: 'ui-fleet-sidebar',
    storeDir: join(home, 'fleet'),
  })
  const disposers: Array<() => void> = [
    webServer.register({ kind: 'prefix', path: '/api/fleet', handler: handlers.api }),
    webServer.register({ kind: 'exact', path: '/api/fleet/health', handler: handlers.health }),
  ]
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'ui-fleet-sidebar: /api/fleet webServer routes')
  ctx.logger.info('ui-fleet-sidebar: mounted /api/fleet on dsh webServer')
}

/** Resolve the optional fleet services (optional-service rule). */
function resolveSidebarDeps(ctx: Context, home: string): FleetSidebarDeps {
  const deps: FleetSidebarDeps = { home }
  const schedule = ctx.get('fleetSchedule') as ScheduleService | undefined
  if (schedule !== undefined) deps.schedule = schedule
  const agents = ctx.get('fleetAgent') as FleetAgentService | undefined
  if (agents !== undefined) deps.agents = agents
  const teams = ctx.get('fleetTeams') as FleetTeamsService | undefined
  if (teams !== undefined) deps.teams = teams
  const budgets = ctx.get('fleetBudget') as FleetBudgetService | undefined
  if (budgets !== undefined) deps.budgets = budgets
  const policy = ctx.get('fleetPolicy') as FleetPolicyService | undefined
  if (policy !== undefined) deps.policy = policy
  return deps
}
