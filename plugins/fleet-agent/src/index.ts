/**
 * @hydra/dsh-fleet-agent — per-agent identity + agent config + ed25519-signed
 * fleet events + actor attribution.
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`, see `@deepseek-ai/dsh-tool-todo` as
 * the registration template). It constructs the {@link FleetAgentService}
 * (registers `ctx.fleetAgent`), auto-registers a profile on `agent/created`
 * (minting a persisted ed25519 keypair the first time, exactly the hook
 * fleet-inject uses), and injects the agent tools onto each in-process
 * agent's scoped context (`agent.ctx.tools.register`, the same "scope a
 * registration to one agent" seam fleet-inject uses). P4.3 (fleet-admin)
 * adds the admin tools (agent_update/agent_disable/agent_enable/agent_list)
 * and — when a dsh webServer is composed — mounts the admin page + profile
 * API as `/admin` + `/api/agents` routes (the fleet-board webServer pattern).
 *
 * ```
 * - id: fleet-agent
 *   name: '@hydra/dsh-fleet-agent'
 *   config:
 *     autoRegisterAgents: true   # register a profile on agent/created
 *     injectTools: true          # inject the agent tools on agent/created
 * ```
 *
 * Key material never leaves the key store: tools and events expose the public
 * key only (`agent_whoami`, `agent_sign` output, `agent_verify` input).
 * @module @hydra/dsh-fleet-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '../../../src/types.ts'
import { getRosterProfile } from '../../../team/roster.ts'
import { FleetAgentService, type FleetSignedEvent, type FleetAgentConfig, type FleetProfilePatch, resolveAgentPreset } from './service.ts'
import { createAdminHandlers } from './server.ts'

/** Default tool set injected into every in-process agent. */
export const FLEET_AGENT_TOOL_NAMES = [
  'agent_whoami',
  'agent_sign',
  'agent_verify',
  'agent_audit',
  'agent_update',
  'agent_disable',
  'agent_enable',
  'agent_list',
] as const

export type FleetAgentToolName = (typeof FLEET_AGENT_TOOL_NAMES)[number]

export interface Config extends FleetAgentConfig {
  /** Which agent tools to inject (default all four). */
  tools: string[]
  /** Auto-register a profile on agent/created (default true). */
  autoRegisterAgents: boolean
  /** Inject the agent tools on agent/created (default true). */
  injectTools: boolean
}

export const Config: z<Config> = z.object({
  home: z.string(),
  clock: z.any(),
  tools: z.array(z.string()).default([...FLEET_AGENT_TOOL_NAMES]),
  autoRegisterAgents: z.boolean().default(true),
  injectTools: z.boolean().default(true),
})

export const name = 'fleet-agent'
/**
 * Required deps: `webServer` is read via `ctx.get` at apply time to mount the
 * /admin + /api/agents routes — Cordis defers apply until the service exists
 * (Lessons.md 2026-08-16: fleet-board/fleet-agent no-mount injection ordering).
 */
export const inject = ['webServer', 'tools']

