/**
 * Minimal MCP (Model Context Protocol) server core: JSON-RPC 2.0 over stdio,
 * exposing the fleet registry as MCP tools so ANY agent can list, query,
 * message, and wait on other fleet agents.
 *
 * dsh ships an MCP *client* (`@deepseek-ai/dsh-mcp-client`) but no in-repo MCP
 * *server*, so this implements the small protocol directly (initialize,
 * notifications/initialized, tools/list, tools/call) per the 2024-11-05 spec:
 * one JSON-RPC message per line, UTF-8, no Content-Length framing.
 *
 * The server is bound to a {@link FleetLike} (structural, so the plugin binds
 * ctx.fleet while the standalone bin builds its own registry). Transport is
 * injectable Readable/Writable for tests; the bin binds process.stdin/stdout.
 * @module @hydra/dsh-fleet/server
 */

import type { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import type { FleetLike } from '../../../src/service.ts'

/** Version advertised on initialize (MCP 2024-11-05 is the stdio baseline). */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

export interface McpToolSpec {
  name: string
  description: string
  inputSchema: JsonValue
}

export interface McpServerOptions {
  /** Log sink; defaults to no-op. Use stderr in the bin. */
  log?: (line: string) => void
  /** Fleet name reported to clients on initialize. */
  serverName?: string
  serverVersion?: string
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonRpcError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

function jsonRpcResult(id: string | number | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function toolResult(content: string, structuredContent: JsonValue, isError = false): JsonValue {
  const result: Record<string, JsonValue> = {
    content: [{ type: 'text', text: content }],
    structuredContent,
  }
  if (isError) result.isError = true
  return result as unknown as JsonValue
}

/** Strip `fleet_` prefixes for the raw MCP tool names (dsh-mcp-client namespace rule). */
export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: 'fleet/list_agents',
    description: 'List every agent currently in the fleet registry with id, kind, status, lastSeen, heartbeatCount.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fleet/get_status',
    description: 'Get the liveness view of one fleet agent (status active|stalled|offline, lastSeen, heartbeatCount).',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet/send_message',
    description: 'Send a text message from one registered agent to another. Records the message in both agents\' fleet ledgers and delivers it to the receiver when it has an onMessage hook.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender agent id (the calling agent should pass its own id).' },
        to: { type: 'string', description: 'Receiver agent id.' },
        text: { type: 'string', description: 'Message body.' },
      },
      required: ['from', 'to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet/wait_for_agent',
    description: 'Wait until a fleet agent shows progress (its lastSeen advances past the call-time baseline and it leaves stalled), or until timeoutMs elapses. Use to task another agent and block on its result.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Wait budget in ms (default 60000).' },
        pollMs: { type: 'number', description: 'Poll interval in ms (default 500).' },
      },
      required: ['agentId'],
      additionalProperties: false,
    },
  },
]

export class FleetMcpServer {
  private readonly fleet: FleetLike
  private readonly log: (line: string) => void
  private readonly serverName: string
  private readonly serverVersion: string

  constructor(fleet: FleetLike, options: McpServerOptions = {}) {
    this.fleet = fleet
    this.log = options.log ?? (() => { /* no-op */ })
    this.serverName = options.serverName ?? 'dsh-fleet-mcp'
    this.serverVersion = options.serverVersion ?? '0.0.1'
  }

  /** The tool specs this server advertises on tools/list. */
  tools(): readonly McpToolSpec[] {
    return MCP_TOOLS
  }

