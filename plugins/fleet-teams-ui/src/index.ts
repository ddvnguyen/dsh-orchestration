/**
 * @hydra/dsh-fleet-teams-ui — the V3 teams chat UI (issue #26,
 * orchestration-v3 §4 P4.2): a fleet-hosted rooms page + team settings dialog
 * that RIDES ON the fleet HTTP surface, never touching the dsh web app (owner
 * constraint: the normal dsh chat UI stays the chat surface).
 *
 * Mounts the rooms page + API on dsh's webServer as `/fleet-teams-ui` routes
 * (the fleet-board webServer pattern — `ctx.webServer.register`, research note
 * in orchestration/state/fleet-board-26.md) when a webServer is composed, and
 * provides the same handlers for the standalone `fleet-teams-ui-server` bin
 * (port 3092) for headless/no-dsh use. Sender identity on every chat message
 * resolves from the fleet-agent profile registry
 * (`$DSH_HOME/fleet/agent/profiles.json`) via src/identity.ts; the chat
 * thread renders fleet/team-post bus events + the shared-room memory file
 * briefing; the composer posts grant-checked via `ctx.fleetTeams`.
 *
 * ```
 * - id: fleet-teams-ui
 *   name: '@hydra/dsh-fleet-teams-ui'
 *   config: {}        # reads the same $DSH_HOME the fleet-teams service uses
 * ```
 * @module @hydra/dsh-fleet-teams-ui
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createTeamsUiHandlers } from './server.ts'
import { ProfileStore } from './identity.ts'
import { TeamsUiOverlay } from './overlay.ts'
import { teamsUiPageHtml } from './page.ts'
import type { FleetTeamsService } from '../../fleet-teams/src/service.ts'

export const name = 'fleet-teams-ui'
/**
 * Required deps: `webServer` + `fleetTeams` are read via `ctx.get` at apply
 * time — Cordis defers apply until both exist so the /fleet-teams-ui routes
 * mount over the live team service (Lessons.md 2026-08-16).
 */
export const inject = ['fleetTeams', 'webServer']

/** Plugin consumer configuration. */
export interface Config {
  /** Override the resolved DSH_HOME (test seam; defaults to the fleet default). */
  home?: string
}

export const Config: z<Config> = z.object({
  /** Override the resolved DSH_HOME (test seam; defaults to the fleet default). */
  home: z.string(),
})

/** The webServer + fleet-teams surface the plugin reads optionally. */
interface TeamsUiWebDeps {
  teams?: FleetTeamsService
  webServer?: WebServer
}

export function apply(ctx: Context, config: Config): void {
  const overlay = new TeamsUiOverlay({ home: config.home })
  const profiles = new ProfileStore({ home: config.home })
  const deps = resolveTeams(ctx, config)
  const pageHtml = teamsUiPageHtml('/fleet-teams-ui')

  if (deps.teams !== undefined && deps.webServer !== undefined) {
    const handlers = createTeamsUiHandlers(
      { teams: deps.teams, overlay, profiles },
      pageHtml,
      '/fleet-teams-ui',
      { svc: 'fleet-teams-ui', storeDir: join(config.home ?? resolveDshHome(), 'fleet') },
    )
    const disposers: Array<() => void> = [
      deps.webServer.register({ kind: 'prefix', path: '/fleet-teams-ui', handler: handlers.index }),
      deps.webServer.register({ kind: 'prefix', path: '/fleet-teams-ui/health', handler: handlers.health }),
      deps.webServer.register({ kind: 'prefix', path: '/fleet-teams-ui/api', handler: handlers.api }),
    ]
    ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'fleet-teams-ui: webServer routes')
    ctx.logger.info('fleet-teams-ui: mounted /fleet-teams-ui on dsh webServer')
  } else {
    ctx.logger.info('fleet-teams-ui: no fleet-teams/webServer composed — serve standalone via fleet-teams-ui-server')
  }
}

/** Resolve the optional fleet-teams service + webServer (optional-service rule). */
function resolveTeams(ctx: Context, config: Config): TeamsUiWebDeps {
  const deps: TeamsUiWebDeps = {}
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer !== undefined) deps.webServer = webServer
  const teams = ctx.get('fleetTeams') as FleetTeamsService | undefined
  if (teams !== undefined) deps.teams = teams
  if (deps.teams === undefined && config.home !== undefined) {
    // No composed fleet-teams service, but a data home is known: the standalone
    // server composes its own service over the same durable dirs.
    void config
  }
  return deps
}
