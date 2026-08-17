#!/usr/bin/env node
/**
 * Standalone `fleet-settings-server` bin (issue #26, orchestration-v3 §4.4):
 * a minimal node:http server serving the sessions + fleet-settings page for
 * headless or no-dsh use. Composes its own fleet services over the same
 * durable dirs (grant-checks + persistence work standalone — the
 * fleet-agent-admin pattern).
 *
 *   GET  /                              the settings page (HTML, tabs)
 *   GET  /health                        liveness + store stats
 *   GET  /api/sessions                  ledger entries + status + archive flags
 *   POST /api/sessions/:id/resume       the session.prompt seam
 *   POST /api/sessions/:id/archive      overlay marker + workspace.archiveSession seam
 *   GET  /api/agents                    fleet-agent profiles
 *   POST /api/agents/:id[/disable|/enable]
 *   GET  /api/teams                     teams + rooms + members + grants
 *   POST /api/teams/:teamId/rooms/:roomId/settings
 *   GET  /api/budgets · POST /api/budgets
 *   GET  /api/policy  · POST /api/policy
 *
 * Usage: tsx plugins/fleet-settings/src/bin.ts [--port 3094] [--host 127.0.0.1] [--dsh-web-base-url http://127.0.0.1:3080]
 * Env: FLEET_SETTINGS_PORT / FLEET_SETTINGS_HOST / FLEET_SETTINGS_DSH_WEB_BASE_URL / DSH_HOME
 * @module @hydra/dsh-fleet-settings/bin
 */

import { FleetSettingsServer } from './server.ts'

function parseArgs(argv: string[]): { host?: string; port?: number; dshWebBaseUrl?: string } {
  const result: { host?: string; port?: number; dshWebBaseUrl?: string } = {}
  const read = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    return at !== -1 && at < argv.length - 1 ? argv[at + 1] : undefined
  }
  const host = read('--host')
  if (host !== undefined) result.host = host
  const port = read('--port')
  if (port !== undefined) {
    const parsed = Number.parseInt(port, 10)
    if (Number.isFinite(parsed)) result.port = parsed
  }
  const dshWebBaseUrl = read('--dsh-web-base-url') ?? process.env.FLEET_SETTINGS_DSH_WEB_BASE_URL
  if (dshWebBaseUrl !== undefined && dshWebBaseUrl.length > 0) result.dshWebBaseUrl = dshWebBaseUrl
  return result
}

async function main(): Promise<void> {
  const { host, port, dshWebBaseUrl } = parseArgs(process.argv.slice(2))
  const server = new FleetSettingsServer({ host, port, dshWebBaseUrl })
  await server.listen()
  // eslint-disable-next-line no-console
  console.log(`fleet-settings-server listening on http://${server.host}:${server.port} (sessions root ${server.service.ledger.sessionsRoot})`)
  const shutdown = async (): Promise<void> => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`fleet-settings-server fatal: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