export function apply(ctx: Context, config: Config): void {
  const agent = new FleetAgentService(ctx, config)
  const enabled = new Set<string>(config.tools)

  // P4.3 fleet-admin: when a dsh webServer is composed, mount the admin page
  // and the profile API (same handlers the standalone `fleet-agent-admin` bin
  // serves). Optional service access (AGENTS.md): webServer is only composed
  // by the web-app bundle.
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer !== undefined) {
    const handlers = createAdminHandlers(agent, undefined, {
      svc: 'fleet-agent',
      storeDir: join(config.home ?? resolveDshHome(), 'fleet'),
    })
    const disposers: Array<() => void> = [
      webServer.register({ kind: 'prefix', path: '/admin', handler: handlers.index }),
      webServer.register({ kind: 'prefix', path: '/api/agents', handler: handlers.api }),
      webServer.register({ kind: 'exact', path: '/admin/health', handler: handlers.health }),
    ]
    ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'fleet-agent: admin webServer routes')
    ctx.logger.info('fleet-agent: mounted /admin + /api/agents on dsh webServer')
  }

  // Auto-register a profile (minting + persisting the ed25519 keypair on first
  // contact) and inject the agent tools — the same agent/created hook
  // fleet-inject uses (packages/core/agent/src/runtime-types.ts declares it).
  // Store mapping from DSH session agent ID → fleet role agent ID.
  // The agent/created hook populates this; tools use it to resolve the
  // fleet identity for exec.agent.id (which is the DSH session UUID, not
  // the fleet role).
  const sessionToFleet = new Map<string, string>()

  ctx.on('agent/created', ({ agent: createdAgent }) => {
    const presetToRole: Record<string, { agentId: string; name: string; role: string }> = {
      'fleet-lead': { agentId: 'lead', name: 'Lead', role: 'lead' },
      'fleet-arch': { agentId: 'arch', name: 'Architect', role: 'arch' },
      'fleet-dev-1': { agentId: 'dev-1', name: 'Developer 1', role: 'dev-1' },
      'fleet-dev-2': { agentId: 'dev-2', name: 'Developer 2', role: 'dev-2' },
      'fleet-devops': { agentId: 'devops', name: 'Devops', role: 'devops' },
      'fleet-qa': { agentId: 'qa', name: 'QA', role: 'qa' },
    }

    // Read preset from scope chain (composedPreset) first — it IS available at
    // agent/created time because the preset mount happens in setup before
    // publication. Fall back to session header for backward compatibility.
    // resolveAgentPreset lives in service.ts to satisfy the inject lint.
    const preset = resolveAgentPreset(createdAgent.ctx, createdAgent.session?.header)
    const rosterEntry = preset !== undefined ? presetToRole[preset] : undefined
    if (rosterEntry !== undefined) {
      agent.register(rosterEntry)
      sessionToFleet.set(createdAgent.id, rosterEntry.agentId)
    } else if (config.autoRegisterAgents) {
      agent.register({ agentId: createdAgent.id, name: createdAgent.id, role: 'agent' })
      sessionToFleet.set(createdAgent.id, createdAgent.id)
    }

    if (config.injectTools) {
      injectTools(createdAgent.ctx, agent, enabled, sessionToFleet)
    }
  })
}

