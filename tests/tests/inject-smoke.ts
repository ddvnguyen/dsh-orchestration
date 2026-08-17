/**
 * VERIFY (issue #20 bullet 4): fleet-inject smoke test.
 * Mounts fleet-heartbeat + fleet-inject, emits a fake `agent/created`, and
 * asserts (a) the four fleet tools were registered on the agent's SCOPED ctx,
 * (b) the agent was auto-registered into the fleet registry, (c) executing a
 * tool heartbeats the caller and talks to the registry, and (d) agent/disposed
 * marks the agent offline.
 *
 * Run: pnpm test:inject  (or)  tsx tests/inject-smoke.ts
 * @module @hydra/dsh-fleet/tests/inject-smoke
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertPass, mountHeartbeat } from './harness.ts'
import { apply as applyInject } from '../plugins/fleet-inject/src/index.ts'

interface FakeAgentCtx {
  tools: {
    register(def: ToolDefinition): () => void
  }
}

interface FakeAgent {
  id: string
  session: { id: string }
  ctx: FakeAgentCtx
  followup(): void
}

async function main(): Promise<void> {
  console.log('inject-smoke: fleet-inject auto-exposes fleet tools to in-process agents')

  const { ctx } = mountHeartbeat({ stallThresholdMs: 600_000 })
  const fleet = ctx.fleet

  const registeredTools = new Map<string, ToolDefinition>()
  const fakeAgentCtx: FakeAgentCtx = {
    tools: {
      register(def) {
        registeredTools.set(def.name, def)
        return () => { registeredTools.delete(def.name) }
      },
    },
  }
  const fakeAgent: FakeAgent = {
    id: 'fake-agent-1',
    session: { id: 'fake-session-1' },
    ctx: fakeAgentCtx,
    followup: () => { /* no-op for the smoke test */ },
  }

  applyInject(ctx, { tools: [], autoRegisterAgents: true, registerClaudeCodeFleetChildren: false, acpMcpServers: [] })
  // Re-apply with the default tool set is what the real composition does; the
  // Config default fills `tools` when the plugin is mounted via ctx.plugin.
  applyInject(ctx, { tools: ['fleet_list_agents', 'fleet_get_status', 'fleet_send_message', 'fleet_wait_for_agent'], autoRegisterAgents: true, registerClaudeCodeFleetChildren: false, acpMcpServers: [] })

  // ---- (a) agent/created injects the tools + registers the agent ----
  ctx.emit('agent/created', { agent: fakeAgent as never })
  const names = [...registeredTools.keys()]
  assertPass(
    'agent/created registers all four fleet tools on the agent scoped ctx',
    ['fleet_list_agents', 'fleet_get_status', 'fleet_send_message', 'fleet_wait_for_agent'].every(n => names.includes(n)),
    JSON.stringify(names),
  )

  const entry = fleet.registry.get('fake-agent-1')
  assertPass(
    'agent auto-registered in the fleet registry as dsh + sessionId',
    entry?.kind === 'dsh' && entry.sessionId === 'fake-session-1' && entry.status === 'active',
    JSON.stringify(entry),
  )

  // ---- (b) executing a tool heartbeats the caller and hits the registry ----
  const exec = { agent: fakeAgent as never }
  const send = registeredTools.get('fleet_send_message')!
  const target = fleet.registerAgent('worker-2', 'external', { label: 'Worker Two' })
  assertPass('target agent registered for the send', target.status === 'active')

  const before = entry!.heartbeatCount
  const result = await send.execute!({ to: 'worker-2', text: 'please run the build' }, exec as never) as {
    messageId?: string; from?: string; to?: string; state?: string
  }
  const after = fleet.registry.get('fake-agent-1')!.heartbeatCount
  assertPass(
    'fleet_send_message executes against the registry (delivered + caller heartbeated)',
    result.state === 'delivered' && result.from === 'fake-agent-1' && after > before,
    JSON.stringify(result),
  )

  const list = registeredTools.get('fleet_list_agents')!
  const listResult = await list.execute!({}, exec as never) as { agents?: unknown[] }
  assertPass(
    'fleet_list_agents returns the registered agents',
    Array.isArray(listResult.agents) && listResult.agents.length === 2,
    JSON.stringify(listResult),
  )

  // ---- (c) agent/disposed marks the agent offline ----
  ctx.emit('agent/disposed', { agent: fakeAgent as never })
  const offline = fleet.registry.get('fake-agent-1')
  assertPass('agent/disposed marks the agent offline', offline?.status === 'offline', JSON.stringify(offline))

  console.log('inject-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`inject-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
