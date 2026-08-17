#!/usr/bin/env node
/**
 * Standalone `dsh-fleet-mcp` bin: an isolated fleet + MCP stdio server in one
 * process. Mounts the REAL fleet-heartbeat plugin on a fresh Cordis Context
 * (reusing its registry + session-mirror behavior) and serves the fleet tools
 * over stdio for any external MCP client.
 *
 * Usage:
 *   tsx plugins/fleet-mcp/src/bin.ts [--stall-threshold-ms 600000] [--tick-ms 30000]
 *
 * Environment override: FLEET_MCP_STALL_THRESHOLD_MS, FLEET_MCP_TICK_MS.
 * @module @hydra/dsh-fleet-mcp/bin
 */

import { Context } from '@deepseek-ai/cordis'
import { apply as applyHeartbeat } from '../../fleet-heartbeat/src/index.ts'
import { FleetMcpServer } from './server.ts'

async function main(): Promise<void> {
  const stallThresholdMs = Number(process.env.FLEET_MCP_STALL_THRESHOLD_MS ?? 10 * 60 * 1000)
  const tickMs = Number(process.env.FLEET_MCP_TICK_MS ?? 30_000)

  const ctx = new Context()
  applyHeartbeat(ctx, { stallThresholdMs, tickMs })

  const server = new FleetMcpServer(ctx.fleet, {
    log: (line) => { process.stderr.write(line + '\n') },
    serverName: 'dsh-fleet-mcp',
  })

  ctx.logger.info(`dsh-fleet-mcp serving ${server.tools().length} tools (stall threshold ${stallThresholdMs} ms)`)
  await server.start(process.stdin, process.stdout)
  process.exit(0)
}

void main().catch((error: unknown) => {
  process.stderr.write(`dsh-fleet-mcp fatal: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