function injectTools(agentCtx: Context, agent: FleetAgentService, enabled: Set<string>, sessionToFleet: Map<string, string>): void {
  // Helper: resolve exec.agent.id → fleet agentId via the mapping
  function resolveFleetId(agentId: string): string {
    return sessionToFleet.get(agentId) ?? agentId
  }

  if (enabled.has('agent_whoami')) {
    agentCtx.tools.register(defineTool({
      name: 'agent_whoami',
      description: 'Return the calling agent\'s fleet profile: agentId, name, role, status, createdAt, and the ed25519 public key. Registers a fresh profile (and mints its keypair) on first use. Public key only — private keys are never exposed.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = asRecord(value)
          const profile = asRecord(record?.profile as JsonValue | undefined)
          const text = profile === undefined
            ? 'No agent profile'
            : `fleet agent: ${String(profile.agentId)} (${String(profile.role)}) pubkey=${String(profile.publicKey).slice(0, 16)}…`
          return [{ type: 'text', text }]
        },
      },
      execute: async (_args, exec) => {
        assertAgentCaller(exec.agent)
        const fleetId = resolveFleetId(exec.agent.id)
        const profile = agent.getProfile(fleetId) ?? agent.register({ agentId: fleetId })
        return JSON.parse(JSON.stringify({ profile })) as JsonValue
      },
      presentCall: () => ({ card: 'generic', title: 'Fleet agent (whoami)', kind: 'other', rawInput: null }),
    }))
  }
  if (enabled.has('agent_sign')) {
    agentCtx.tools.register(defineTool({
      name: 'agent_sign',
      description: 'Sign a JSON payload as the calling agent using its ed25519 private key. Returns the full signed event {type, actor, payload, ts, sig, pubkey} — public key and signature only, never the private key.',
      parameters: {
        type: { type: 'string', required: true, description: 'Event type label (e.g. "fleet/task/complete").' },
        payload: { type: 'json', required: true, description: 'Arbitrary JSON payload to sign.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = asRecord(value)
          const event = asRecord(record?.event as JsonValue | undefined)
          const text = event === undefined
            ? 'Signing failed'
            : `Signed ${String(event.type)} by ${String(event.actor)} pubkey=${String(event.pubkey).slice(0, 16)}…`
          return [{ type: 'text', text }]
        },
      },
      execute: async (args, exec) => {
        assertAgentCaller(exec.agent)
        const event = agent.sign({ type: args.type, actor: resolveFleetId(exec.agent.id), payload: args.payload })
        return JSON.parse(JSON.stringify({ event })) as JsonValue
      },
      presentCall: args => ({ card: 'generic', title: 'Sign fleet event', kind: 'other', rawInput: args }),
    }))
  }
  if (enabled.has('agent_verify')) {
    agentCtx.tools.register(defineTool({
      name: 'agent_verify',
      description: 'Verify a signed fleet event {type, actor, payload, ts, sig, pubkey}: ed25519 signature check plus, when the actor has a registered profile, pubkey-to-profile match. Returns {ok, reason?}.',
      parameters: {
        event: { type: 'json', required: true, description: 'The signed event object to verify.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = asRecord(value)
          const ok = record?.ok === true
          const reason = typeof record?.reason === 'string' ? ` (${record.reason})` : ''
          return [{ type: 'text', text: ok ? 'Signature valid' : `Signature invalid${reason}` }]
        },
      },
      execute: async (args, exec) => {
        assertAgentCaller(exec.agent)
        const result = agent.verify(args.event as unknown as FleetSignedEvent)
        return JSON.parse(JSON.stringify(result)) as JsonValue
      },
      presentCall: args => ({ card: 'generic', title: 'Verify fleet event', kind: 'other', rawInput: args }),
    }))
  }
  if (enabled.has('agent_audit')) {
    agentCtx.tools.register(defineTool({
      name: 'agent_audit',
      description: 'List attribution records (who did what when) from the fleet agent audit ledger — all records, or only those of one agent. Each record carries its ed25519-signed evidence.',
      parameters: {
        agentId: { type: 'string', description: 'Optional agent id; omit for all attribution records.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = asRecord(value)
          const count = Array.isArray(record?.records) ? record.records.length : 0
          return [{ type: 'text', text: `Attribution records: ${count}` }]
        },
      },
      execute: async (args, exec) => {
        assertAgentCaller(exec.agent)
        const records = agent.audit(args.agentId)
        return JSON.parse(JSON.stringify({ records })) as JsonValue
      },
      presentCall: args => ({ card: 'generic', title: 'Fleet audit log', kind: 'other', rawInput: args }),
    }))
  }
  if (enabled.has('agent_update')) {
    agentCtx.tools.register(defineTool({
      name: 'agent_update',
      description: 'P4.3 fleet-admin: update an agent profile\'s runtime config (name/avatar/role/claimRole/cwd/tier/provider/model/promptFile/enabled). Changes persist as overrides in profiles.json and survive restarts. Keys are never touched.',
      parameters: {
        agentId: { type: 'string', required: true, description: 'Agent id to update (defaults to the caller).' },
        name: { type: 'string', description: 'Human label.' },
        avatar: { type: 'string', description: 'Avatar hint (color hex or initial).' },
        role: { type: 'string', description: 'Role in the fleet (free-form).' },
        claimRole: { type: 'string', description: 'Org-chart role routed to this agent by claimWake.' },
        cwd: { type: 'string', description: 'Workspace the agent works in.' },
        tier: { type: 'string', description: 'Provider tier (e.g. t1/t2).' },
        provider: { type: 'string', description: 'Provider/model string (e.g. claude/claude-sonnet-5).' },
        model: { type: 'string', description: 'Model id within the provider.' },
        promptFile: { type: 'string', description: 'Prompt file for this agent.' },
        enabled: { type: 'boolean', description: 'Whether the agent may be woken / claim work (prefer agent_disable/agent_enable).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = asRecord(value)
          const profile = asRecord(record?.profile as JsonValue | undefined)
          return [{ type: 'text', text: `Updated ${profile === undefined ? '?' : String(profile.agentId)}` }]
        },
      },
      execute: async (args, exec) => {
        assertAgentCaller(exec.agent)
        const profile = agent.updateProfile(args.agentId ?? resolveFleetId(exec.agent.id), buildPatch(args))
        return JSON.parse(JSON.stringify({ profile })) as JsonValue
      },
      presentCall: args => ({ card: 'generic', title: 'Update fleet agent', kind: 'other', rawInput: args }),
    }))
  }
  if (enabled.has('agent_disable')) {
    agentCtx.tools.register(defineTool({
      name: 'agent_disable',
      description: 'P4.3 fleet-admin: disable an agent — its wakes are skipped (fleet-supervisor consult seam) and it is marked offline in profile lists. Persisted; re-enable with agent_enable.',
      parameters: {
        agentId: { type: 'string', required: true, description: 'Agent id to disable (defaults to the caller).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = asRecord(value)
          const profile = asRecord(record?.profile as JsonValue | undefined)
          return [{ type: 'text', text: `Disabled ${profile === undefined ? '?' : String(profile.agentId)}` }]
        },
      },
      execute: async (args, exec) => {
        assertAgentCaller(exec.agent)
        const profile = agent.disable(args.agentId ?? resolveFleetId(exec.agent.id))
        return JSON.parse(JSON.stringify({ profile })) as JsonValue
      },
      presentCall: args => ({ card: 'generic', title: 'Disable fleet agent', kind: 'other', rawInput: args }),
    }))
  }
  if (enabled.has('agent_enable')) {
    agentCtx.tools.register(defineTool({
      name: 'agent_enable',
      description: 'P4.3 fleet-admin: re-enable a disabled agent — wake delivery and claims reopen. Persisted.',
      parameters: {
        agentId: { type: 'string', required: true, description: 'Agent id to enable (defaults to the caller).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = asRecord(value)
          const profile = asRecord(record?.profile as JsonValue | undefined)
          return [{ type: 'text', text: `Enabled ${profile === undefined ? '?' : String(profile.agentId)}` }]
        },
      },
      execute: async (args, exec) => {
        assertAgentCaller(exec.agent)
        const profile = agent.enable(args.agentId ?? resolveFleetId(exec.agent.id))
        return JSON.parse(JSON.stringify({ profile })) as JsonValue
      },
      presentCall: args => ({ card: 'generic', title: 'Enable fleet agent', kind: 'other', rawInput: args }),
    }))
  }
  if (enabled.has('agent_list')) {
    agentCtx.tools.register(defineTool({
      name: 'agent_list',
      description: 'P4.3 fleet-admin: list every registered fleet-agent profile — agentId, name, role, status, enabled, tier, provider, model, promptFile (public fields only, never key material).',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = asRecord(value)
          const count = Array.isArray(record?.profiles) ? record.profiles.length : 0
          return [{ type: 'text', text: `Fleet agents: ${count}` }]
        },
      },
      execute: async (_args, exec) => {
        assertAgentCaller(exec.agent)
        const profiles = agent.listProfiles()
        return JSON.parse(JSON.stringify({ count: profiles.length, profiles })) as JsonValue
      },
      presentCall: () => ({ card: 'generic', title: 'List fleet agents', kind: 'other', rawInput: null }),
    }))
  }
}

/** Build an updateProfile patch from tool args (absent args = unchanged). */
function buildPatch(args: Record<string, unknown>): FleetProfilePatch {
  const patch: FleetProfilePatch = {}
  const keys = [
    'name', 'avatar', 'role', 'claimRole', 'cwd', 'tier', 'provider', 'model', 'promptFile', 'enabled',
  ] as const
  for (const key of keys) {
    const value = args[key]
    if (value !== undefined && value !== null) (patch as Record<string, unknown>)[key] = value
  }
  return patch
}

/** Narrow a JSON output value to a record for render-time shaping. */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Scoped tools only run inside an agent; a caller without one has no id. */
function assertAgentCaller(agent: { id: string } | undefined): asserts agent is { id: string } {
  if (agent === undefined) {
    throw new Error('fleet agent tools require an owning agent session (registered scoped on agent.ctx)')
  }
}
