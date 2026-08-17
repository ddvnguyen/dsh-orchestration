#!/usr/bin/env node
/**
 * Minimal MCP stdio CLIENT for the fleet MCP server (VERIFY bullet 3): spawns
 * the standalone `dsh-fleet-mcp` bin, initializes, lists tools, and calls
 * `fleet/list_agents` against the stdio server — proving the JSON-RPC protocol
 * end-to-end across processes.
 *
 * Run: tsx tests/mcp-client.ts [--spawn-args ...]
 * @module @hydra/dsh-fleet/tests/mcp-client
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface McpClientResponse {
  id?: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

/** One in-flight request tracked by id; responses resolve as they arrive. */
export class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly rl: ReturnType<typeof createInterface>
  private readonly pending = new Map<string | number, (r: McpClientResponse) => void>()
  private readonly notifications: string[] = []
  private nextId = 1
  private closed = false

  constructor(command: string, args: string[], env: Record<string, string> = {}) {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', chunk => { process.stderr.write(`[fleet-mcp stderr] ${String(chunk)}`) })
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.rl.on('line', (line) => {
      let parsed: { id?: string | number | null; result?: unknown; error?: { code: number; message: string } }
      try {
        parsed = JSON.parse(line)
      } catch {
        process.stderr.write(`[fleet-mcp client] non-JSON line: ${line}\n`)
        return
      }
      if (parsed.id === undefined) {
        this.notifications.push(line)
        return
      }
      const resolve = this.pending.get(parsed.id as string | number)
      if (resolve !== undefined) {
        this.pending.delete(parsed.id as string | number)
        resolve(parsed)
      }
    })
    this.child.on('close', (code) => {
      this.closed = true
      for (const resolve of this.pending.values()) {
        resolve({ error: { code: -32000, message: `server closed (code ${code})` } })
      }
      this.pending.clear()
    })
  }

  request(method: string, params?: unknown): Promise<McpClientResponse> {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.child.stdin.write(JSON.stringify(payload) + '\n')
    })
  }

  notify(method: string, params?: unknown): void {
    const payload = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
    this.child.stdin.write(JSON.stringify(payload) + '\n')
  }

  close(): void {
    if (this.closed) return
    this.child.stdin.end()
    this.child.kill()
  }
}

/** Full client flow used by both the smoke test and the standalone runner. */
export async function runMcpClientFlow(client: McpStdioClient, log = (line: string) => console.log(line)): Promise<{
  initialized: McpClientResponse
  tools: McpClientResponse
  listAgents: McpClientResponse
}> {
  const initialized = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fleet-smoke-client', version: '0.0.1' },
  })
  client.notify('notifications/initialized')
  const tools = await client.request('tools/list')
  const listAgents = await client.request('tools/call', {
    name: 'fleet/list_agents',
    arguments: {},
  })
  log(`initialize -> ${JSON.stringify(initialized.result ?? initialized.error)}`)
  log(`tools/list -> ${JSON.stringify((tools.result as { tools?: { name: string }[] })?.tools?.map(t => t.name) ?? tools.error)}`)
  log(`tools/call fleet/list_agents -> ${JSON.stringify(listAgents.result ?? listAgents.error)}`)
  return { initialized, tools, listAgents }
}

// Standalone entry: spawn the bin and run the flow.
if (import.meta.url === `file://${process.argv[1]}`) {
  const tsxBin = new URL('../../external/deepseek-harness/node_modules/.bin/tsx', `file://${process.cwd()}/`).pathname
  const client = new McpStdioClient(tsxBin, [
    `${process.cwd()}/plugins/fleet-mcp/src/bin.ts`,
  ])
  const result = await runMcpClientFlow(client)
  const ok = result.initialized.result !== undefined
    && (result.tools.result as { tools?: unknown[] })?.tools !== undefined
    && (result.listAgents.result as { content?: unknown[] })?.content !== undefined
  client.close()
  process.exit(ok ? 0 : 1)
}
