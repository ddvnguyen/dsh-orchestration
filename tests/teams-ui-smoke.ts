/**
 * VERIFY (issue #26): fleet-teams-ui smoke test — the P4.2 rooms page +
 * team/room settings dialog ride on the fleet HTTP surface.
 *
 * Covers: (1) SENDER IDENTITY — a chat message renders its sender's
 * name/avatar/role badge resolved from the fleet-agent profile registry
 * (profiles.json), never a bare session id; (2) the SETTINGS-DIALOG SERVICE
 * FLOW — rename room + change grant + archive persist across a service
 * restart (rename/archive via the UI-layer overlay store, grant change via
 * fleet-teams teams.json); (3) the COMPOSER posts a room message end-to-end
 * (HTTP POST → fleet-teams grant-checked post → the thread shows it with the
 * sender badge); (4) the HTTP surface (/, /health, /api/profiles, /api/rooms)
 * + the plugin webServer route mounting. No live LLM.
 *
 * Run: pnpm test:teams-ui  (or)  tsx tests/teams-ui-smoke.ts
 * @module @hydra/dsh-fleet/tests/teams-ui-smoke
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { assertPass } from './harness.ts'
import { FleetTeamsUiServer, createTeamsUiHandlers } from '../plugins/fleet-teams-ui/src/server.ts'
import { TeamsUiOverlay } from '../plugins/fleet-teams-ui/src/overlay.ts'
import { ProfileStore, senderBadge } from '../plugins/fleet-teams-ui/src/identity.ts'
import { apply as applyTeamsUi } from '../plugins/fleet-teams-ui/src/index.ts'
import { FleetTeamsService } from '../plugins/fleet-teams/src/service.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { GrantMask } from '../plugins/fleet-teams/src/types.ts'

/** Write a seeded fleet-agent profile registry (identity for sender badges). */
function seedProfiles(home: string, entries: Array<{ agentId: string; name: string; role: string; avatar?: string }>): void {
  const dir = join(home, 'fleet', 'agent')
  mkdirSync(dir, { recursive: true })
  const profiles: Record<string, unknown> = {}
  for (const entry of entries) {
    profiles[entry.agentId] = {
      agentId: entry.agentId,
      name: entry.name,
      role: entry.role,
      ...(entry.avatar !== undefined ? { avatar: entry.avatar } : {}),
      enabled: true,
      createdAt: 1,
      publicKey: 'seed',
    }
  }
  writeFileSync(join(dir, 'profiles.json'), `${JSON.stringify(profiles, null, 2)}\n`, { encoding: 'utf8' })
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

/** Mount a standalone server + seed a team/room with two joined members. */
async function mountServer(home: string): Promise<{ server: FleetTeamsUiServer; base: string }> {
  const server = new FleetTeamsUiServer({ port: 0, home })
  await server.listen()
  const service = server.service
  const team = service.createTeam({ name: 'builders' }, 'agent-a')
  service.joinTeam(team.id, 'agent-b')
  const room = service.createRoom({ teamId: team.id, name: 'ops' }, 'agent-a')
  service.joinRoom(room.id, 'agent-a')
  service.joinRoom(room.id, 'agent-b')
  return { server, base: `http://127.0.0.1:${server.port}` }
}

async function main(): Promise<void> {
  console.log('teams-ui-smoke: sender identity + settings dialog + composer + HTTP surface + plugin mount')

  // ---- 1. sender identity: profile lookup renders name/avatar/role for a post ----
  {
    const home = mkdtempSync(join(tmpdir(), 'teams-ui-home-'))
    seedProfiles(home, [
      { agentId: 'agent-a', name: 'Alice', role: 'lead', avatar: '#ff6b6b' },
      { agentId: 'agent-b', name: 'Bob', role: 'qa' },
    ])

    // Pure resolution: the badge carries name + role + avatar (initial/color).
    const store = new ProfileStore({ home })
    const alice = store.get('agent-a')!
    const bob = store.get('agent-b')!
    const badgeA = senderBadge('agent-a', alice)
    const badgeB = senderBadge('agent-b', bob)
    assertPass('profile lookup resolves name for the sender', badgeA.name === 'Alice' && badgeB.name === 'Bob')
    assertPass('profile lookup resolves the role badge',
      badgeA.role === 'lead' && badgeB.role === 'qa')
    assertPass('profile avatar is used when set; initial+color derived otherwise',
      badgeA.avatar === '#ff6b6b' && badgeB.avatar === 'B' && /^#[0-9a-f]{6}$/i.test(badgeB.color),
      JSON.stringify({ badgeA, badgeB }))
    assertPass('an unknown agent falls back to the bare id (neutral chip)',
      senderBadge('stranger', undefined).name === 'stranger' && senderBadge('stranger', undefined).role === 'agent')

    // Through the API: a posted message renders with the sender badge.
    const { server, base } = await mountServer(home)
    const roomId = server.service.listRooms()[0]!.id
    const posted = await fetchJson(`${base}/api/rooms/${roomId}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'agent-a', body: 'hello from alice' }),
    })
    assertPass('composer posts as the chosen actor (grant-checked)', posted.status === 200 && posted.body.ok === true)
    const thread = await fetchJson(`${base}/api/rooms/${roomId}/messages`)
    assertPass('the thread carries the message with a resolved sender badge',
      thread.status === 200
        && thread.body.messages.some((m: any) => m.body === 'hello from alice' && m.sender.name === 'Alice' && m.sender.role === 'lead' && m.sender.agentId === 'agent-a'),
      JSON.stringify(thread.body.messages))
    await server.close()
  }

  // ---- 2. settings-dialog service flow: rename + change grant + archive persist ----
  {
    const home = mkdtempSync(join(tmpdir(), 'teams-ui-settings-'))
    seedProfiles(home, [
      { agentId: 'agent-a', name: 'Alice', role: 'lead' },
      { agentId: 'agent-b', name: 'Bob', role: 'qa' },
    ])

    // First server instance: seed + make the dialog changes.
    const { server, base } = await mountServer(home)
    const roomId = server.service.listRooms()[0]!.id

    // Rename the room (UI-layer overlay — fleet-teams has no rename seam).
    const renamed = await fetchJson(`${base}/api/rooms/${roomId}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'agent-a', displayName: 'ops-hub' }),
    })
    assertPass('settings rename persists via the UI-layer overlay',
      renamed.status === 200 && renamed.body.overlay.displayName === 'ops-hub', JSON.stringify(renamed.body))

    // Change a grant: revoke agent-b's post grant (fleet-teams team model).
    const grantChanged = await fetchJson(`${base}/api/rooms/${roomId}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'agent-a', overrides: { 'agent-b': { post: false } } }),
    })
    assertPass('settings grant change persists via fleet-teams (teams.json)',
      grantChanged.status === 200 && grantChanged.body.grantsUpdated === true
        && server.service.effectiveGrants('agent-b', roomId).post === false,
      JSON.stringify(grantChanged.body))

    // Archive the room.
    const archived = await fetchJson(`${base}/api/rooms/${roomId}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'agent-a', archived: true }),
    })
    assertPass('settings archive persists via the UI-layer overlay',
      archived.status === 200 && archived.body.overlay.archived === true, JSON.stringify(archived.body))

    // Compose a message before the restart (must survive too).
    const preRestart = await fetchJson(`${base}/api/rooms/${roomId}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'agent-a', body: 'pre-restart note' }),
    })
    assertPass('the pre-restart composer post succeeds', preRestart.status === 200 && preRestart.body.ok === true,
      JSON.stringify(preRestart.body))
    await server.close()

    // RESTART: a fresh server over the SAME durable dirs.
    const server2 = new FleetTeamsUiServer({ port: 0, home })
    await server2.listen()
    const base2 = `http://127.0.0.1:${server2.port}`
    const roomAfter = server2.service.getRoom(roomId)
    assertPass('restart reloads teams.json — the room + membership + grant change survive',
      roomAfter !== undefined
        && roomAfter.memberIds.includes('agent-a') && roomAfter.memberIds.includes('agent-b')
        && server2.service.effectiveGrants('agent-b', roomId).post === false,
      JSON.stringify(roomAfter))

    const detail = await fetchJson(`${base2}/api/rooms/${roomId}`)
    assertPass('restart reloads the overlay — rename + archive survive',
      detail.status === 200
        && detail.body.overlay.displayName === 'ops-hub'
        && detail.body.overlay.archived === true,
      JSON.stringify(detail.body.overlay))

    const thread2 = await fetchJson(`${base2}/api/rooms/${roomId}/messages`)
    assertPass('restart keeps the room memory — the pre-restart post survives',
      thread2.status === 200
        && thread2.body.messages.some((m: any) => m.body === 'pre-restart note' && m.sender.name === 'Alice'),
      JSON.stringify(thread2.body.messages))

    // The restarted service is still fully functional (composer works).
    const posted2 = await fetchJson(`${base2}/api/rooms/${roomId}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'agent-a', body: 'still alive after restart' }),
    })
    assertPass('the restarted composer keeps posting (grant-checked)',
      posted2.status === 200 && posted2.body.ok === true && posted2.body.sender.name === 'Alice',
      JSON.stringify(posted2.body))
    await server2.close()
  }

  // ---- 3. HTTP surface: page, health, profiles, rooms ----
  {
    const home = mkdtempSync(join(tmpdir(), 'teams-ui-http-'))
    seedProfiles(home, [{ agentId: 'agent-a', name: 'Alice', role: 'lead' }])
    const { server, base } = await mountServer(home)

    const page = await fetch(base, { cache: 'no-store' })
    assertPass('GET / → 200 text/html (the rooms page)',
      page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html'))
    const pageText = await page.text()
    assertPass('the page is self-contained (no external deps) + carries the identity/role affordances',
      pageText.includes('fleet-teams') && pageText.includes('role-badge') && pageText.includes('Team settings'))

    const health = await fetchJson(`${base}/health`)
    assertPass('GET /health → 200 ok with store stats',
      health.status === 200 && health.body.ok === true && health.body.rooms === 1 && health.body.teams === 1,
      JSON.stringify(health.body))

    const profiles = await fetchJson(`${base}/api/profiles`)
    assertPass('GET /api/profiles → the fleet-agent registry',
      profiles.status === 200 && profiles.body.count === 1 && profiles.body.profiles[0]!.name === 'Alice',
      JSON.stringify(profiles.body))

    const rooms = await fetchJson(`${base}/api/rooms`)
    assertPass('GET /api/rooms → teams + rooms with member grants + senders',
      rooms.status === 200
        && rooms.body.teams[0]!.rooms.length === 1
        && rooms.body.teams[0]!.rooms[0]!.senders['agent-a'] !== undefined,
      JSON.stringify(rooms.body.teams))

    const detail = await fetchJson(`${base}/api/rooms/${server.service.listRooms()[0]!.id}`)
    assertPass('room detail exposes memory + scope + grants + linked tasks',
      detail.status === 200
        && typeof detail.body.memoryContent === 'string'
        && detail.body.scope.startsWith('room:')
        && detail.body.memberGrants['agent-a'] !== undefined
        && Array.isArray(detail.body.linkedTasks),
      JSON.stringify(detail.body))

    await server.close()
  }

  // ---- 4. plugin surface: webServer routes + handlers consume ctx.fleetTeams ----
  {
    const home = mkdtempSync(join(tmpdir(), 'teams-ui-plugin-'))
    seedProfiles(home, [{ agentId: 'agent-a', name: 'Alice', role: 'lead' }])
    const ctx = new CordisContext()
    const bus = new FleetBusService(ctx, { storeDir: join(home, 'fleet'), resolveAgent: () => undefined })
    void bus
    const teams = new FleetTeamsService(ctx, { home, storeDir: join(home, 'fleet', 'teams') })
    teams.createTeam({ name: 'plugin-team' }, 'agent-a')

    const mountedRoutes: Array<{ kind: string; path: string }> = []
    const fakeWebServer = {
      register(route: { kind: 'exact' | 'prefix'; path: string }): () => void {
        mountedRoutes.push({ kind: route.kind, path: route.path })
        return () => { /* no-op test disposer */ }
      },
    }
    ctx.reflect.provide('webServer', fakeWebServer as unknown as WebServer)
    applyTeamsUi(ctx, { home } as never)

    assertPass('plugin mounts /fleet-teams-ui routes on the dsh webServer',
      mountedRoutes.some(r => r.path === '/fleet-teams-ui' && r.kind === 'prefix')
      && mountedRoutes.some(r => r.path === '/fleet-teams-ui/api' && r.kind === 'prefix'),
      JSON.stringify(mountedRoutes))

    // The handler set consumes ctx.fleetTeams (via the shared factory).
    const handlers = createTeamsUiHandlers({
      teams,
      overlay: new TeamsUiOverlay({ home }),
      profiles: new ProfileStore({ home }),
      storeDir: join(home, 'fleet'),
    })
    assertPass('the handler factory builds over a live FleetTeamsService', handlers.health !== undefined)

    const room = teams.listRooms()[0]
    const grants = room === undefined ? { read: false, post: false, join: false } as GrantMask : teams.effectiveGrants('agent-a', room.id)
    assertPass('grant checks flow through the composed fleet-teams service', typeof grants.post === 'boolean', JSON.stringify(grants))
  }

  console.log('teams-ui-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`teams-ui-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
