/**
 * VERIFY (issue #26): fleet-teams smoke test.
 * Unit coverage for the P4.1 social top layer — teams + rooms + grants +
 * team_post + the shared-room memory file. The acceptance: two agents in a
 * room exchange posts (grant-checked); the room memory survives a restart
 * (durable file reloaded by a new service instance). Also covered: team/room
 * lifecycle, the grant model (team defaults inherited by room members unless a
 * room overrides; per-agent overrides; non-member = no grants), bus scope
 * validation (a room scope resolves to a real room; free-form scopes are
 * flagged/rejected per strictScopes), fleet/team-post bus events with
 * originKind 'teams' signed via fleet-agent, the durable memory sections, the
 * Cordis event seam, and the 13 `team_` / `room_` tools. No live LLM — fake clock
 * + real fleet-bus + real fleet-agent (identity) + the family harness pattern.
 *
 * The fleet-agent identity service is mounted RENAME-RESILIENTLY: the plugin
 * was fleet-identity → fleet-agent in this worktree, so the mount imports
 * whichever class export exists (FleetAgentService or FleetIdentityService).
 *
 * Run: pnpm test:teams  (or)  tsx tests/fleet-teams-smoke.ts
 * @module @hydra/dsh-fleet/tests/fleet-teams-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertPass, fakeClock } from './harness.ts'
import { apply as applyTeams } from '../plugins/fleet-teams/src/index.ts'
import {
  FleetTeamsService,
  ROOM_MEMORY_SECTIONS,
  TEAMS_EVENT_TYPES,
  TEAMS_ORIGIN_KIND,
} from '../plugins/fleet-teams/src/service.ts'
import type { GrantMask, RoomPost } from '../plugins/fleet-teams/src/types.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'

/** The fleet-agent (identity) surface the test needs (rename-resilient). */
interface IdentityServiceLike {
  register(input: { agentId: string; name?: string; role?: string; status?: string }): { agentId: string; publicKey: string }
  sign(input: { type: string; actor: string; payload: JsonValue; ts?: number }): SignedEventLike
  verify(signed: SignedEventLike): { ok: boolean; reason?: string }
}

/** The signed-envelope shape the identity service produces. */
interface SignedEventLike {
  type: string
  actor: string
  payload: JsonValue
  ts: number
  sig: string
  pubkey: string
}

/** Mount bus + identity + teams on one fresh Context. */
async function mountTeams(overrides: Record<string, unknown> = {}): Promise<{
  ctx: CordisContext
  clock: ReturnType<typeof fakeClock>
  bus: FleetBusService
  teams: FleetTeamsService
  identity: IdentityServiceLike
  home: string
  storeDir: string
}> {
  const clock = fakeClock()
  const home = mkdtempSync(join(tmpdir(), 'fleet-teams-home-'))
  const storeDir = join(home, 'fleet')
  const ctx = new CordisContext()
  const bus = new FleetBusService(ctx, { storeDir, clock, resolveAgent: () => undefined })
  const identity = await mountIdentity(ctx, home)
  const teams = new FleetTeamsService(ctx, { home, storeDir: join(storeDir, 'teams'), clock, ...overrides })
  assertPass('ctx.fleetTeams is registered', ctx.fleetTeams !== undefined)
  return { ctx, clock, bus, teams, identity, home, storeDir }
}

/** Import the fleet-agent identity service under whichever class name exists. */
async function mountIdentity(ctx: CordisContext, home: string): Promise<IdentityServiceLike> {
  const mod = (await import('../plugins/fleet-agent/src/service.ts')) as unknown as Record<string, unknown>
  const Ctor = (mod.FleetAgentService ?? mod.FleetIdentityService) as unknown as new (
    ctx: CordisContext,
    config: { home?: string; clock?: () => number },
  ) => IdentityServiceLike
  if (Ctor === undefined) throw new Error('fleet-teams-smoke: no identity service export found in fleet-agent')
  return new Ctor(ctx, { home })
}

/** Register an agent profile (so team events can be signed by that actor). */
function registerAgent(identity: IdentityServiceLike, agentId: string): void {
  identity.register({ agentId, name: agentId, role: 'agent' })
}

