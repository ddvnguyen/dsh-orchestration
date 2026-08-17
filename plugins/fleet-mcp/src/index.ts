/**
 * @hydra/dsh-fleet-mcp — MCP server over the shared ctx.fleet registry.
 *
 * The plugin registers `ctx.fleetMcp`, a factory for {@link FleetMcpServer}s
 * bound to the live ctx.fleet. In-process callers (same-process UI threads,
 * or the smoke test) drive a server through its injectable duplex; the
 * cross-process story is the standalone bin `dsh-fleet-mcp` (src/bin.ts),
 * which mounts the real fleet-heartbeat plugin on a fresh Context and serves
 * stdio.
 *
 * ACP wiring: the ACP protocol's `NewSessionRequest` accepts `mcpServers`, but
 * dsh's ACP server rejects a non-empty list
 * (external/deepseek-harness/packages/acp/acp/src/index.ts:435), so handing
 * this server to ACP children is blocked today — see the README for the
 * evidence and the seam to unblock.
 *
 * ```
 * - id: fleet-mcp
 *   name: '@hydra/dsh-fleet-mcp'
 * ```
 * @module @hydra/dsh-fleet-mcp
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FleetLike } from '../../../src/service.ts'
import { FleetMcpServer, type McpServerOptions } from './server.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetMcp: FleetMcpService
  }
}

export class FleetMcpService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fleetMcp')
  }

  /** Build an MCP server backed by the given fleet (defaults to ctx.fleet). */
  createServer(fleet?: FleetLike, options?: McpServerOptions): FleetMcpServer {
    return new FleetMcpServer(fleet ?? this.ctx.fleet, options)
  }
}

export const name = 'fleet-mcp'
export const inject = ['fleet']

export interface Config {}

export const Config: z<Config> = z.object({})

export function apply(ctx: Context, _config: Config): void {
  new FleetMcpService(ctx)
}
