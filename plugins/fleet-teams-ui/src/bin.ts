#!/usr/bin/env node
/**
 * Standalone `fleet-teams-ui-server` bin (issue #26, orchestration-v3 §4
 * P4.2): a minimal node:http server serving the rooms page + team-settings
 * API for headless or no-dsh use. Composes its own FleetTeamsService over the
 * same durable dirs (grant-checks + persistence work standalone — the
 * fleet-agent-admin pattern).
 *
 *   GET  /                              the rooms page (HTML)
 *   GET  /health                        liveness + store stats
 *   GET  /api/profiles                  registered fleet-agent profiles
 *   GET  /api/rooms                     teams + rooms + members + overlay
 *   GET  /api/rooms/:id                 room detail (memory, grants, scope, linked tasks)
 *   GET  /api/rooms/:id/messages?since= chat thread (team-post events + memory timeline)
 *   POST /api/rooms/:id/post            composer (grant-checked via fleet-teams)
 *   POST /api/rooms/:id/settings        settings-dialog mutations
 *
 * Usage: tsx plugins/fleet-teams-ui/src/bin.ts [--port 3092] [--host 127.0.0.1]
 * Env: FLEET_TEAMS_UI_PORT / FLEET_TEAMS_UI_HOST / DSH_HOME
 * @module @hydra/dsh-fleet-teams-ui/bin
 */

import { FleetTeamsUiServer } from './server.ts'

function parseArgs(argv: string[]): { host?: string; port?: number } {
  const result: { host?: string; port?: number } = {}
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
  return result
}

async function main(): Promise<void> {
  const { host, port } = parseArgs(process.argv.slice(2))
  const server = new FleetTeamsUiServer({ host, port })
  await server.listen()
  // eslint-disable-next-line no-console
  console.log(`fleet-teams-ui-server listening on http://${server.host}:${server.port} (${server.service.listRooms().length} rooms)`)
  const shutdown = async (): Promise<void> => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`fleet-teams-ui-server fatal: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
