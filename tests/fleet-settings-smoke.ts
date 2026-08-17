/**
 * VERIFY (issue #26): fleet-settings smoke test — the P4.4 companion
 * /fleet-settings page (sessions + fleet settings) rides on the fleet HTTP
 * surface.
 *
 * Covers: (1) SESSION LEDGER STATUS — the Sessions tab lists the dsh session
 * ledger ($DSH_HOME/sessions, real zstd JSONL written through the canonical
 * JsonlSessionPersistence write path) with per-log status (open turn →
 * running, closed turn → done, no turn → idle) + title + updatedAt; (2) the
 * RESUME SEAM — POST resume returns the session.prompt RPC payload and, when a
 * dsh web base URL is configured, EXECUTES it against a captured gateway
 * (accepted=true, the envelope targets /api/session.prompt with mode queue);
 * (3) the ARCHIVE SEAM — POST archive marks/removes via the durable overlay AND
 * fires the workspace.archiveSession RPC; (4) ONE FLEET SETTING EDIT PERSISTS —
 * a budget cap set through /api/budgets (and an agent model edit) survives a
 * service restart (SQLite + profiles.json); (5) the HTTP surface (/, /health,
 * /api/sessions, /api/agents, /api/teams, /api/budgets, /api/policy) + the
 * plugin webServer route mounting. No live LLM, no live dsh host.
 *
 * Run: pnpm test:settings  (or)  tsx tests/fleet-settings-smoke.ts
 * @module @hydra/dsh-fleet/tests/fleet-settings-smoke
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { assertPass } from './harness.ts'
import { FleetSettingsServer, createSettingsHandlers } from '../plugins/fleet-settings/src/server.ts'
import { SessionLedger } from '../plugins/fleet-settings/src/sessions.ts'
import { SettingsOverlay } from '../plugins/fleet-settings/src/overlay.ts'
import { apply as applySettings } from '../plugins/fleet-settings/src/index.ts'
import { createSettingsDeps } from '../plugins/fleet-settings/src/service.ts'

/** Write a seeded fleet-agent profile registry (agents tab). */
function seedProfiles(home: string, entries: Array<{ agentId: string; name: string; role: string; model?: string }>): void {
  const dir = join(home, 'fleet', 'agent')
  mkdirSync(dir, { recursive: true })
  const profiles: Record<string, unknown> = {}
  for (const entry of entries) {
    profiles[entry.agentId] = {
      agentId: entry.agentId,
      name: entry.name,
      role: entry.role,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      enabled: true,
      createdAt: 1,
      publicKey: 'seed',
    }
  }
  writeFileSync(join(dir, 'profiles.json'), `${JSON.stringify(profiles, null, 2)}\n`, { encoding: 'utf8' })
}