  /**
   * Handle one inbound JSON-RPC line. Returns the response line to write, or
   * `null` for notifications (which get no response). Exposed for tests and
   * for in-process duplex usage.
   */
  async handleLine(line: string): Promise<string | null> {
    let request: JsonRpcRequest
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
        throw new Error('invalid JSON-RPC request')
      }
      request = parsed as unknown as JsonRpcRequest
    } catch {
      return jsonRpcError(null, -32700, 'Parse error: invalid JSON-RPC request')
    }
    const id = request.id ?? null
    try {
      const result = await this.dispatch(request.method, request.params)
      if (result === undefined) return null // notification
      return jsonRpcResult(id, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = message.startsWith('invalid params:') ? -32602 : -32603
      this.log(`fleet-mcp: request "${request.method}" failed: ${message}`)
      return jsonRpcError(id, code, message)
    }
  }

  /**
   * Serve the stdio transport: read line-delimited JSON-RPC from `input`,
   * write responses to `output`. Resolves when input ends or closes.
   */
  start(input: Readable, output: Writable): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity })
    return new Promise((resolve, reject) => {
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (trimmed.length === 0) return
        void this.handleLine(trimmed)
          .then((response) => {
            if (response !== null) output.write(response + '\n')
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            output.write(jsonRpcError(null, -32603, message) + '\n')
          })
      })
      rl.on('close', resolve)
      rl.on('error', reject)
      output.on('error', reject)
    })
  }

  // ---- dispatch ----

  private async dispatch(method: string, params: unknown): Promise<JsonValue | undefined> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: this.serverName, version: this.serverVersion },
        }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined
      case 'tools/list':
        return { tools: MCP_TOOLS.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })) }
      case 'tools/call':
        return this.callTool(params)
      case 'ping':
        return {}
      default:
        throw new Error(`Method not found: ${method}`)
    }
  }

  private async callTool(params: unknown): Promise<JsonValue> {
    if (!isRecord(params) || typeof params.name !== 'string' || !isRecord(params.arguments)) {
      throw new Error('invalid params: tools/call requires { name, arguments }')
    }
    const name = params.name
    const args = params.arguments
    try {
      switch (name) {
        case 'fleet/list_agents': {
          const agents = this.fleet.listViews()
          const text = agents.length === 0
            ? 'No agents in the fleet.'
            : agents.map(view => `${view.id} [${view.kind}] ${view.status} lastSeen=${view.lastSeen} hb=${view.heartbeatCount}`).join('\n')
          return toolResult(text, { agents: agents as unknown as JsonValue })
        }
        case 'fleet/get_status': {
          const agentId = requireString(args, 'agentId')
          const view = this.fleet.getStatus(agentId)
          if (view === undefined) {
            return toolResult(`Unknown agent: ${agentId}`, { agent: null }, true)
          }
          return toolResult(
            `${view.id} [${view.kind}] ${view.status} lastSeen=${view.lastSeen} heartbeatCount=${view.heartbeatCount}`,
            { agent: view as unknown as JsonValue },
          )
        }
        case 'fleet/send_message': {
          const from = requireString(args, 'from')
          const to = requireString(args, 'to')
          const text = requireString(args, 'text')
          const message = this.fleet.sendMessage(from, to, text)
          return toolResult(
            `Message ${message.messageId} from ${message.from} to ${message.to}: ${message.state}`,
            message as unknown as JsonValue,
          )
        }
        case 'fleet/wait_for_agent': {
          const agentId = requireString(args, 'agentId')
          const timeoutMs = optionalNumber(args, 'timeoutMs', 60_000)
          const pollMs = optionalNumber(args, 'pollMs', 500)
          const result = await this.fleet.waitForAgent(agentId, { timeoutMs, pollMs })
          const text = result.ok
            ? `Agent ${agentId} made progress: ${result.agent?.status ?? 'gone'}`
            : `Timeout waiting for agent ${agentId}`
          return toolResult(text, result as unknown as JsonValue, !result.ok)
        }
        default:
          throw new Error(`Unknown tool: ${name}`)
      }
    } catch (error) {
      // Tool-level failures are tool results with isError, not JSON-RPC errors.
      const message = error instanceof Error ? error.message : String(error)
      return toolResult(`Error: ${message}`, { error: message } as JsonValue, true)
    }
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid params: "${key}" must be a non-empty string`)
  }
  return value
}

function optionalNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid params: "${key}" must be a positive number`)
  }
  return value
}
