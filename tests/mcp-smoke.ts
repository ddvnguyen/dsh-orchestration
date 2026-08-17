/**
 * VERIFY (issue #20 bullet 3): MCP smoke test.
 * (a) In-process: a FleetMcpServer bound to ctx.fleet over a duplex,
 *     initialize → tools/list → tools/call (list/get_status/send_message/
 *     wait_for_agent).
 * (b) Cross-process: spawn the standalone dsh-fleet-mcp bin and run the real
 *     stdio client flow (tests/mcp-client.ts) against it.
 *
 * Run: pnpm test:mcp  (or)  tsx tests/mcp-smoke.ts
 * @module @hydra/dsh-fleet/tests/mcp-smoke
 */

import { assertPass, mountHeartbeat, mountHeartbeatWithSessions } from './harness.ts'
import { apply as applyMcp } from '../plugins/fleet-mcp/src/index.ts'
import { McpStdioClient, runMcpClientFlow } from './mcp-client.ts'

async function main(): Promise<void> {
  console.log('mcp-smoke: MCP server protocol (initialize, tools/list, tools/call)')

  // ---- (a) in-process server over a duplex ----
  {
    const { ctx, clock } = await mountHeartbeatWithSessions()
    applyMcp(ctx, {})
    const fleet = ctx.fleet
    const server = ctx.fleetMcp.createServer(fleet, { log: line => process.stderr.write(`  [server] ${line}\n`) })

    // Seed the registry so list/get_status/send_message have data.
    fleet.registerAgent('worker-1', 'dsh', { label: 'Worker One' })
    fleet.registerAgent('worker-2', 'dsh', { label: 'Worker Two' })

    // initialize
    const init = JSON.parse(await server.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    })) ?? '{}') as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } }
    assertPass('initialize returns protocol version + serverInfo', init.result?.protocolVersion === '2024-11-05'
      && init.result?.serverInfo?.name === 'dsh-fleet-mcp')

    // notifications/initialized -> no response
    const notified = await server.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/initialized',
    }))
    assertPass('notifications/initialized yields no response', notified === null)

    // tools/list
    const tools = JSON.parse(await server.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    })) ?? '{}') as { result?: { tools?: { name: string }[] } }
    const names = (tools.result?.tools ?? []).map(t => t.name)
    assertPass(
      'tools/list exposes the four fleet tools',
      ['fleet/list_agents', 'fleet/get_status', 'fleet/send_message', 'fleet/wait_for_agent'].every(n => names.includes(n)),
      JSON.stringify(names),
    )

    // tools/call fleet/list_agents
    const list = JSON.parse(await server.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'fleet/list_agents', arguments: {} },
    })) ?? '{}') as { result?: { structuredContent?: { agents?: unknown[] }; content?: { type: string; text: string }[] } }
    assertPass(
      'tools/call fleet/list_agents returns both agents',
      list.result?.structuredContent?.agents?.length === 2,
      JSON.stringify(list.result),
    )

    // tools/call fleet/get_status
    const status = JSON.parse(await server.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'fleet/get_status', arguments: { agentId: 'worker-1' } },
    })) ?? '{}') as { result?: { structuredContent?: { agent?: { status?: string } } } }
    assertPass(
      'tools/call fleet/get_status returns active worker-1',
      status.result?.structuredContent?.agent?.status === 'active',
    )

    // tools/call fleet/send_message
    const sent = JSON.parse(await server.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'fleet/send_message', arguments: { from: 'worker-1', to: 'worker-2', text: 'task: check builds' } },
    })) ?? '{}') as { result?: { structuredContent?: { state?: string; messageId?: string } } }
    assertPass(
      'tools/call fleet/send_message delivers',
      sent.result?.structuredContent?.state === 'delivered' && typeof sent.result?.structuredContent?.messageId === 'string',
    )

    // tools/call fleet/wait_for_agent: worker-2 makes progress during the wait
    const waitPromise = server.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'fleet/wait_for_agent', arguments: { agentId: 'worker-2', timeoutMs: 2_000, pollMs: 100 } },
    })).then(line => JSON.parse(line ?? '{}') as { result?: { structuredContent?: { ok?: boolean; reason?: string } } })
    await new Promise(resolve => setTimeout(resolve, 300)) // let the wait baseline settle
    clock.advance(1_000)
    fleet.heartbeat('worker-2', 'progress')
    const waited = await waitPromise
    assertPass(
      'tools/call fleet/wait_for_agent resolves on progress',
      waited.result?.structuredContent?.ok === true && waited.result?.structuredContent?.reason === 'progress',
      JSON.stringify(waited.result),
    )

    // invalid method -> JSON-RPC error
    const bad = JSON.parse(await server.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'bogus/method',
    })) ?? '{}') as { error?: { code?: number } }
    assertPass('unknown method yields JSON-RPC error', bad.error?.code === -32603)
  }

  // ---- (b) cross-process: real stdio client against the standalone bin ----
  {
    const tsxBin = new URL('../../external/deepseek-harness/node_modules/.bin/tsx', `file://${process.cwd()}/`).pathname
    const client = new McpStdioClient(tsxBin, [
      `${process.cwd()}/plugins/fleet-mcp/src/bin.ts`,
    ])
    const { initialized, tools, listAgents } = await runMcpClientFlow(client, () => { /* quiet */ })
    assertPass(
      'spawned bin: initialize ok',
      (initialized.result as { protocolVersion?: string } | undefined)?.protocolVersion === '2024-11-05',
      JSON.stringify(initialized),
    )
    assertPass(
      'spawned bin: tools/list ok',
      Array.isArray((tools.result as { tools?: unknown[] })?.tools) && (tools.result as { tools: unknown[] }).tools.length === 4,
    )
    assertPass(
      'spawned bin: tools/call fleet/list_agents ok',
      Array.isArray((listAgents.result as { content?: unknown[] })?.content),
    )
    client.close()
  }

  console.log('mcp-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`mcp-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
