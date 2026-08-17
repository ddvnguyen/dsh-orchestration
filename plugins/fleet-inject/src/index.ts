/**
 * @hydra/dsh-fleet-inject — auto-expose fleet tools to agents.
 *
 * For IN-PROCESS agents (the spawn/fork subagent backends, and the root agent
 * itself): listens on `agent/created` (packages/core/agent/src/runtime-types.ts
 * declares it; packages/core/agent-loop/src/agent.ts builds `agent.ctx` as the
 * scoped context) and registers the fleet tools on the agent's scoped registry
 * via `agent.ctx.tools.register(...)` — the documented "scope a registration to
 * one agent" seam (docs/subsystems/core.md; the tools registry scopes via
 * `scopeOf(ctx)` in packages/core/tools/src/index.ts). Every tool call
 * heartbeats the calling agent, so the fleet registry reflects real liveness.
 *
 * For ACP children (subagent-acp): the ACP protocol's `NewSessionRequest`
 * carries `mcpServers` (protocol + SDK support it), dsh's ACP client passes
 * `mcpServers: []` (packages/subagent/subagent-acp/src/run.ts:303), but dsh's
 * ACP SERVER rejects a non-empty list —
 * packages/acp/acp/src/index.ts:435 `validateSessionParams` throws
 * `'mcpServers is not supported'`. Handing the fleet MCP server to ACP children
 * is therefore blocked server-side today; the seam is documented in the README
 * with evidence. `config.acpMcpServers` is accepted and logged with a warning
 * (no-op wiring) so the deployment intent is explicit when the seam unblocks.
 * @module @hydra/dsh-fleet-inject
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import type { FleetLike } from '../../../src/service.ts'

/** Default tool set injected into every in-process agent. */
export const FLEET_TOOL_NAMES = [
  'fleet_list_agents',
  'fleet_get_status',
  'fleet_send_message',
  'fleet_wait_for_agent',
] as const

export type FleetToolName = (typeof FLEET_TOOL_NAMES)[number]

export interface AcpMcpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface Config {
  /** Which fleet tools to inject (default all four). */
  tools: string[]
  /** Auto-register agents into the fleet on agent/created (default true). */
  autoRegisterAgents: boolean
  /** Auto-register forked Claude Code fleet children into the fleet (default true). */
  registerClaudeCodeFleetChildren: boolean
  /**
   * Intent for ACP children: the fleet MCP server to pass via
   * `session/new.mcpServers`. NOT wired: dsh's ACP server rejects non-empty
   * mcpServers (packages/acp/acp/src/index.ts:435). Documented seam only.
   */
  acpMcpServers: AcpMcpServerConfig[]
}

export const Config: z<Config> = z.object({
  tools: z.array(z.string()).default([...FLEET_TOOL_NAMES]),
  autoRegisterAgents: z.boolean().default(true),
  registerClaudeCodeFleetChildren: z.boolean().default(true),
  acpMcpServers: z.array(z.object({
    command: z.string().required(),
    args: z.array(z.string()),
    env: z.dict(z.string()),
  })).default([]),
})

export const name = 'fleet-inject'
export const inject = ['fleet']

/** Narrow a JSON output value to a record for render-time shaping. */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