/** Write one real session log (zstd JSONL) through the canonical write path. */
async function seedSession(root: string, id: string, createdAt: number, events: Array<Record<string, unknown>>): Promise<void> {
  const ctx = new CordisContext()
  void new SessionStore(ctx)
  const persistence = new JsonlSessionPersistence(ctx, { root })
  const sessionId = SessionId(id)
  await persistence.create({
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt,
    delegationDepth: 0,
  })
  if (events.length > 0) {
    await persistence.append(sessionId, events as never)
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

/** A captured dsh-web-gateway fake: records every POST envelope, answers ok. */
interface Gateway {
  base: string
  bodies: Array<{ method: string; payload: Record<string, unknown> }>
  close(): Promise<void>
}

async function fakeGateway(): Promise<Gateway> {
  const bodies: Array<{ method: string; payload: Record<string, unknown> }> = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      bodies.push({
        method: String(body.method),
        payload: (body.payload ?? {}) as Record<string, unknown>,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Seed the session ledger for the status-derivation block. */
async function seedLedger(root: string): Promise<void> {
  await seedSession(root, 'sess-done', 1_000, [
    { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
    { type: 'session/title', seq: 1, time: 1_500, data: { title: 'alpha done' } },
    { type: 'turn/end', seq: 2, time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  await seedSession(root, 'sess-run', 3_000, [
    { type: 'turn/start', seq: 0, time: 3_000, data: { turn: 1 } },
    { type: 'session/title', seq: 1, time: 3_500, data: { title: 'beta running' } },
  ])
  await seedSession(root, 'sess-idle', 5_000, [
    { type: 'session/end-seed', seq: 0, time: 5_000, data: {} },
  ])
}

async function main(): Promise<void> {
  console.log('fleet-settings-smoke: session ledger status + resume/archive seams + settings persistence + HTTP surface + plugin mount')

  // ---- 1. session ledger: entries with derived status ----
  {
    const root = mkdtempSync(join(tmpdir(), 'settings-ledger-'))
    await seedLedger(root)
    const ledger = new SessionLedger({ sessionsRoot: root })
    const entries = await ledger.list()
    assertPass('sessions list returns ledger entries', entries.length === 3, JSON.stringify(entries.map(e => e.id)))

    const done = entries.find(entry => entry.id === 'sess-done')
    assertPass('a closed-turn session is status "done" with its title',
      done?.status === 'done' && done?.title === 'alpha done' && done?.hasActivity === true,
      JSON.stringify(done))

    const running = entries.find(entry => entry.id === 'sess-run')
    assertPass('an open-turn session is status "running" with its title',
      running?.status === 'running' && running?.title === 'beta running' && running?.hasActivity === true,
      JSON.stringify(running))

    const idle = entries.find(entry => entry.id === 'sess-idle')
    assertPass('a no-turn session is status "idle" (blank)',
      idle?.status === 'idle' && idle?.hasActivity === false && idle?.updatedAt >= 5_000,
      JSON.stringify(idle))

    assertPass('entries carry updatedAt + createdAt + the ledger path surface',
      done !== undefined && done.updatedAt >= 2_000 && done.header.createdAt === 1_000
        && ledger.sessionsRoot === root && ledger.logCompression === 'zstd')
  }

  // ---- 2. resume seam: the session.prompt RPC payload + gateway execution ----
  {
    const home = mkdtempSync(join(tmpdir(), 'settings-resume-'))
    seedProfiles(home, [{ agentId: 'agent-a', name: 'Alice', role: 'lead' }])
    await seedLedger(join(home, 'sessions'))
    const gateway = await fakeGateway()

    const server = new FleetSettingsServer({ port: 0, home, dshWebBaseUrl: gateway.base })
    await server.listen()
    const base = `http://127.0.0.1:${server.port}`

    const resumed = await fetchJson(`${base}/api/sessions/sess-run/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go on' }),
    })
    assertPass('resume returns the session.prompt seam payload',
      resumed.status === 200 && resumed.body.ok === true && resumed.body.seam === 'session.prompt'
        && resumed.body.target.url.endsWith('/api/session.prompt')
        && resumed.body.target.method === 'POST'
        && resumed.body.target.body.method === 'session.prompt',
      JSON.stringify(resumed.body))

    assertPass('resume executed against the dsh gateway (accepted)',
      resumed.body.executed === true && resumed.body.accepted === true && resumed.body.status === 200,
      JSON.stringify(resumed.body))

    const prompt = gateway.bodies.find(entry => entry.method === 'session.prompt')
    assertPass('the gateway received session.prompt with mode queue + the followup text',
      prompt !== undefined
        && prompt.payload.sessionId === 'sess-run'
        && prompt.payload.mode === 'queue'
        && Array.isArray(prompt.payload.content)
        && (prompt.payload.content as Array<{ type: string; text: string }>)[0]!.type === 'text'
        && (prompt.payload.content as Array<{ type: string; text: string }>)[0]!.text === 'go on',
      JSON.stringify(prompt))

    await server.close()
    await gateway.close()
  }

  // ---- 3. archive seam: overlay marker (persists) + the workspace.archiveSession RPC ----
  {
    const home = mkdtempSync(join(tmpdir(), 'settings-archive-'))
    seedProfiles(home, [{ agentId: 'agent-a', name: 'Alice', role: 'lead' }])
    await seedLedger(join(home, 'sessions'))
    const gateway = await fakeGateway()

    const server = new FleetSettingsServer({ port: 0, home, dshWebBaseUrl: gateway.base })
    await server.listen()
    const base = `http://127.0.0.1:${server.port}`

    const archived = await fetchJson(`${base}/api/sessions/sess-done/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    })
    assertPass('archive marks the session via the overlay + fires the workspace.archiveSession seam',
      archived.status === 200 && archived.body.ok === true && archived.body.archived === true
        && archived.body.overlay.archived === true && archived.body.seam === 'workspace.archiveSession'
        && archived.body.executed === true,
      JSON.stringify(archived.body))

    const hostArchive = gateway.bodies.find(entry => entry.method === 'workspace.archiveSession')
    assertPass('the gateway received workspace.archiveSession for the session id',
      hostArchive !== undefined && hostArchive.payload.sessionId === 'sess-done',
      JSON.stringify(hostArchive))

    const list = await fetchJson(`${base}/api/sessions`)
    assertPass('the archived session is flagged in the session list',
      list.status === 200
        && list.body.sessions.some((s: any) => s.id === 'sess-done' && s.archived === true)
        && list.body.archived.includes('sess-done'),
      JSON.stringify(list.body.sessions))

    // The overlay marker survives a server restart (no gateway needed).
    await server.close()
    const server2 = new FleetSettingsServer({ port: 0, home })
    await server2.listen()
    const base2 = `http://127.0.0.1:${server2.port}`
    const list2 = await fetchJson(`${base2}/api/sessions`)
    assertPass('the archive marker persists across a page-server restart',
      list2.status === 200 && list2.body.sessions.some((s: any) => s.id === 'sess-done' && s.archived === true),
      JSON.stringify(list2.body.archived))

    const restored = await fetchJson(`${base2}/api/sessions/sess-done/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    })
    assertPass('restore removes the archive marker',
      restored.status === 200 && restored.body.archived === false && restored.body.overlay.archived === undefined,
      JSON.stringify(restored.body))

    await server2.close()
    await gateway.close()
  }

  // ---- 4. fleet setting edit persists across a service restart ----
  {
    const home = mkdtempSync(join(tmpdir(), 'settings-persist-'))
    seedProfiles(home, [{ agentId: 'agent-a', name: 'Alice', role: 'lead', model: 'old-model' }])
    await seedLedger(join(home, 'sessions'))
    const ctx = new CordisContext()
    const teams = createSettingsDeps({ home }).teams
    teams.createTeam({ name: 'builders' }, 'agent-a')

    // First server: make the edits through the API.
    const server1 = new FleetSettingsServer({ port: 0, home })
    await server1.listen()
    const base1 = `http://127.0.0.1:${server1.port}`

    const budgetSet = await fetchJson(`${base1}/api/budgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test', scope: { kind: 'global' }, cap: 5000 }),
    })
    assertPass('a budget cap edit succeeds via /api/budgets',
      budgetSet.status === 200 && budgetSet.body.ok === true && budgetSet.body.budget.cap === 5000,
      JSON.stringify(budgetSet.body))

    const agentEdited = await fetchJson(`${base1}/api/agents/agent-a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hy3-free' }),
    })
    assertPass('an agent model edit succeeds via /api/agents/:id',
      agentEdited.status === 200 && agentEdited.body.ok === true && agentEdited.body.profile.model === 'hy3-free',
      JSON.stringify(agentEdited.body))

    await server1.close()

    // RESTART: a fresh server over the SAME durable dirs.
    const server2 = new FleetSettingsServer({ port: 0, home })
    await server2.listen()
    const base2 = `http://127.0.0.1:${server2.port}`

    const budgets = await fetchJson(`${base2}/api/budgets`)
    assertPass('the budget cap edit persists across the service restart (SQLite)',
      budgets.status === 200 && budgets.body.budgets.some((b: any) => b.cap === 5000),
      JSON.stringify(budgets.body.budgets))

    const agents = await fetchJson(`${base2}/api/agents`)
    assertPass('the agent model edit persists across the service restart (profiles.json)',
      agents.status === 200 && agents.body.profiles.some((p: any) => p.agentId === 'agent-a' && p.model === 'hy3-free'),
      JSON.stringify(agents.body.profiles))

    const teamsRes = await fetchJson(`${base2}/api/teams`)
    assertPass('teams survive the restart (teams.json)',
      teamsRes.status === 200 && teamsRes.body.teams.some((t: any) => t.team.name === 'builders'),
      JSON.stringify(teamsRes.body.teams))

    const policy = await fetchJson(`${base2}/api/policy`)
    assertPass('policy status reads the context posture',
      policy.status === 200 && policy.body.ok === true && typeof policy.body.context === 'string',
      JSON.stringify(policy.body))

    await server2.close()
    void ctx
  }

  // ---- 5. HTTP surface: page, health, sessions, agents, teams, budgets, policy ----
  {
    const home = mkdtempSync(join(tmpdir(), 'settings-http-'))
    seedProfiles(home, [{ agentId: 'agent-a', name: 'Alice', role: 'lead' }])
    await seedLedger(join(home, 'sessions'))
    const server = new FleetSettingsServer({ port: 0, home })
    await server.listen()
    const base = `http://127.0.0.1:${server.port}`

    const page = await fetch(base, { cache: 'no-store' })
    assertPass('GET / → 200 text/html (the settings page)',
      page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html'))
    const pageText = await page.text()
    assertPass('the page is self-contained + carries the five tab affordances',
      pageText.includes('fleet-settings') && pageText.includes('Sessions')
        && pageText.includes('Agents') && pageText.includes('Teams')
        && pageText.includes('Budgets') && pageText.includes('Policy'))

    const health = await fetchJson(`${base}/health`)
    assertPass('GET /health → 200 ok with store stats',
      health.status === 200 && health.body.ok === true && health.body.sessionsRoot.endsWith('sessions'),
      JSON.stringify(health.body))

    const sessions = await fetchJson(`${base}/api/sessions`)
    assertPass('GET /api/sessions → the ledger with status + running count',
      sessions.status === 200 && sessions.body.count === 3 && sessions.body.running === 1
        && sessions.body.sessions.some((s: any) => s.id === 'sess-run' && s.status === 'running'),
      JSON.stringify(sessions.body))

    const agents = await fetchJson(`${base}/api/agents`)
    assertPass('GET /api/agents → the fleet-agent registry',
      agents.status === 200 && agents.body.count === 1 && agents.body.profiles[0]!.name === 'Alice',
      JSON.stringify(agents.body))

    await server.close()
  }

  // ---- 6. plugin surface: webServer routes + handlers consume ctx services ----
  {
    const home = mkdtempSync(join(tmpdir(), 'settings-plugin-'))
    seedProfiles(home, [{ agentId: 'agent-a', name: 'Alice', role: 'lead' }])
    await seedLedger(join(home, 'sessions'))
    const ctx = new CordisContext()
    const deps = createSettingsDeps({ home })
    void deps.teams.createTeam({ name: 'plugin-team' }, 'agent-a')

    const mountedRoutes: Array<{ kind: string; path: string }> = []
    const fakeWebServer = {
      register(route: { kind: 'exact' | 'prefix'; path: string }): () => void {
        mountedRoutes.push({ kind: route.kind, path: route.path })
        return () => { /* no-op test disposer */ }
      },
    }
    ctx.reflect.provide('webServer', fakeWebServer as unknown as WebServer)
    ctx.reflect.provide('fleetAgent', deps.agents as never)
    ctx.reflect.provide('fleetTeams', deps.teams as never)
    applySettings(ctx, { home, dshWebBaseUrl: undefined } as never)

    assertPass('plugin mounts /fleet-settings routes on the dsh webServer',
      mountedRoutes.some(r => r.path === '/fleet-settings' && r.kind === 'prefix')
        && mountedRoutes.some(r => r.path === '/fleet-settings/api' && r.kind === 'prefix')
        && mountedRoutes.some(r => r.path === '/fleet-settings/health' && r.kind === 'prefix'),
      JSON.stringify(mountedRoutes))

    // The handler set builds over a live settings dep set.
    const handlers = createSettingsHandlers(deps, '', '/fleet-settings')
    assertPass('the handler factory builds over a live settings dep set',
      handlers.index !== undefined && handlers.health !== undefined && handlers.api !== undefined)

    // The standalone overlay store persists independently.
    const overlay = new SettingsOverlay({ home })
    overlay.setArchived('sess-done', true)
    assertPass('the overlay store marks + reads back an archived session',
      overlay.session('sess-done').archived === true,
      JSON.stringify(overlay.all()))
  }

  console.log('fleet-settings-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`fleet-settings-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
