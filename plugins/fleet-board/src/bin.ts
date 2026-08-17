#!/usr/bin/env node
/**
 * Standalone `fleet-board-server` bin (issue #26, orchestration-v3 §4 P1.1):
 * a minimal node:http server serving the fleet-board feed for headless or
 * no-dsh use. Reads the fleet-bus store directly — no dsh session dependency.
 *
 *   GET /events?limit=&since=&type=&scope=&actor=&originKind=   JSON feed
 *   GET /health                                                 liveness + store stats
 *   GET /                                                       the board HTML page
 *
 * Usage: tsx plugins/fleet-board/src/bin.ts [--port 3090] [--host 127.0.0.1]
 * Env: FLEET_BOARD_PORT / FLEET_BOARD_HOST / FLEET_BOARD_STORE_DIR /
 *      FLEET_BOARD_STORE_FILE
 * @module @hydra/dsh-fleet-board/bin
 */

import { FleetBoardServer } from './server.ts'

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
  const server = new FleetBoardServer({ host, port })
  await server.listen()
  // eslint-disable-next-line no-console
  console.log(`fleet-board-server listening on http://${server.host}:${server.port} (store ${server.storePath})`)
  const shutdown = async (): Promise<void> => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`fleet-board-server fatal: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