export function apply(ctx: Context, config: Config): void {
  const fleet = ctx.fleet
  const enabled = new Set<string>(config.tools)

  if (config.acpMcpServers.length > 0) {
    ctx.logger.warn(
      'fleet-inject: acpMcpServers is a documented seam only — dsh\'s ACP server rejects non-empty mcpServers '
      + '(external/deepseek-harness/packages/acp/acp/src/index.ts:435), so no ACP child was wired',
    )
  }

  // Register fleet tools on an agent's scoped context. Registration on
  // agent.ctx shadows globals for that agent only (core/tools register():
  // "Register globally or in the calling agent scope").
  const injectTools = (agentCtx: Context): void => {
    if (enabled.has('fleet_list_agents')) {
      agentCtx.tools.register(defineTool({
        name: 'fleet_list_agents',
        description: 'List every agent currently in the fleet registry: id, kind (dsh|acp|external), status (active|stalled|offline), lastSeen, heartbeatCount.',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const record = asRecord(value)
            const agents = Array.isArray(record?.agents) ? record.agents.length : 0
            return [{ type: 'text', text: `Fleet agents: ${agents} (see structuredContent for the full list)` }]
          },
        },
        execute: async (_args, exec) => {
          assertAgentCaller(exec.agent)
          fleet.ensureAgent(exec.agent.id, 'dsh', { sessionId: exec.agent.session.id })
          return { agents: fleet.listViews() } as unknown as JsonValue
        },
        presentCall: () => ({ card: 'generic', title: 'List fleet agents', kind: 'other', rawInput: null }),
      }))
    }
    if (enabled.has('fleet_get_status')) {
      agentCtx.tools.register(defineTool({
        name: 'fleet_get_status',
        description: 'Get the liveness view of one fleet agent: status (active|stalled|offline), lastSeen, heartbeatCount, kind.',
        parameters: {
          agentId: { type: 'string', required: true, description: 'The target agent id.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const record = asRecord(value)
            const agent = asRecord(record?.agent as JsonValue | undefined)
            const text = agent === undefined
              ? 'Unknown agent'
              : `${agent.id as string} [${agent.kind as string}] ${agent.status as string}`
            return [{ type: 'text', text }]
          },
        },
        execute: async (args, exec) => {
          assertAgentCaller(exec.agent)
          fleet.ensureAgent(exec.agent.id, 'dsh', { sessionId: exec.agent.session.id })
          const view = fleet.getStatus(args.agentId)
          return { agent: view ?? null } as unknown as JsonValue
        },
        presentCall: args => ({ card: 'generic', title: 'Get fleet agent status', kind: 'other', rawInput: args }),
      }))
    }
    if (enabled.has('fleet_send_message')) {
      agentCtx.tools.register(defineTool({
        name: 'fleet_send_message',
        description: 'Send a text message to another fleet agent. Records the message in both agents\' fleet ledgers; the receiver\'s onMessage hook delivers it (for dsh agents this surfaces as a follow-up turn in their inbox).',
        parameters: {
          to: { type: 'string', required: true, description: 'Receiver agent id.' },
          text: { type: 'string', required: true, description: 'Message body.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const record = asRecord(value)
            const text = record === undefined
              ? 'Message sent'
              : `Message ${record.messageId as string} from ${record.from as string} to ${record.to as string}: ${record.state as string}`
            return [{ type: 'text', text }]
          },
        },
        execute: async (args, exec) => {
          assertAgentCaller(exec.agent)
          fleet.ensureAgent(exec.agent.id, 'dsh', { sessionId: exec.agent.session.id })
          const message = fleet.sendMessage(exec.agent.id, args.to, args.text)
          return {
            messageId: message.messageId,
            from: message.from,
            to: message.to,
            state: message.state,
          }
        },
        presentCall: args => ({ card: 'generic', title: 'Send fleet message', kind: 'other', rawInput: args }),
      }))
    }
    if (enabled.has('fleet_wait_for_agent')) {
      agentCtx.tools.register(defineTool({
        name: 'fleet_wait_for_agent',
        description: 'Wait until another fleet agent shows progress (lastSeen advances past the call-time baseline and it leaves stalled) or timeoutMs elapses. Use to task an agent then block on its result.',
        parameters: {
          agentId: { type: 'string', required: true, description: 'Agent to wait on.' },
          timeoutMs: { type: 'integer', description: 'Wait budget in ms (default 60000).' },
          pollMs: { type: 'integer', description: 'Poll interval in ms (default 500).' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const record = asRecord(value)
            const agent = asRecord(record?.agent as JsonValue | undefined)
            const ok = record?.ok === true
            const text = ok
              ? `Agent ${agent?.id as string | undefined ?? ''} made progress (${agent?.status as string | undefined ?? 'gone'})`
              : `Timed out waiting for agent ${agent?.id as string | undefined ?? ''}`
            return [{ type: 'text', text }]
          },
        },
        execute: async (args, exec) => {
          assertAgentCaller(exec.agent)
          fleet.ensureAgent(exec.agent.id, 'dsh', { sessionId: exec.agent.session.id })
          const result = await fleet.waitForAgent(args.agentId, {
            timeoutMs: args.timeoutMs ?? 60_000,
            pollMs: args.pollMs ?? 500,
          })
          return {
            ok: result.ok,
            reason: result.reason,
            agent: result.agent ?? null,
          } as unknown as JsonValue
        },
        presentCall: args => ({ card: 'generic', title: 'Wait for fleet agent', kind: 'other', rawInput: args }),
      }))
    }
  }

  // Out-of-process Claude Code fleet children: register on run start and mark
  // offline when the run settles. Scope-filtered subagent lifecycle events
  // require a global listener (external/deepseek-harness/packages/subagent/subagent/src/invariant.ts:74).
  if (config.registerClaudeCodeFleetChildren) {
    ctx.on('subagent/start', (info) => {
      if (info.provider !== 'claude-code-fleet') return
      fleet.ensureAgent(String(info.id), 'claude-code', { sessionId: String(info.id) })
    }, { global: true })

    ctx.on('subagent/end', (info) => {
      if (info.provider !== 'claude-code-fleet') return
      fleet.markOffline(String(info.id))
    }, { global: true })
  }

  // In-process agents: register + inject on publication; mark offline on
  // disposal. Both events are declared in packages/core/agent/src/runtime-types.ts.
  ctx.on('agent/created', ({ agent }) => {
    if (config.autoRegisterAgents) {
      fleet.ensureAgent(agent.id, 'dsh', {
        label: agent.id,
        sessionId: agent.session.id,
        // Deliver cross-agent messages into the agent's inbox as a follow-up
        // turn (agent.followup is the public wake surface; see Agent in
        // packages/core/agent/src/types.ts).
        onMessage: (message) => {
          const target = ctx.agents.get(SessionId(message.to))
          if (target === undefined || target.id !== agent.id) return
          target.followup(createUserMessage({
            content: [{ type: 'text', text: `[fleet message from ${message.from}] ${message.text}` }],
            source: { kind: 'plugin', plugin: 'hydra/dsh-fleet' },
          }))
        },
      })
    }
    injectTools(agent.ctx)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    fleet.markOffline(agent.id)
  })
}

/** Scoped tools only run inside an agent; a caller without one has no id. */
function assertAgentCaller(agent: { id: string } | undefined): asserts agent is { id: string } {
  if (agent === undefined) {
    throw new Error('fleet tools require an owning agent session (registered scoped on agent.ctx)')
  }
}
