/**
 * @hydra/dsh-fleet-settings — the companion /fleet-settings page (issue #26,
 * orchestration-v3 §4.4): sessions + fleet settings on the fleet HTTP server.
 *
 * The dsh settings dialog is NOT extensible (verified: settings.section /
 * settings.plugins.tab are client-side composition slots in the READ-ONLY web
 * bundle; no host→client slot transport — see
 * orchestration/state/fleet-settings-26.md), so this companion page is the
 * sanctioned settings surface for the fleet.
 *
 * Mounts the settings page + API on dsh's webServer as `/fleet-settings`
 * routes (the fleet-board webServer pattern — `ctx.webServer.register`,
 * research note in orchestration/state/fleet-board-26.md) when a webServer is
 * composed, and provides the same handlers for the standalone
 * `fleet-settings-server` bin (port 3094) for headless/no-dsh use.
 *
 * When composed, the settings sections consume the LIVE ctx services
 * (fleetAgent / fleetTeams / fleetBudget / fleetPolicy) so edits land in the
 * running fleet, not shadow copies; missing services degrade gracefully. The
 * session ledger + archive overlay are owned by this plugin over the same
 * `$DSH_HOME` (the fleet-family pattern).
 *
 * ```
 * - id: fleet-settings
 *   name: '@hydra/dsh-fleet-settings'
 *   config: {}
 * ```
 * @module @hydra/dsh-fleet-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createSettingsHandlers } from './server.ts'
import { createSettingsDeps } from './service.ts'
import { SessionLedger } from './sessions.ts'
import { SettingsOverlay } from './overlay.ts'
import { settingsPageHtml } from './page.ts'
import type { FleetAgentService } from '../../fleet-agent/src/service.ts'
import type { FleetTeamsService } from '../../fleet-teams/src/service.ts'
import type { FleetBudgetService } from '../../fleet-budget/src/service.ts'
import type { FleetPolicyService } from '../../fleet-policy/src/service.ts'

export const name = 'fleet-settings'
/**
 * Required deps: every service read via `ctx.get` at apply time is declared so
 * Cordis applies AFTER they exist — the settings page consumes the LIVE ctx
 * services (edits land in the running fleet, never shadow copies). The
 * standalone bin composes its own services over the same durable dirs
 * (Lessons.md 2026-08-16 injection-ordering class fix).
 */
export const inject = ['webServer', 'fleetAgent', 'fleetTeams', 'fleetBudget', 'fleetPolicy']

/** Plugin consumer configuration. */
export interface Config {
  /** Override the resolved DSH_HOME (test seam; defaults to the fleet default). */
  home?: string
  /** Base URL of the dsh web gateway (resume/archive execution). */
  dshWebBaseUrl?: string
}

export const Config: z<Config> = z.object({
  /** Override the resolved DSH_HOME (test seam; defaults to the fleet default). */
  home: z.string(),
  /** Base URL of the dsh web gateway (resume/archive execution). */
  dshWebBaseUrl: z.string(),
})

/** The webServer + fleet services the plugin reads optionally. */
interface SettingsWebDeps {
  webServer?: WebServer
  agents?: FleetAgentService
  teams?: FleetTeamsService
  budgets?: FleetBudgetService
  policy?: FleetPolicyService
}

export function apply(ctx: Context, config: Config): void {
  const ledger = new SessionLedger({ home: config.home })
  const overlay = new SettingsOverlay({ home: config.home })
  const deps = resolveSettings(ctx, config)

  // Compose the full settings dep set: the ctx services when composed, else
  // fresh instances over the same durable dirs (standalone pattern).
  const service = createSettingsDeps({
    home: config.home,
    dshWebBaseUrl: config.dshWebBaseUrl,
    deps: {
      ...(deps.agents !== undefined ? { agents: deps.agents } : {}),
      ...(deps.teams !== undefined ? { teams: deps.teams } : {}),
      ...(deps.budgets !== undefined ? { budgets: deps.budgets } : {}),
      ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
      ledger,
      overlay,
    },
  })

  if (deps.webServer !== undefined) {
    const pageHtml = settingsPageHtml('/fleet-settings/api')
    const handlers = createSettingsHandlers(service, pageHtml, '/fleet-settings', {
      svc: 'fleet-settings',
      storeDir: join(config.home ?? resolveDshHome(), 'fleet'),
    })
    const disposers: Array<() => void> = [
      deps.webServer.register({ kind: 'prefix', path: '/fleet-settings', handler: handlers.index }),
      deps.webServer.register({ kind: 'prefix', path: '/fleet-settings/health', handler: handlers.health }),
      deps.webServer.register({ kind: 'prefix', path: '/fleet-settings/api', handler: handlers.api }),
    ]
    ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'fleet-settings: webServer routes')
    ctx.logger.info('fleet-settings: mounted /fleet-settings on dsh webServer')
  } else {
    ctx.logger.info('fleet-settings: no webServer composed — serve standalone via fleet-settings-server (port 3094)')
  }
}

/** Resolve the optional fleet services + webServer (optional-service rule). */
function resolveSettings(ctx: Context, config: Config): SettingsWebDeps {
  const deps: SettingsWebDeps = {}
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer !== undefined) deps.webServer = webServer
  const agents = ctx.get('fleetAgent') as FleetAgentService | undefined
  if (agents !== undefined) deps.agents = agents
  const teams = ctx.get('fleetTeams') as FleetTeamsService | undefined
  if (teams !== undefined) deps.teams = teams
  const budgets = ctx.get('fleetBudget') as FleetBudgetService | undefined
  if (budgets !== undefined) deps.budgets = budgets
  const policy = ctx.get('fleetPolicy') as FleetPolicyService | undefined
  if (policy !== undefined) deps.policy = policy
  if (deps.agents === undefined && config.home !== undefined) {
    // No composed fleet-agent, but a data home is known: the standalone server
    // composes its own service over the same durable dirs.
    void config
  }
  return deps
}
