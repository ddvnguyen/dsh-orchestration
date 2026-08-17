/**
 * VERIFY (issue #26): fleet-agent smoke test.
 *
 * Covers: register → ed25519 keypair generated + persisted (keys.json with
 * 0600 perms); sign → verify round-trip; tampered events fail verify;
 * attribution records appended (with verifiable signed evidence); reload from
 * disk preserves keys; the four agent tools are injected on agent/created
 * and execute against the registry; and the audit mirror lands in a real dsh
 * session log. P4.3 fleet-admin adds: runtime profile CRUD (updateProfile
 * persists overrides), disable → isEnabled false + the supervisor wake-consult
 * seam skips delivery (fleet/wake-skipped, entries stay pending), enable →
 * wakes flow again, restart reload → overrides survive, the four admin tools,
 * and the admin web server (page + profile API). No live LLM needed.
 *
 * Run: pnpm test:agent  (or)  tsx tests/agent-smoke.ts
 * @module @hydra/dsh-fleet/tests/agent-smoke
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { statSync } from 'node:fs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyIdentity, FLEET_AGENT_TOOL_NAMES, type Config as IdentityConfig } from '../plugins/fleet-agent/src/index.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import { FleetSupervisorService } from '../plugins/fleet-supervisor/src/service.ts'
import { FleetAdminServer } from '../plugins/fleet-agent/src/server.ts'
import { fakeClock, assertPass } from './harness.ts'

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fleet-agent-'))
}

function agentConfig(home: string, overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    home,
    tools: [...FLEET_AGENT_TOOL_NAMES],
    autoRegisterAgents: true,
    injectTools: true,
    ...overrides,
  }
}

async function fetchText(url: string): Promise<{ status: number; text: string; headers: Record<string, string | undefined> }> {
  const response = await fetch(url)
  const text = await response.text()
  const headers: Record<string, string | undefined> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  return { status: response.status, text, headers }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  return response.json() as Promise<unknown>
}

async function postJson(url: string, body: Record<string, unknown> | undefined): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return response.json() as Promise<unknown>
}

async function main(): Promise<void> {
  console.log('agent-smoke: fleet-agent profiles, ed25519 signed events, attribution')

  const home = await tempHome()
  try {
    // ---- 1. register → keypair generated + persisted (0600) ----
    {
      const ctx = new Context()
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent
      assert.ok(identity !== undefined, 'ctx.fleetAgent must be registered by fleet-agent')

      const profile = identity.register({ agentId: 'alice', name: 'Alice', role: 'lead' })
      assertPass('register returns a profile with a public key', profile.publicKey.length > 0, `pubkey=${profile.publicKey.slice(0, 16)}…`)

      const keysFile = join(home, 'fleet', 'agent', 'keys.json')
      const mode = statSync(keysFile).mode & 0o777
      assertPass('keys.json persisted with 0600 permissions', mode === 0o600, `mode=${mode.toString(8)}`)

      assertPass('profile publicKey matches the key store', identity.keyStore.publicKeyOf('alice') === profile.publicKey)
      assertPass('profile fields set', profile.name === 'Alice' && profile.role === 'lead' && profile.status === 'active')
      assertPass('getProfile / listProfiles consistent', identity.getProfile('alice')?.publicKey === profile.publicKey && identity.listProfiles().length === 1)
    }

    // ---- 2. sign → verify round-trip ----
    {
      const ctx = new Context()
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent
      identity.register({ agentId: 'bob', name: 'Bob', role: 'worker' })

      const signed = identity.sign({ type: 'fleet/task/complete', actor: 'bob', payload: { task: 'build', n: 1, ok: true, tags: ['a', 'b'] } })
      assertPass('sign returns envelope + sig + pubkey', signed.type === 'fleet/task/complete' && typeof signed.sig === 'string' && signed.pubkey === identity.getProfile('bob')!.publicKey)

      const result = identity.verify(signed)
      assertPass('verify accepts a genuine signed event', result.ok === true, JSON.stringify(result))
    }

    // ---- 3. tampered events fail verify ----
    {
      const ctx = new Context()
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent
      identity.register({ agentId: 'carol', name: 'Carol', role: 'worker' })
      const signed = identity.sign({ type: 'fleet/msg', actor: 'carol', payload: { text: 'hello' } })

      const tamperedPayload = { ...signed, payload: { text: 'you have been hacked' } }
      assertPass('tampered payload fails verify', identity.verify(tamperedPayload).ok === false, identity.verify(tamperedPayload).reason)

      const tamperedTs = { ...signed, ts: signed.ts + 1 }
      assertPass('tampered ts fails verify', identity.verify(tamperedTs).ok === false)

      const wrongPubkey = { ...signed, pubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
      assertPass('tampered pubkey fails verify', identity.verify(wrongPubkey).ok === false)

      const malformed = { type: signed.type, actor: signed.actor }
      assertPass('malformed event fails verify', identity.verify(malformed as never).ok === false)
    }

    // ---- 4. attribution records appended (signed evidence verifies) ----
    {
      const ctx = new Context()
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent
      identity.register({ agentId: 'dave', name: 'Dave', role: 'worker' })

      const record = identity.attribute('dave', 'register', 'fleet/agent')
      assertPass('attribute appends a record', record.actor === 'dave' && record.action === 'register' && record.target === 'fleet/agent' && record.seq === 0)
      assertPass('record signed evidence verifies', identity.verify(record.signed).ok === true, JSON.stringify(identity.verify(record.signed)))
      assertPass('audit() lists all', identity.audit().length === 1)
      assertPass('audit(agentId) filters', identity.audit('dave').length === 1 && identity.audit('nobody').length === 0)

      identity.attribute('dave', 'complete', 'task-9')
      assertPass('second record has seq 1', identity.audit('dave')[1].seq === 1 && identity.audit('dave')[1].action === 'complete')
    }

    // ---- 5. reload from disk preserves keys ----
    {
      const ctx1 = new Context()
      applyIdentity(ctx1, agentConfig(home))
      const first = ctx1.fleetAgent
      first.register({ agentId: 'erin', name: 'Erin', role: 'lead' })
      const firstPubkey = first.getProfile('erin')!.publicKey

      // A fresh process / context over the same home must see the SAME key.
      const ctx2 = new Context()
      applyIdentity(ctx2, agentConfig(home))
      const second = ctx2.fleetAgent
      const reloaded = second.register({ agentId: 'erin', name: 'Erin', role: 'lead' })
      assertPass('reload preserves the keypair', reloaded.publicKey === firstPubkey, `before=${firstPubkey.slice(0, 16)}… after=${reloaded.publicKey.slice(0, 16)}…`)
      assertPass('reload preserves createdAt', reloaded.createdAt === first.getProfile('erin')!.createdAt)

      // Cross-instance verification: sign in instance 2, verify in instance 1.
      const cross = second.sign({ type: 'fleet/relay', actor: 'erin', payload: { hop: 1 } })
      assertPass('cross-instance verify succeeds', first.verify(cross).ok === true, JSON.stringify(first.verify(cross)))
    }

    // ---- 6. tools injected on agent/created ----
    {
      const ctx = new Context()
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent

      const registeredTools = new Map<string, ToolDefinition>()
      const fakeAgentCtx = { tools: { register(def: ToolDefinition) { registeredTools.set(def.name, def); return () => { registeredTools.delete(def.name) } } } }
      const fakeAgent = { id: 'fake-who', session: { id: 'fake-session-who' }, ctx: fakeAgentCtx }
      ctx.emit('agent/created', { agent: fakeAgent as never })

      const names = [...registeredTools.keys()]
      assertPass(
        'agent/created injects the four agent tools',
        ['agent_whoami', 'agent_sign', 'agent_verify', 'agent_audit'].every(n => names.includes(n)),
        JSON.stringify(names),
      )
      assertPass('profile auto-registered on agent/created', identity.getProfile('fake-who') !== undefined)

      const exec = { agent: fakeAgent as never }
      const whoami = registeredTools.get('agent_whoami')!
      const whoamiResult = await whoami.execute!({}, exec as never) as { profile?: { agentId?: string; publicKey?: string } }
      assertPass('agent_whoami returns the caller profile + public key', whoamiResult.profile?.agentId === 'fake-who' && typeof whoamiResult.profile?.publicKey === 'string', JSON.stringify(whoamiResult))

      const sign = registeredTools.get('agent_sign')!
      const signResult = await sign.execute!({ type: 'fleet/tool-test', payload: { n: 2 } }, exec as never) as { event?: { type?: string; sig?: string; pubkey?: string } }
      assertPass('agent_sign signs as the caller', signResult.event?.type === 'fleet/tool-test' && typeof signResult.event?.sig === 'string' && signResult.event?.pubkey === whoamiResult.profile?.publicKey, JSON.stringify(signResult))
      assertPass('agent_sign output carries no private key material', JSON.stringify(signResult).includes('privateKey') === false)

      const verify = registeredTools.get('agent_verify')!
      const verifyResult = await verify.execute!({ event: signResult.event }, exec as never) as { ok?: boolean }
      assertPass('agent_verify accepts the signed event', verifyResult.ok === true, JSON.stringify(verifyResult))

      const audit = registeredTools.get('agent_audit')!
      await identity.attribute('fake-who', 'tool', 'test')
      const auditResult = await audit.execute!({}, exec as never) as { records?: unknown[] }
      assertPass('agent_audit lists attribution records', Array.isArray(auditResult.records) && auditResult.records.length >= 1, JSON.stringify(auditResult))
    }

    // ---- 7. audit mirror lands in a REAL dsh session log ----
    {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent
      assert.ok(ctx.sessions !== undefined, 'ctx.sessions must be mounted by the session store')

      identity.register({ agentId: 'frank', name: 'Frank', role: 'worker' })
      const session = ctx.sessions.create(SessionId('frank'), { meta: { cwd: '/tmp' } })
      identity.attribute('frank', 'register', 'fleet/agent')

      const auditEvent = session.events.find(event => event.type === 'fleet/audit')
      assertPass(
        'fleet/audit mirrored into the real session log',
        auditEvent !== undefined
          && auditEvent.data.actor === 'frank'
          && typeof auditEvent.data.sig === 'string'
          && typeof auditEvent.data.pubkey === 'string',
        JSON.stringify(session.events.map(event => event.type)),
      )
    }

    // ---- 8. P4.3 admin: profile CRUD persists overrides (survives reload) ----
    {
      const ctx = new Context()
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent

      const seeded = identity.register({
        agentId: 'grace', name: 'Grace', role: 'worker',
        claimRole: 'qa', cwd: '/workspace', tier: 't1', provider: 'claude/claude-sonnet-5',
        promptFile: 'prompts/grace.md', avatar: '#8957e5',
      })
      assertPass('register seeds the full agent-config surface',
        seeded.claimRole === 'qa' && seeded.tier === 't1' && seeded.provider === 'claude/claude-sonnet-5'
          && seeded.promptFile === 'prompts/grace.md' && seeded.avatar === '#8957e5' && seeded.enabled === true,
        JSON.stringify(seeded))

      const updated = identity.updateProfile('grace', { model: 'claude-3.7-sonnet', tier: 't2', avatar: '#1f6feb' })
      assertPass('updateProfile edits config fields at runtime',
        updated.model === 'claude-3.7-sonnet' && updated.tier === 't2' && updated.avatar === '#1f6feb',
        JSON.stringify(updated))
      assertPass('unset patch fields are unchanged',
        updated.provider === 'claude/claude-sonnet-5' && updated.role === 'worker' && updated.enabled === true,
        JSON.stringify(updated))
      assertPass('publicKey never changes across updates', updated.publicKey === seeded.publicKey)

      assert.throws(() => identity.updateProfile('nobody', { model: 'x' }), /no profile/)
      assert.throws(() => identity.disable('nobody'), /no profile/)

      // Restart reload: a fresh context over the same home sees the overrides.
      const ctx2 = new Context()
      applyIdentity(ctx2, agentConfig(home))
      const reloaded = ctx2.fleetAgent.getProfile('grace')!
      assertPass('config overrides survive restart reload',
        reloaded.model === 'claude-3.7-sonnet' && reloaded.tier === 't2' && reloaded.avatar === '#1f6feb'
          && reloaded.claimRole === 'qa' && reloaded.enabled === true,
        JSON.stringify(reloaded))
    }

    // ---- 9. P4.3 disabled semantics: isEnabled + the supervisor wake-consult ----
    {
      const ctx = new Context()
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent
      identity.register({ agentId: 'harry', name: 'Harry', role: 'worker' })
      assertPass('fresh profile is enabled', identity.isEnabled('harry') === true)
      assertPass('unregistered agents are NOT gated by default', identity.isEnabled('ghost') === true)

      identity.disable('harry')
      const disabled = identity.getProfile('harry')!
      assertPass('disable → isEnabled false + marked offline in the profile list',
        identity.isEnabled('harry') === false && disabled.enabled === false && disabled.status === 'offline',
        JSON.stringify(disabled))
      assertPass('listProfiles exposes the disabled state',
        identity.listProfiles().find(p => p.agentId === 'harry')?.enabled === false)

      // Re-registration must NOT be a back-door enable (agent/created hook path).
      identity.register({ agentId: 'harry', name: 'Harry', role: 'worker' })
      assertPass('re-register keeps the disabled override', identity.isEnabled('harry') === false)

      // The supervisor wake consult: mount fleet-bus + supervisor on the same
      // ctx, with the REAL fleet-agent service resolving via ctx.get.
      const clock = fakeClock()
      const deliveries: Array<{ agentId: string; mode: string }> = []
      const targets = new Map<string, { followup(): void; inject(): void }>()
      const bus = new FleetBusService(ctx, {
        storeDir: join(home, 'fleet'), clock, resolveAgent: id => targets.get(id),
      })
      const supervisor = new FleetSupervisorService(ctx, {
        clock, tickMs: 30_000, storeDir: join(home, 'fleet'),
        resolveAgent: id => targets.get(id),
      })
      targets.set('harry', {
        followup() { deliveries.push({ agentId: 'harry', mode: 'wake' }) },
        inject() { deliveries.push({ agentId: 'harry', mode: 'inject' }) },
      })

      supervisor.enqueueWake({ targetAgentId: 'harry', kind: 'cron', context: { job: 'x' } })
      await supervisor.runTick()
      assertPass('disabled agent receives NO wake', deliveries.length === 0, JSON.stringify(deliveries))
      assertPass('fleet/wake-skipped published with reason disabled',
        bus.replay({ type: 'fleet/wake-skipped' }).length === 1
          && (bus.replay({ type: 'fleet/wake-skipped' })[0]!.payload as { reason: string }).reason === 'disabled',
        JSON.stringify(bus.replay({ type: 'fleet/wake-skipped' }).map(e => e.payload)))
      assertPass('disabled agent\'s entries stay pending (flow once re-enabled)',
        supervisor.listWakeQueue().every(e => e.status === 'pending'),
        JSON.stringify(supervisor.listWakeQueue().map(e => e.status)))

      identity.enable('harry')
      assertPass('enable → isEnabled true + active again',
        identity.isEnabled('harry') === true && identity.getProfile('harry')!.status === 'active')

      await supervisor.runTick()
      assertPass('re-enabled agent receives the pending wake',
        deliveries.length === 1 && deliveries[0]!.agentId === 'harry', JSON.stringify(deliveries))
      assertPass('entries consumed after delivery', supervisor.listWakeQueue().every(e => e.status === 'woken'))
    }

    // ---- 10. P4.3 admin tools injected and execute ----
    {
      const ctx = new Context()
      applyIdentity(ctx, agentConfig(home))
      const identity = ctx.fleetAgent
      identity.register({ agentId: 'ivy', name: 'Ivy', role: 'worker' })

      const registeredTools = new Map<string, ToolDefinition>()
      const fakeAgentCtx = { tools: { register(def: ToolDefinition) { registeredTools.set(def.name, def); return () => { registeredTools.delete(def.name) } } } }
      const fakeAgent = { id: 'ivy', session: { id: 'ivy' }, ctx: fakeAgentCtx }
      ctx.emit('agent/created', { agent: fakeAgent as never })

      const names = [...registeredTools.keys()]
      assertPass('agent/created injects the four admin tools',
        ['agent_update', 'agent_disable', 'agent_enable', 'agent_list'].every(n => names.includes(n)),
        JSON.stringify(names))

      const exec = { agent: fakeAgent as never }
      const list = registeredTools.get('agent_list')!
      const listResult = await list.execute!({}, exec as never) as { count?: number; profiles?: Array<{ agentId?: string }> }
      assertPass('agent_list returns the profile registry',
        typeof listResult.count === 'number' && listResult.count! >= 1 && listResult.profiles!.some(p => p.agentId === 'ivy'),
        JSON.stringify(listResult))

      const update = registeredTools.get('agent_update')!
      const updateResult = await update.execute!({ agentId: 'ivy', model: 'gpt-5.4', tier: 't3' }, exec as never) as { profile?: { model?: string; tier?: string } }
      assertPass('agent_update edits config via tool',
        updateResult.profile?.model === 'gpt-5.4' && updateResult.profile?.tier === 't3',
        JSON.stringify(updateResult))

      const disable = registeredTools.get('agent_disable')!
      const disableResult = await disable.execute!({ agentId: 'ivy' }, exec as never) as { profile?: { enabled?: boolean } }
      assertPass('agent_disable flips enabled off',
        disableResult.profile?.enabled === false && identity.isEnabled('ivy') === false,
        JSON.stringify(disableResult))

      const enable = registeredTools.get('agent_enable')!
      const enableResult = await enable.execute!({ agentId: 'ivy' }, exec as never) as { profile?: { enabled?: boolean } }
      assertPass('agent_enable flips enabled back on',
        enableResult.profile?.enabled === true && identity.isEnabled('ivy') === true,
        JSON.stringify(enableResult))
      assertPass('admin tool output carries no private key material',
        [listResult, updateResult, disableResult, enableResult].every(r => JSON.stringify(r).includes('privateKey') === false))
    }

    // ---- 11. P4.3 admin server: page + profile API + webServer mount ----
    {
      const server = new FleetAdminServer({ port: 0, home })
      await server.listen()
      try {
        const base = `http://127.0.0.1:${server.port}`
        server.service.register({ agentId: 'jack', name: 'Jack', role: 'worker', model: 'deepseek-v3' })

        const page = await fetchText(base)
        assertPass('GET / serves the admin page',
          page.status === 200 && page.headers['content-type']!.includes('text/html') && page.text.includes('fleet-admin'),
          page.text.slice(0, 80))

        const health = await fetchJson(`${base}/health`) as { ok?: boolean; profiles?: number }
        assertPass('GET /health reports profile count',
          health.ok === true && typeof health.profiles === 'number' && health.profiles! >= 1, JSON.stringify(health))

        const listRes = await fetchJson(`${base}/api/agents`) as { count?: number; profiles?: Array<{ agentId?: string }> }
        assertPass('GET /api/agents lists profiles',
          listRes.count! >= 1 && listRes.profiles!.some(p => p.agentId === 'jack'), JSON.stringify(listRes))

        const updateRes = await postJson(`${base}/api/agents/jack`, { model: 'deepseek-v4', tier: 't2' }) as { ok?: boolean; profile?: { model?: string; tier?: string } }
        assertPass('POST /api/agents/:id updates config',
          updateRes.ok === true && updateRes.profile?.model === 'deepseek-v4' && updateRes.profile?.tier === 't2',
          JSON.stringify(updateRes))

        const disableRes = await postJson(`${base}/api/agents/jack/disable`, undefined) as { profile?: { enabled?: boolean } }
        assertPass('POST /api/agents/:id/disable works over HTTP',
          disableRes.profile?.enabled === false && server.service.isEnabled('jack') === false,
          JSON.stringify(disableRes))

        const enableRes = await postJson(`${base}/api/agents/jack/enable`, undefined) as { profile?: { enabled?: boolean } }
        assertPass('POST /api/agents/:id/enable works over HTTP',
          enableRes.profile?.enabled === true && server.service.isEnabled('jack') === true,
          JSON.stringify(enableRes))

        const createRes = await postJson(`${base}/api/agents`, { agentId: 'kate', name: 'Kate', provider: 'opencode/opencode-go/deepseek-v4-flash' }) as { ok?: boolean; profile?: { agentId?: string } }
        assertPass('POST /api/agents creates a profile',
          createRes.ok === true && createRes.profile?.agentId === 'kate' && server.service.getProfile('kate') !== undefined,
          JSON.stringify(createRes))

        const notFound = await fetchJson(`${base}/api/agents/nobody/disable`) as { ok?: boolean }
        assertPass('unknown agent id returns an error (not a crash)',
          notFound.ok === false, JSON.stringify(notFound))
      } finally {
        await server.close()
      }

      // Plugin surface: routes mounted on a dsh webServer.
      const mountedRoutes: Array<{ kind: string; path: string }> = []
      const ctx = new Context()
      ctx.reflect.provide('webServer', {
        register(route: { kind: 'exact' | 'prefix'; path: string }): () => void {
          mountedRoutes.push({ kind: route.kind, path: route.path })
          return () => { /* no-op test disposer */ }
        },
      } as never)
      applyIdentity(ctx, agentConfig(home))
      assertPass('plugin mounts /admin + /api/agents on the dsh webServer',
        mountedRoutes.some(r => r.path === '/admin' && r.kind === 'prefix')
          && mountedRoutes.some(r => r.path === '/api/agents' && r.kind === 'prefix')
          && mountedRoutes.some(r => r.path === '/admin/health' && r.kind === 'exact'),
        JSON.stringify(mountedRoutes))
    }

    console.log('agent-smoke: ALL PASS')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error(`agent-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
