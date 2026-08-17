#!/usr/bin/env node
/**
 * Standalone `fleet-agent-admin` bin (issue #26, orchestration-v3 §4.3):
 * a minimal node:http server serving the fleet-admin page + profile API for
 * headless or no-dsh use. Edits persist directly to
 * `$DSH_HOME/fleet/agent/profiles.json` via the FleetAgentService.
 *
 *   GET  /                        the admin page (HTML)
 *   GET  /health                  liveness + profile count
 *   GET  /api/agents              all profiles (JSON)
 *   POST /api/agents              create a profile (register)
 *   POST /api/agents/:id          update config (updateProfile)
 *   POST /api/agents/:id/disable  disable
 *   POST /api/agents/:id/enable   enable
 *
 * Usage: tsx plugins/fleet-agent/src/bin.ts [--port 3093] [--host 127.0.0.1]
 * Env: FLEET_AGENT_ADMIN_PORT / FLEET_AGENT_ADMIN_HOST / DSH_HOME
 * @module @hydra/dsh-fleet-agent/bin
 */

import { FleetAdminServer } from './server.ts'

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
  const server = new FleetAdminServer({ host, port })
  await server.listen()
  // eslint-disable-next-line no-console
  console.log(`fleet-agent-admin listening on http://${server.host}:${server.port} (${server.service.listProfiles().length} profiles)`)
  const shutdown = async (): Promise<void> => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`fleet-agent-admin fatal: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