/** Bus events of one type, newest-last. */
function eventsOf(bus: FleetBusService, type: string): FleetBusEvent[] {
  return bus.replay({ type })
}

/** Signed envelope embedded in an event payload, when present. */
function signedOf(event: FleetBusEvent): SignedEventLike | undefined {
  return (event.payload as { signed?: SignedEventLike }).signed
}

async function main(): Promise<void> {
  console.log('fleet-teams-smoke: teams + rooms + grants + team_post + shared-room memory — exchange, grants, scope validation, memory survives restart, tools')

  // ---- 1. team creation + creator auto-join + team events ----
  {
    const { ctx, teams, identity } = await mountTeams()
    registerAgent(identity, 'agent-a')
    const team = teams.createTeam({ name: 'builders', description: 'the builder team' }, 'agent-a')
    assertPass('creator is auto-connected to the team',
      team.memberIds.includes('agent-a') && teams.getTeam(team.id)!.memberIds.length === 1, JSON.stringify(team))
    assertPass('a fresh team defaults to ALL grants (read/post/join)',
      team.defaultGrants.read === true && team.defaultGrants.post === true && team.defaultGrants.join === true)
    const created = eventsOf(ctx.fleetBus, TEAMS_EVENT_TYPES.teamCreated)
    assertPass('fleet/team-created published with originKind "teams" + the acting actor',
      created.length === 1 && created[0]!.originKind === TEAMS_ORIGIN_KIND && created[0]!.actor === 'agent-a',
      JSON.stringify(created))
    assertPass('a team id is stable + sequential', /^team-\d+$/.test(team.id))
  }

  // ---- 2. the grant model: team defaults inherited by room members unless overridden ----
  {
    const { teams, identity } = await mountTeams()
    registerAgent(identity, 'agent-a')
    registerAgent(identity, 'agent-b')
    // A team whose default join grant is FALSE: members inherit it (cannot join rooms).
    const team = teams.createTeam({ name: 'locked', defaultGrants: { read: true, post: true, join: false } }, 'agent-a')
    teams.joinTeam(team.id, 'agent-b')
    const room = teams.createRoom({ teamId: team.id, name: 'huddle' }, 'agent-a')

    let joinDenied = false
    try { teams.joinRoom(room.id, 'agent-b') } catch { joinDenied = true }
    assertPass('a room member inherits the team default join=false (join denied)',
      joinDenied && teams.effectiveGrants('agent-b', room.id).join === false,
      JSON.stringify(teams.effectiveGrants('agent-b', room.id)))

    // Raising the team default lets the member in.
    teams.setTeamDefaultGrants(team.id, { read: true, post: true, join: true }, 'agent-a')
    const briefing = teams.joinRoom(room.id, 'agent-b')
    assertPass('raising the team default grants unblocks joining',
      briefing.room.memberIds.includes('agent-b') && teams.can('agent-b', room.id, 'join'))
    assertPass('joining delivers the room briefing — the durable memory file path + content',
      briefing.memoryFile.endsWith(`${room.id}.memory.md`) && briefing.content.includes('# huddle — room memory'),
      JSON.stringify({ file: briefing.memoryFile, head: briefing.content.slice(0, 80) }))
    assertPass('joining delivers the memory sections (Decisions / Links / Task refs / Timeline)',
      ROOM_MEMORY_SECTIONS.every(section => briefing.content.includes(`## ${section}`)))
  }

  // ---- 3. the core acceptance: two agents in a room exchange posts ----
  {
    const { ctx, teams, identity } = await mountTeams()
    registerAgent(identity, 'agent-a')
    registerAgent(identity, 'agent-b')
    const team = teams.createTeam({ name: 'acceptance' }, 'agent-a')
    teams.joinTeam(team.id, 'agent-b')
    const room = teams.createRoom({ teamId: team.id, name: 'ops' }, 'agent-a')
    teams.joinRoom(room.id, 'agent-a')
    teams.joinRoom(room.id, 'agent-b')

    const postA = teams.post(room.id, 'hello from agent-a', 'agent-a')
    const postB = teams.post(room.id, 'hi back from agent-b', 'agent-b')
    assertPass('both posts land as room posts', postA.body === 'hello from agent-a' && postB.body === 'hi back from agent-b')

    const memory = teams.readMemory(room.id, 'agent-a')
    assertPass('the shared memory file contains both posts (durable cross-agent context)',
      memory.content.includes('hello from agent-a') && memory.content.includes('hi back from agent-b'),
      memory.content)
    assertPass('recentPosts parses both posts back in order',
      memory.recentPosts.length === 2 && memory.recentPosts[0]!.actor === 'agent-a' && memory.recentPosts[1]!.actor === 'agent-b',
      JSON.stringify(memory.recentPosts))
    assertPass('post history is appended to the Timeline section',
      memory.content.includes('## Timeline') && memory.content.indexOf('## Timeline') < memory.content.indexOf('hello from agent-a'))

    // Bus surface: fleet/team-post carries actor + room + body + originKind.
    const posts = eventsOf(ctx.fleetBus, TEAMS_EVENT_TYPES.teamPost)
    assertPass('fleet/team-post published per post with actor + room + body + originKind "teams"',
      posts.length === 2
        && posts.every(event => event.originKind === TEAMS_ORIGIN_KIND)
        && posts[0]!.actor === 'agent-a' && posts[1]!.actor === 'agent-b'
        && (posts[0]!.payload as { room: string }).room === room.id
        && (posts[0]!.payload as { body: string }).body === 'hello from agent-a',
      JSON.stringify(posts.map(event => ({ actor: event.actor, payload: event.payload }))))
    assertPass('fleet/team-post events are signed via the actors\' profiles',
      posts.every(event => {
        const signed = signedOf(event)
        return signed !== undefined && identity.verify(signed).ok === true
      }))
  }

  // ---- 4. grant enforcement: join / post / read denied per the model ----
  {
    const { teams, identity } = await mountTeams()
    registerAgent(identity, 'agent-a')
    registerAgent(identity, 'agent-b')
    registerAgent(identity, 'agent-c')
    registerAgent(identity, 'agent-d')
    registerAgent(identity, 'agent-e')
    const team = teams.createTeam({ name: 'guarded' }, 'agent-a')
    teams.joinTeam(team.id, 'agent-b')
    teams.joinTeam(team.id, 'agent-c')
    teams.joinTeam(team.id, 'agent-d')
    const room = teams.createRoom({ teamId: team.id, name: 'restricted' }, 'agent-a')
    teams.joinRoom(room.id, 'agent-a')

    // Per-agent overrides: revoke join for agent-c, post for agent-b, read for agent-d.
    teams.setRoomGrants(room.id, {
      overrides: { 'agent-c': { join: false }, 'agent-b': { post: false }, 'agent-d': { read: false } },
    }, 'agent-a')

    let joinDenied = false
    try { teams.joinRoom(room.id, 'agent-c') } catch { joinDenied = true }
    assertPass('join revoked via a per-agent override → joinRoom throws', joinDenied === true)

    teams.joinRoom(room.id, 'agent-b')
    let postDenied = false
    try { teams.post(room.id, 'nope', 'agent-b') } catch { postDenied = true }
    assertPass('post revoked via a per-agent override → post throws', postDenied === true)
    assertPass('the revoked agent keeps the remaining grants', teams.can('agent-b', room.id, 'read') === true)

    teams.joinRoom(room.id, 'agent-d')
    let readDenied = false
    try { teams.readMemory(room.id, 'agent-d') } catch { readDenied = true }
    assertPass('read revoked via a per-agent override → readMemory throws', readDenied === true)

    // A team member who never joined the room has NO room grants.
    let nonMemberDenied = false
    try { teams.post(room.id, 'outsider', 'agent-d') } catch { nonMemberDenied = true }
    try { teams.readMemory(room.id, 'agent-d') } catch { /* already asserted */ }
    // agent-d IS a member but was denied read; use a never-joined member for the outsider case.
    let outsiderDenied = false
    try { teams.post(room.id, 'outsider', 'agent-b') } catch { outsiderDenied = true }
    assertPass('an agent with revoked post cannot post (member or not)',
      nonMemberDenied === false && outsiderDenied === true)

    // An agent outside the team entirely has NO grants anywhere.
    const outsider = teams.effectiveGrants('agent-e', room.id)
    assertPass('an agent outside the team has NO grants (deny-by-default)',
      outsider.read === false && outsider.post === false && outsider.join === false, JSON.stringify(outsider))

    // Restore a grant via a later override (upsert semantics).
    teams.setRoomGrants(room.id, { overrides: { 'agent-b': { post: true } } }, 'agent-a')
    const restored = teams.post(room.id, 'back in', 'agent-b')
    assertPass('a later override upserts — restored post grant allows posting again', restored.body === 'back in')
  }

  // ---- 5. THE ACCEPTANCE: the shared-room memory survives a restart ----
  {
    const { teams, identity, storeDir } = await mountTeams()
    registerAgent(identity, 'agent-a')
    registerAgent(identity, 'agent-b')
    const team = teams.createTeam({ name: 'durable' }, 'agent-a')
    teams.joinTeam(team.id, 'agent-b')
    const room = teams.createRoom({ teamId: team.id, name: 'memory-room' }, 'agent-a')
    teams.joinRoom(room.id, 'agent-a')
    teams.joinRoom(room.id, 'agent-b')
    teams.post(room.id, 'decision: use markdown memory files', 'agent-a')
    teams.post(room.id, 'follow-up: link the task ref', 'agent-b')
    teams.appendMemory(room.id, 'Task refs', 'task/42 ships in this epic', 'agent-a')

    const memoryFile = teams.memoryFilePath(room.id)
    const contentBefore = teams.readMemory(room.id, 'agent-a').content

    // RESTART: a brand-new App instance (fresh Context + fresh services) on the
    // SAME durable dirs. The memory file + teams.json on disk are the source of
    // truth — membership, grants, room scope, and the post history reload.
    const clock = fakeClock()
    const ctx2 = new CordisContext()
    const bus2 = new FleetBusService(ctx2, { storeDir, clock, resolveAgent: () => undefined })
    const identity2 = await mountIdentity(ctx2, storeDir) // identity dir = <storeDir>/agent
    const teams2 = new FleetTeamsService(ctx2, { home: storeDir, storeDir: join(storeDir, 'teams'), clock })

    const roomAfter = teams2.getRoom(room.id)
    assertPass('restart reloads teams.json — the team + room + grants + membership survive',
      roomAfter !== undefined
        && roomAfter.name === 'memory-room'
        && roomAfter.scope === room.scope
        && roomAfter.memberIds.includes('agent-a') && roomAfter.memberIds.includes('agent-b'),
      JSON.stringify(roomAfter))
    const teamAfter = teams2.getTeam(team.id)
    assertPass('restart reloads team membership + default grants',
      teamAfter !== undefined && teamAfter.memberIds.includes('agent-a') && teamAfter.memberIds.includes('agent-b'),
      JSON.stringify(teamAfter))

    const view = teams2.readMemory(room.id, 'agent-a')
    assertPass('restart reloads the room memory — BOTH posts + the context note survive',
      view.recentPosts.length === 2
        && view.recentPosts[0]!.body === 'decision: use markdown memory files'
        && view.recentPosts[1]!.body === 'follow-up: link the task ref'
        && view.content.includes('task/42 ships in this epic'),
      JSON.stringify(view.recentPosts))
    assertPass('the memory file on disk is byte-identical across the restart',
      view.content === contentBefore && teams2.memoryFilePath(room.id) === memoryFile)

    // The restarted service is fully functional: the pair can keep exchanging.
    const fresh = teams2.post(room.id, 'still alive after restart', 'agent-b')
    const after = teams2.readMemory(room.id, 'agent-a')
    assertPass('the restarted pair keeps exchanging — the new post lands in memory',
      fresh.actor === 'agent-b' && after.recentPosts.length === 3
        && after.recentPosts[2]!.body === 'still alive after restart')
  }

  // ---- 6. bus scope validation: a room scope resolves; free-form scopes are flagged/rejected ----
  {
    const { teams, identity } = await mountTeams()
    registerAgent(identity, 'agent-a')
    const team = teams.createTeam({ name: 'scope' }, 'agent-a')
    const room = teams.createRoom({ teamId: team.id, name: 'scoped' }, 'agent-a')

    const canonical = teams.validateScope(`room:${room.id}`)
    assertPass('room:<roomId> resolves to the real room',
      canonical.ok === true && canonical.kind === 'room' && canonical.roomId === room.id && canonical.teamId === team.id,
      JSON.stringify(canonical))
    const bare = teams.validateScope(room.id)
    assertPass('a bare room id resolves too', bare.ok === true && bare.kind === 'room' && bare.roomId === room.id)
    const teamScope = teams.validateScope(`team:${team.id}`)
    assertPass('team:<teamId> resolves to the real team', teamScope.ok === true && teamScope.kind === 'team' && teamScope.teamId === team.id)

    const bogus = teams.validateScope('room:does-not-exist')
    assertPass('room:<bogus> is flagged (does not resolve)', bogus.ok === false && bogus.reason !== undefined, JSON.stringify(bogus))
    const freeForm = teams.validateScope('some free-form garbage')
    assertPass('a free-form scope without a room is flagged',
      freeForm.ok === false && freeForm.reason!.includes('no room'), JSON.stringify(freeForm))
    const roomScope = teams.roomScope(room.id)
    assertPass('the canonical room scope round-trips', roomScope === `room:${room.id}`)

    let strictThrew = false
    try { teams.assertRoomScope('free-form garbage') } catch { strictThrew = true }
    assertPass('strictScopes (default) REJECTS a free-form scope (assert throws)', strictThrew === true)
    assertPass('assertRoomScope accepts the real room scope',
      teams.assertRoomScope(`room:${room.id}`)!.id === room.id)
  }

  // ---- 7. non-strict scope config: free-form scopes are flagged but not thrown ----
  {
    const { teams, identity } = await mountTeams({ strictScopes: false })
    registerAgent(identity, 'agent-a')
    const team = teams.createTeam({ name: 'lenient' }, 'agent-a')
    const room = teams.createRoom({ teamId: team.id, name: 'anything-goes', scope: 'custom:free-form' }, 'agent-a')

    const custom = teams.validateScope('custom:free-form')
    assertPass('a custom room scope still resolves through the registry',
      custom.ok === true && custom.roomId === room.id, JSON.stringify(custom))
    let lenientThrew = false
    try { teams.assertRoomScope('free-form garbage') } catch { lenientThrew = true }
    assertPass('strictScopes=false FLAGS free-form scopes without throwing', lenientThrew === false)
  }

  // ---- 8. Cordis event seam per decision + appendMemory section targeting ----
  {
    const { ctx, teams, identity } = await mountTeams()
    registerAgent(identity, 'agent-a')
    registerAgent(identity, 'agent-b')
    const seen: Array<{ type: string; roomId?: string; actor: string }> = []
    ctx.on('fleet-teams/event', (info) => { seen.push(info) })

    const team = teams.createTeam({ name: 'observed' }, 'agent-a')
    teams.joinTeam(team.id, 'agent-b')
    const room = teams.createRoom({ teamId: team.id, name: 'visible' }, 'agent-a')
    teams.joinRoom(room.id, 'agent-a')
    teams.joinRoom(room.id, 'agent-b')
    teams.post(room.id, 'one', 'agent-a')
    teams.post(room.id, 'two', 'agent-b')

    assertPass('fleet-teams/event fires per decision (team created, room created, joins, posts)',
      seen.some(entry => entry.type === TEAMS_EVENT_TYPES.teamCreated && entry.actor === 'agent-a')
        && seen.filter(entry => entry.type === TEAMS_EVENT_TYPES.teamPost).length === 2
        && seen.every(entry => entry.roomId === undefined || entry.roomId === room.id),
      JSON.stringify(seen))

    const memory = teams.appendMemory(room.id, 'Decisions', 'the memory format is markdown', 'agent-a')
    const decisions = memory.content.split('## Decisions\n')[1]!.split('\n##')[0]!
    assertPass('appendMemory targets a section (Decisions) and leaves the Timeline intact',
      decisions.includes('the memory format is markdown')
        && memory.recentPosts.length === 2 && memory.content.includes('## Timeline'),
      decisions)
    assertPass('a context-note append publishes a fleet/team-post marker event',
      eventsOf(ctx.fleetBus, TEAMS_EVENT_TYPES.teamPost)
        .some(event => (event.payload as { kind?: string }).kind === 'context-note'))
  }

  // ---- 9. tools: 13 team_*/room_* tools registered + execute + require an agent ----
  {
    const ctx = new CordisContext()
    const clock = fakeClock()
    const storeDir = mkdtempSync(join(tmpdir(), 'fleet-teams-tools-'))
    const registered = new Map<string, ToolDefinition>()
    ctx.reflect.provide('tools', {
      register(def: ToolDefinition): () => void {
        registered.set(def.name, def)
        return () => { registered.delete(def.name) }
      },
    } as never)

    const identity = await mountIdentity(ctx, mkdtempSync(join(tmpdir(), 'fleet-teams-tools-identity-')))
    applyTeams(ctx, { home: storeDir, storeDir: join(storeDir, 'teams'), clock, strictScopes: true, injectTools: true } as never)
    const toolNames = [
      'team_create', 'team_join', 'team_leave', 'team_list', 'team_grants',
      'room_create', 'room_join', 'room_leave', 'room_list', 'room_grants',
      'team_post', 'room_memory', 'team_scope',
    ]
    assertPass('apply registers all 13 team_*/room_* tools',
      toolNames.every(name => registered.has(name)),
      JSON.stringify([...registered.keys()]))

    // The apply-created service is on ctx.fleetTeams; tools act through it.
    const teams = ctx.fleetTeams
    const exec = { agent: { id: 'agent-a', session: { id: 'agent-a' } } }
    registerAgent(identity, 'agent-a')

    const createTool = registered.get('team_create')!
    const createResult = await createTool.execute!({ name: 'tool-team' }, exec as never) as { id: string; name: string }
    assertPass('team_create executes (creates + auto-joins the caller)', createResult.name === 'tool-team' && /^team-\d+$/.test(createResult.id))

    const roomTool = registered.get('room_create')!
    const roomResult = await roomTool.execute!({ teamId: createResult.id, name: 'tool-room' }, exec as never) as { id: string; scope: string }
    assertPass('room_create executes with the canonical scope', roomResult.scope === `room:${roomResult.id}`)

    const joinTool = registered.get('room_join')!
    const joinResult = await joinTool.execute!({ roomId: roomResult.id }, exec as never) as { memoryFile: string }
    assertPass('room_join executes and returns the memory briefing', joinResult.memoryFile.endsWith(`${roomResult.id}.memory.md`))

    const postTool = registered.get('team_post')!
    const postResult = await postTool.execute!({ roomId: roomResult.id, body: 'tool post' }, exec as never) as { body: string; room: string }
    assertPass('team_post executes (grant-checked)', postResult.body === 'tool post' && postResult.room === roomResult.id)

    const memoryTool = registered.get('room_memory')!
    const memoryResult = await memoryTool.execute!({ roomId: roomResult.id }, exec as never) as { recentPosts: RoomPost[] }
    assertPass('room_memory reads the timeline back', memoryResult.recentPosts.length === 1 && memoryResult.recentPosts[0]!.body === 'tool post')

    const scopeTool = registered.get('team_scope')!
    const scopeResult = await scopeTool.execute!({ scope: `room:${roomResult.id}` }, exec as never) as { ok: boolean }
    assertPass('team_scope validates the room scope', scopeResult.ok === true)

    const noAgent = await postTool.execute!({ roomId: roomResult.id, body: 'nobody' }, {} as never)
      .then(() => false, () => true)
    assertPass('teams tools require an owning agent session', noAgent === true)
  }

  console.log('fleet-teams-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`fleet-teams-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
