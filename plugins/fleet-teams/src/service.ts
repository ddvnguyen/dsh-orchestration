/**
 * FleetTeamsService — the `ctx.fleetTeams` Cordis service behind the
 * fleet-teams plugin (issue #26, orchestration-v3 §4 P4.1).
 *
 * The V3 social top layer: named teams + rooms + per-room grants + team_post
 * + the shared-room memory file (claude_codex_bridge pattern, durable
 * cross-agent context).
 *
 * A TEAM only CONNECTS agents to a team — membership + grants, nothing else.
 * The agent roster comes from the fleet-agent identity profiles (referenced
 * via the signing seam, never duplicated here); agent-specific CONFIG lives
 * in fleet-agent (P4.3), out of this plugin's scope.
 *
 * DURABLE STATE lives under `$DSH_HOME/fleet/teams/`:
 * - `teams.json` — the teams + rooms store (membership, grants, scope);
 *   written atomically on every mutation, reloaded on boot.
 * - `<roomId>.memory.md` — the per-room shared memory file (decisions / links
 *   / task refs sections + an append-only Timeline that doubles as the durable
 *   post history). It survives restart because the file on disk is the source
 *   of truth: `recentPosts` and `readMemory` read it fresh. Format documented
 *   in `src/types.ts`; the choice of markdown over jsonl is deliberate — the
 *   memory is for humans AND agents (the claude_codex_bridge pattern), and the
 *   timeline lines are strictly parseable for the post history.
 *
 * GRANTS. Three grants govern each room: `read` / `post` / `join`. Room
 * members inherit the team `defaultGrants` unless the room overrides:
 * `room.grants` replaces the team defaults for the room, and
 * `room.overrides[agentId]` is a per-agent partial mask merged over the
 * effective base. Enforcement lives on the join / post / read APIs: a
 * non-member has NO grants (joining is the gate), a member without `post`
 * cannot post, without `read` cannot read the memory.
 *
 * ROOM SCOPE VALIDATION (why teams is the last plugin): the bus's scope field
 * was a free-form string until now. `validateScope(scope)` resolves a scope
 * string to a real room (`room:<id>` / bare room id) or team (`team:<id>`);
 * a free-form scope without a room is FLAGGED (returns `ok: false`) and —
 * per the `strictScopes` config, default true — REJECTED by
 * `assertRoomScope` (throws).
 *
 * EVENTS (all `originKind: 'teams'`, the self-trigger guard): actor = the
 * acting agent (attribution), payload carries the signed envelope via
 * `ctx.fleetAgent` when the actor has a registered profile (best-effort;
 * unsigned fallback). `fleet/team-created`, `fleet/team-member-joined`,
 * `fleet/team-member-left`, `fleet/team-grants-updated`, `fleet/room-created`,
 * `fleet/room-member-joined`, `fleet/room-member-left`,
 * `fleet/room-grants-updated`, `fleet/team-post`.
 *
 * Seams (all optional via `ctx.get`, the AGENTS.md optional-service rule):
 * - `fleetBus`     — the event surface. Absent → events dropped (debug log).
 * - `fleetAgent`   — ed25519 signing of published events (best-effort).
 * @module @hydra/dsh-fleet-teams/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { systemClock, type FleetClock } from '../../../src/types.ts'
import type { FleetBusEvent } from '../../fleet-bus/src/types.ts'
import {
  ALL_GRANTS,
  NO_GRANTS,
  type FleetRoom,
  type FleetTeam,
  type GrantMask,
  type RoomMemoryView,
  type RoomPost,
  type RoomScopeValidation,
  type TeamGrant,
} from './types.ts'

/** Actor + mechanism label for every teams-produced event. */
export const TEAMS_ORIGIN_KIND = 'teams'

/** Bus event types this plugin owns. */
export const TEAMS_EVENT_TYPES = {
  teamCreated: 'fleet/team-created',
  teamMemberJoined: 'fleet/team-member-joined',
  teamMemberLeft: 'fleet/team-member-left',
  teamGrantsUpdated: 'fleet/team-grants-updated',
  roomCreated: 'fleet/room-created',
  roomMemberJoined: 'fleet/room-member-joined',
  roomMemberLeft: 'fleet/room-member-left',
  roomGrantsUpdated: 'fleet/room-grants-updated',
  teamPost: 'fleet/team-post',
} as const

/** Teams data root, relative to the DSH_HOME (or overridable as storeDir). */
export const TEAMS_DIR = 'fleet/teams'
/** The durable teams+rooms store file inside the teams data dir. */
const TEAMS_STORE_FILE = 'teams.json'

/** Memory-file sections, in file order (the Timeline is the last + the post log). */
export const ROOM_MEMORY_SECTIONS = ['Decisions', 'Links', 'Task refs', 'Timeline'] as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetTeams: FleetTeamsService
  }

  interface Events {
    /**
     * One teams decision occurred (team/room created, membership changed,
     * grants updated, a room post). Emitted synchronously after the optional
     * fleet-bus publish, so in-process observers get the fact even when no
     * bus is composed.
     * @param info - the event type + actor + team/room context + JSON payload.
     * @mode emit
     */
    'fleet-teams/event'(info: { type: string; actor: string; teamId?: string; roomId?: string; payload: JsonValue }): void
  }
}

/** Structural fleet-bus surface (avoids importing the concrete service). */
export interface FleetBusLike {
  publish(input: {
    type: string
    scope: 'agent' | 'team' | 'fleet'
    actor: string
    originKind: string
    payload: JsonValue
    fingerprint?: string
  }): unknown
  replay(filter?: { type?: string; scope?: string }, since?: number): FleetBusEvent[]
}

/** Structural fleet-agent (identity) surface for optional event signing. */
export interface AgentIdentityLike {
  sign(input: { type: string; actor: string; payload: JsonValue; ts?: number }): { sig: string; pubkey: string }
}

/** The briefing an agent receives on joining a room (memory + recent events). */
export interface RoomJoinResult {
  readonly room: FleetRoom
  readonly team: FleetTeam
  readonly memoryFile: string
  /** Full durable memory file content (markdown). */
  readonly content: string
  /** The parsed Timeline (post history), oldest-last. */
  readonly recentPosts: RoomPost[]
  /** Recent `fleet/team-post` bus events for this room (live feed), newest-last. */
  readonly recentEvents: FleetBusEvent[]
}

export interface FleetTeamsConfig {
  /** Override the resolved DSH_HOME (test seam; defaults to resolveDshHome()). */
  home?: string
  /**
   * The teams data root. Default `<home>/fleet/teams` — teams.json + the
   * per-room `<roomId>.memory.md` files live here.
   */
  storeDir?: string
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /**
   * Scope governance: when true (default), a scope that does not resolve to a
   * real room is REJECTED by `assertRoomScope` (throws); when false, such a
   * scope is only FLAGGED (`validateScope` returns `ok: false`) without a
   * throw. `validateScope` always reports the unresolvable scope either way.
   */
  strictScopes?: boolean
}

export class FleetTeamsService extends Service {
  private readonly clock: FleetClock
  private readonly storeDir: string
  private readonly strictScopes: boolean
  /** Teams + rooms, durable under teams.json (membership/grants/scope). */
  private readonly teams = new Map<string, FleetTeam>()
  private readonly rooms = new Map<string, FleetRoom>()
  /** Room scope → room id (uniqueness + validation; rebuilt on load). */
  private readonly scopeToRoom = new Map<string, string>()
  /** Shared id sequence for teams + rooms (continues across restarts). */
  private seq = 0

  constructor(ctx: Context, config: FleetTeamsConfig = {}) {
    super(ctx, 'fleetTeams')
    const home = config.home ?? resolveDshHome()
    this.storeDir = config.storeDir ?? join(home, TEAMS_DIR)
    this.clock = config.clock ?? systemClock
    this.strictScopes = config.strictScopes ?? true
    this.loadStore()
  }

  // ---- teams ----

  /**
   * Create a named team and connect the creator to it (auto-join). The team
   * starts with `ALL_GRANTS` defaults unless overridden. Publishes
   * `fleet/team-created`.
   * @param input - team name + optional description/default grants.
   * @param actor - the creating agent.
   * @returns the created team.
   */
  createTeam(input: { name: string; description?: string; defaultGrants?: GrantMask }, actor: string): FleetTeam {
    if (input.name.length === 0) throw new Error('fleet-teams: team name must be non-empty')
    if (actor.length === 0) throw new Error('fleet-teams: team creation requires an actor')
    const team: FleetTeam = {
      id: `team-${++this.seq}`,
      name: input.name,
      ...(input.description !== undefined && input.description.length > 0 ? { description: input.description } : {}),
      createdAt: this.clock.now(),
      defaultGrants: input.defaultGrants ?? { ...ALL_GRANTS },
      memberIds: [actor],
    }
    this.teams.set(team.id, team)
    this.persistStore()
    this.publishEvent(TEAMS_EVENT_TYPES.teamCreated, { teamId: team.id, name: team.name, memberIds: team.memberIds }, actor, { teamId: team.id })
    return team
  }

  /** One team; `undefined` when it does not exist. */
  getTeam(teamId: string): FleetTeam | undefined {
    return this.teams.get(teamId)
  }

  /** All teams, in creation order. */
  listTeams(): FleetTeam[] {
    return [...this.teams.values()]
  }

  /** Connect an agent to a team (membership only; the roster is fleet-agent's). */
  joinTeam(teamId: string, agentId: string): FleetTeam {
    const team = this.requireTeam(teamId)
    if (agentId.length === 0) throw new Error('fleet-teams: joining requires an agent id')
    if (!team.memberIds.includes(agentId)) {
      team.memberIds.push(agentId)
      this.persistStore()
      this.publishEvent(TEAMS_EVENT_TYPES.teamMemberJoined, { teamId, agentId }, agentId, { teamId })
    }
    return team
  }

  /** Disconnect an agent from a team (and from every room of that team). */
  leaveTeam(teamId: string, agentId: string): boolean {
    const team = this.requireTeam(teamId)
    const index = team.memberIds.indexOf(agentId)
    if (index === -1) return false
    team.memberIds.splice(index, 1)
    // Leaving the team removes the agent from all its rooms (membership dies).
    for (const room of this.rooms.values()) {
      if (room.teamId === teamId) this.removeRoomMember(room, agentId, teamId)
    }
    this.persistStore()
    this.publishEvent(TEAMS_EVENT_TYPES.teamMemberLeft, { teamId, agentId }, agentId, { teamId })
    return true
  }

  // ---- rooms ----

  /**
   * Create a room inside a team. The creator must be a team member. The room
   * scope canonically defaults to `room:<roomId>`; a custom scope is allowed
   * but must be unique. Publishes `fleet/room-created`.
   */
  createRoom(input: { teamId: string; name: string; scope?: string; grants?: GrantMask }, actor: string): FleetRoom {
    const team = this.requireTeam(input.teamId)
    if (input.name.length === 0) throw new Error('fleet-teams: room name must be non-empty')
    if (actor.length === 0) throw new Error('fleet-teams: room creation requires an actor')
    if (!team.memberIds.includes(actor)) {
      throw new Error(`fleet-teams: "${actor}" is not a member of team "${input.teamId}"; join the team before creating a room`)
    }
    const id = `room-${++this.seq}`
    const scope = input.scope ?? `room:${id}`
    if (this.scopeToRoom.has(scope)) {
      throw new Error(`fleet-teams: room scope "${scope}" is already used by room "${this.scopeToRoom.get(scope)}"`)
    }
    const room: FleetRoom = {
      id,
      teamId: input.teamId,
      name: input.name,
      scope,
      createdAt: this.clock.now(),
      ...(input.grants !== undefined ? { grants: { ...input.grants } } : {}),
      overrides: {},
      memberIds: [],
    }
    this.rooms.set(id, room)
    this.scopeToRoom.set(scope, id)
    this.ensureMemoryFile(room)
    this.persistStore()
    this.publishEvent(TEAMS_EVENT_TYPES.roomCreated, { roomId: id, teamId: input.teamId, name: room.name, scope }, actor, { teamId: input.teamId, roomId: id })
    return room
  }

  /** One room; `undefined` when it does not exist. */
  getRoom(roomId: string): FleetRoom | undefined {
    return this.rooms.get(roomId)
  }

  /** All rooms, or only those of one team, in creation order. */
  listRooms(teamId?: string): FleetRoom[] {
    const rooms = [...this.rooms.values()]
    return teamId === undefined ? rooms : rooms.filter(room => room.teamId === teamId)
  }

  /**
   * Join a room (the join gate): the agent must be a team member AND hold the
   * effective `join` grant — NOT yet a room member (that is what joining
   * grants). Idempotent. On success the agent receives the room briefing —
   * the shared memory file content + the recent room events (the durable
   * cross-agent context, claude_codex_bridge pattern). Publishes
   * `fleet/room-member-joined`.
   */
  joinRoom(roomId: string, agentId: string): RoomJoinResult {
    const room = this.requireRoom(roomId)
    const team = this.teams.get(room.teamId)
    if (team === undefined || !team.memberIds.includes(agentId)) {
      throw new Error(`fleet-teams: "${agentId}" is not a member of team "${room.teamId}"; join the team before the room`)
    }
    if (!this.can(agentId, room.id, 'join')) {
      throw new Error(`fleet-teams: "${agentId}" does not hold the "join" grant in room "${room.id}"`)
    }
    if (!room.memberIds.includes(agentId)) {
      room.memberIds.push(agentId)
      this.persistStore()
      this.publishEvent(TEAMS_EVENT_TYPES.roomMemberJoined, { roomId, teamId: room.teamId, agentId }, agentId, { teamId: room.teamId, roomId })
    }
    return this.roomBriefing(roomId, agentId)
  }

  /** Leave a room. Returns true when the agent was a member. */
  leaveRoom(roomId: string, agentId: string): boolean {
    const room = this.requireRoom(roomId)
    const left = this.removeRoomMember(room, agentId, room.teamId)
    if (left) this.persistStore()
    return left
  }

  /** The room briefing: memory file + parsed timeline + recent room bus events. */
  roomBriefing(roomId: string, _agentId?: string): RoomJoinResult {
    const room = this.requireRoom(roomId)
    const team = this.requireTeam(room.teamId)
    const memoryFile = this.memoryFilePath(room.id)
    const content = this.readMemoryFile(room.id)
    return {
      room,
      team,
      memoryFile,
      content,
      recentPosts: this.parseTimeline(room.id, content),
      recentEvents: this.recentRoomEvents(room.id),
    }
  }

  // ---- grants ----

  /**
   * The effective grant mask for an agent in a room: a non-member of the team
   * has NO grants; a room member inherits `room.grants` when set, else the
   * team `defaultGrants`; a per-agent override is merged over that base.
   */
  effectiveGrants(agentId: string, roomId: string): GrantMask {
    const room = this.rooms.get(roomId)
    if (room === undefined) return { ...NO_GRANTS }
    const team = this.teams.get(room.teamId)
    if (team === undefined || !team.memberIds.includes(agentId)) return { ...NO_GRANTS }
    const base = room.grants ?? team.defaultGrants
    const override = room.overrides[agentId]
    return override === undefined
      ? { read: base.read, post: base.post, join: base.join }
      : {
          read: override.read ?? base.read,
          post: override.post ?? base.post,
          join: override.join ?? base.join,
        }
  }

  /** True when the agent holds one grant in a room. */
  can(agentId: string, roomId: string, grant: TeamGrant): boolean {
    return this.effectiveGrants(agentId, roomId)[grant]
  }

  /**
   * Replace a team's default grants (the baseline every room member inherits).
   * The actor must be a team member. Publishes `fleet/team-grants-updated`.
   */
  setTeamDefaultGrants(teamId: string, grants: GrantMask, actor: string): FleetTeam {
    const team = this.requireTeam(teamId)
    if (!team.memberIds.includes(actor)) {
      throw new Error(`fleet-teams: "${actor}" is not a member of team "${teamId}"`)
    }
    team.defaultGrants = { read: grants.read, post: grants.post, join: grants.join }
    this.persistStore()
    this.publishEvent(TEAMS_EVENT_TYPES.teamGrantsUpdated, { teamId, grants: { ...team.defaultGrants } }, actor, { teamId })
    return team
  }

  /**
   * Set room grants (replace the room-wide mask, and/or upsert per-agent
   * overrides). The actor must be a room member. Publishes
   * `fleet/room-grants-updated`.
   */
  setRoomGrants(
    roomId: string,
    input: { grants?: GrantMask; overrides?: Record<string, Partial<GrantMask>> },
    actor: string,
  ): FleetRoom {
    const room = this.requireRoom(roomId)
    if (!room.memberIds.includes(actor)) {
      throw new Error(`fleet-teams: "${actor}" is not a member of room "${roomId}"; join before changing grants`)
    }
    if (input.grants !== undefined) {
      room.grants = { read: input.grants.read, post: input.grants.post, join: input.grants.join }
    }
    for (const [agentId, mask] of Object.entries(input.overrides ?? {})) {
      room.overrides[agentId] = { ...(room.overrides[agentId] ?? {}), ...mask }
    }
    this.persistStore()
    this.publishEvent(
      TEAMS_EVENT_TYPES.roomGrantsUpdated,
      { roomId, teamId: room.teamId, grants: room.grants === undefined ? null : { ...room.grants }, overrides: room.overrides },
      actor,
      { teamId: room.teamId, roomId },
    )
    return room
  }

  // ---- team_post + shared-room memory ----

  /**
   * Post a message to a room. Grant-checked (member + `post`). Appends a
   * timeline line to the durable shared-room memory file and publishes
   * `fleet/team-post` (actor, room, body) — signed via fleet-agent when the
   * actor has a profile.
   */
  post(roomId: string, body: string, actor: string): RoomPost {
    const room = this.requireRoom(roomId)
    this.enforce(room, actor, 'post', `post to room "${roomId}"`)
    if (body.length === 0) throw new Error('fleet-teams: post body must be non-empty')
    const post: RoomPost = { id: `post-${room.id}-${this.clock.now()}`, roomId, actor, body, ts: this.clock.now() }
    this.appendTimeline(room, post)
    this.publishEvent(TEAMS_EVENT_TYPES.teamPost, { room: room.id, roomId, teamId: room.teamId, actor, body, ts: post.ts }, actor, { teamId: room.teamId, roomId: room.id })
    return post
  }

  /**
   * Read the shared-room memory (grant-checked: member + `read`): the durable
   * file content + the parsed timeline (the post history).
   */
  readMemory(roomId: string, agentId: string): RoomMemoryView {
    const room = this.requireRoom(roomId)
    this.enforce(room, agentId, 'read', `read room "${roomId}" memory`)
    const team = this.requireTeam(room.teamId)
    const memoryFile = this.memoryFilePath(room.id)
    const content = this.readMemoryFile(room.id)
    return { room, team, memoryFile, content, recentPosts: this.parseTimeline(room.id, content) }
  }

  /**
   * Append a context note into one memory-file section (Decisions / Links /
   * Task refs). Grant-checked like a post (member + `post`) — writing room
   * context IS posting. Publishes `fleet/team-post` with a `kind:
   * 'context-note'` marker so the board feed sees the activity.
   */
  appendMemory(roomId: string, section: string, note: string, actor: string): RoomMemoryView {
    const room = this.requireRoom(roomId)
    this.enforce(room, actor, 'post', `append to room "${roomId}" memory`)
    if (note.length === 0) throw new Error('fleet-teams: memory note must be non-empty')
    if (!(ROOM_MEMORY_SECTIONS as readonly string[]).includes(section)) {
      throw new Error(`fleet-teams: unknown memory section "${section}" (one of ${ROOM_MEMORY_SECTIONS.join(', ')})`)
    }
    this.appendSectionNote(room, section, note, actor)
    this.publishEvent(
      TEAMS_EVENT_TYPES.teamPost,
      { room: room.id, roomId, teamId: room.teamId, actor, body: note, section, kind: 'context-note', ts: this.clock.now() },
      actor,
      { teamId: room.teamId, roomId: room.id },
    )
    return this.readMemory(roomId, actor)
  }

  /** Recent `fleet/team-post` events for a room (live feed), newest-last. */
  recentRoomEvents(roomId: string, limit = 20): FleetBusEvent[] {
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus === undefined || typeof bus.replay !== 'function') return []
    return bus
      .replay({ type: TEAMS_EVENT_TYPES.teamPost })
      .filter(event => (event.payload as { room?: string })?.room === roomId)
      .slice(-Math.max(1, limit))
  }

  // ---- scope validation ----

  /** The canonical bus scope reference for a room. */
  roomScope(roomId: string): string {
    const room = this.requireRoom(roomId)
    return room.scope
  }

  /**
   * Validate a bus scope string: `room:<id>` / a bare room id resolve to a
   * real room (`kind: 'room'`); `team:<id>` resolves to a real team
   * (`kind: 'team'`). Anything else is a FREE-FORM scope without a room →
   * `{ ok: false, reason }` (flagged; rejected per `strictScopes` via
   * `assertRoomScope`).
   */
  validateScope(scope: string): RoomScopeValidation {
    if (typeof scope !== 'string' || scope.length === 0) {
      return { ok: false, scope, reason: 'empty scope' }
    }
    const roomPrefix = scope.startsWith('room:')
    const teamPrefix = scope.startsWith('team:')
    const candidate = roomPrefix ? scope.slice('room:'.length) : teamPrefix ? scope.slice('team:'.length) : scope
    if (roomPrefix || !teamPrefix) {
      const roomId = this.scopeToRoom.get(scope) ?? (roomPrefix ? this.rooms.get(candidate)?.id : this.rooms.get(candidate)?.id)
      const room = roomId !== undefined ? this.rooms.get(roomId) : undefined
      if (room !== undefined) {
        return { ok: true, kind: 'room', roomId: room.id, teamId: room.teamId, scope }
      }
    }
    if (teamPrefix) {
      const team = this.teams.get(candidate)
      if (team !== undefined) return { ok: true, kind: 'team', teamId: team.id, scope }
    }
    const reason = roomPrefix || teamPrefix
      ? `scope "${scope}" does not resolve to a real room or team`
      : `free-form scope "${scope}" has no room; use room:<roomId> or team:<teamId>`
    return { ok: false, scope, reason }
  }

  /**
   * The strict gate: when `strictScopes` (default), a scope that does not
   * resolve to a real ROOM throws (free-form / team-only scopes are rejected
   * for room-bound publication). Returns the resolved room when OK.
   */
  assertRoomScope(scope: string): FleetRoom {
    const validation = this.validateScope(scope)
    if (validation.ok && validation.kind === 'room' && validation.roomId !== undefined) {
      return this.requireRoom(validation.roomId)
    }
    if (validation.ok && validation.kind === 'team') {
      throw new Error(`fleet-teams: scope "${scope}" is a team scope, not a room scope (rejected by strictScopes)`)
    }
    if (!this.strictScopes) return validation as never
    throw new Error(`fleet-teams: ${validation.reason ?? `scope "${scope}" is not a room scope`} (strictScopes)`)
  }

  // ---- internals ----

  /** Grant enforcement: the agent must be a room member with the grant. */
  private enforce(room: FleetRoom, agentId: string, grant: TeamGrant, verb: string): void {
    if (!room.memberIds.includes(agentId)) {
      throw new Error(`fleet-teams: "${agentId}" is not a member of room "${room.id}"; join before ${verb}`)
    }
    if (!this.can(agentId, room.id, grant)) {
      throw new Error(`fleet-teams: "${agentId}" does not hold the "${grant}" grant in room "${room.id}" (cannot ${verb})`)
    }
  }

  private requireTeam(teamId: string): FleetTeam {
    const team = this.teams.get(teamId)
    if (team === undefined) throw new Error(`fleet-teams: team "${teamId}" not found`)
    return team
  }

  private requireRoom(roomId: string): FleetRoom {
    const room = this.rooms.get(roomId)
    if (room === undefined) throw new Error(`fleet-teams: room "${roomId}" not found`)
    return room
  }

  private removeRoomMember(room: FleetRoom, agentId: string, teamId: string): boolean {
    const index = room.memberIds.indexOf(agentId)
    if (index === -1) return false
    room.memberIds.splice(index, 1)
    this.publishEvent(TEAMS_EVENT_TYPES.roomMemberLeft, { roomId: room.id, teamId, agentId }, agentId, { teamId, roomId: room.id })
    return true
  }

  // ---- memory file (markdown, the durable room context) ----

  /** `<storeDir>/<roomId>.memory.md` — the spec's `$DSH_HOME/fleet/teams/<room>.memory.md`. */
  memoryFilePath(roomId: string): string {
    return join(this.storeDir, `${roomId}.memory.md`)
  }

  private ensureMemoryFile(room: FleetRoom): void {
    const file = this.memoryFilePath(room.id)
    try {
      readFileSync(file, 'utf8')
    } catch {
      this.writeMemoryFile(room, initialMemoryContent(room))
    }
  }

  private readMemoryFile(roomId: string): string {
    try {
      return readFileSync(this.memoryFilePath(roomId), 'utf8')
    } catch {
      return ''
    }
  }

  private writeMemoryFile(room: FleetRoom, content: string): void {
    mkdirSync(this.storeDir, { recursive: true })
    const file = this.memoryFilePath(room.id)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, content, { encoding: 'utf8' })
    renameSync(tmp, file)
  }

  /** Append one timeline (post) line to the memory file (the last section). */
  private appendTimeline(room: FleetRoom, post: RoomPost): void {
    const current = this.readMemoryFile(room.id)
    if (current === '') {
      this.writeMemoryFile(room, `${initialMemoryContent(room)}\n${timelineLine(post)}\n`)
      return
    }
    this.writeMemoryFile(room, `${current.replace(/\s*$/, '')}\n${timelineLine(post)}\n`)
  }

  /** Insert a `- …` note line right after a `## <Section>` header. */
  private appendSectionNote(room: FleetRoom, section: string, note: string, actor: string): void {
    const current = this.readMemoryFile(room.id)
    const body = current === '' ? initialMemoryContent(room) : current
    const lines = body.split('\n')
    const header = `## ${section}`
    const headerIndex = lines.findIndex(line => line === header)
    if (headerIndex === -1) {
      throw new Error(`fleet-teams: memory file for room "${room.id}" has no "${header}" section`)
    }
    const entry = `- ${formatTime(this.clock.now())} **${actor}**: ${normalizeBody(note)}`
    const placeholderIndex = lines.findIndex((line, index) => index > headerIndex && line.trim() !== '' && !line.startsWith('-'))
    const placeholder = placeholderIndex !== -1 && lines[placeholderIndex]!.trim() === '(nothing yet)'
    if (placeholder) {
      lines[placeholderIndex!] = entry
    } else {
      let insertAt = headerIndex + 1
      while (insertAt < lines.length && lines[insertAt]!.trim() === '') insertAt += 1
      lines.splice(insertAt, 0, entry)
    }
    this.writeMemoryFile(room, `${lines.join('\n').replace(/\s*$/, '')}\n`)
  }

  /** Parse the Timeline section back into posts (the durable post history). */
  private parseTimeline(roomId: string, content: string): RoomPost[] {
    if (content.length === 0) return []
    const posts: RoomPost[] = []
    let inTimeline = false
    for (const line of content.split('\n')) {
      if (line === '## Timeline') {
        inTimeline = true
        continue
      }
      if (inTimeline && line.startsWith('## ')) break
      if (!inTimeline) continue
      const match = /^\- `([^`]+)` \*\*(.+?)\*\*: (.*)$/.exec(line)
      if (match === null) continue
      const ts = Date.parse(match[1]!)
      posts.push({
        id: `post-${roomId}-${match[1]!}`,
        roomId,
        actor: match[2]!,
        body: match[3]!,
        ts: Number.isNaN(ts) ? 0 : ts,
      })
    }
    return posts
  }

  // ---- durable store (teams.json) ----

  private loadStore(): void {
    let text: string
    try {
      text = readFileSync(join(this.storeDir, TEAMS_STORE_FILE), 'utf8')
    } catch {
      return
    }
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const record = parsed as Record<string, unknown>
    if (typeof record.seq === 'number') this.seq = record.seq
    const teams = record.teams as Record<string, unknown> | undefined
    if (teams !== null && typeof teams === 'object') {
      for (const [teamId, raw] of Object.entries(teams)) {
        const entry = raw as Record<string, unknown>
        const memberIds = Array.isArray(entry.memberIds)
          ? entry.memberIds.filter((id): id is string => typeof id === 'string')
          : []
        const defaultGrants = entry.defaultGrants as Record<string, unknown> | undefined
        this.teams.set(teamId, {
          id: teamId,
          name: typeof entry.name === 'string' ? entry.name : teamId,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          defaultGrants: grantsFromRecord(defaultGrants),
          memberIds,
        })
      }
    }
    const rooms = record.rooms as Record<string, unknown> | undefined
    if (rooms !== null && typeof rooms === 'object') {
      for (const [roomId, raw] of Object.entries(rooms)) {
        const entry = raw as Record<string, unknown>
        const memberIds = Array.isArray(entry.memberIds)
          ? entry.memberIds.filter((id): id is string => typeof id === 'string')
          : []
        const overrides = entry.overrides as Record<string, Record<string, unknown>> | undefined
        const overridesRecord: Record<string, Partial<GrantMask>> = {}
        if (overrides !== null && typeof overrides === 'object') {
          for (const [agentId, mask] of Object.entries(overrides)) {
            if (mask === null || typeof mask !== 'object') continue
            const partial: Partial<GrantMask> = {
              ...(typeof mask.read === 'boolean' ? { read: mask.read } : {}),
              ...(typeof mask.post === 'boolean' ? { post: mask.post } : {}),
              ...(typeof mask.join === 'boolean' ? { join: mask.join } : {}),
            }
            overridesRecord[agentId] = partial
          }
        }
        const scope = typeof entry.scope === 'string' ? entry.scope : `room:${roomId}`
        const room: FleetRoom = {
          id: roomId,
          teamId: typeof entry.teamId === 'string' ? entry.teamId : '',
          name: typeof entry.name === 'string' ? entry.name : roomId,
          scope,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          ...(entry.grants !== undefined ? { grants: grantsFromRecord(entry.grants as Record<string, unknown>) } : {}),
          overrides: overridesRecord,
          memberIds,
        }
        this.rooms.set(roomId, room)
        this.scopeToRoom.set(scope, roomId)
      }
    }
  }

  private persistStore(): void {
    mkdirSync(this.storeDir, { recursive: true })
    const file = join(this.storeDir, TEAMS_STORE_FILE)
    const tmp = `${file}.tmp`
    const payload = {
      seq: this.seq,
      teams: Object.fromEntries(this.teams),
      rooms: Object.fromEntries(this.rooms),
    }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' })
    renameSync(tmp, file)
  }

  // ---- events ----

  /**
   * Publish a teams event on the fleet-bus (when composed), with
   * `originKind: 'teams'` (self-trigger guard) and, when the actor has a
   * fleet-agent profile, an ed25519 signature embedded in the payload.
   * Best-effort: absent bus/identity degrades to a debug log / unsigned event.
   */
  private publishEvent(type: string, payload: Record<string, JsonValue | null | undefined>, actor: string, context: { teamId?: string; roomId?: string } = {}): void {
    const cleanPayload: Record<string, JsonValue> = Object.fromEntries(
      Object.entries(payload).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
    )
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus === undefined || typeof bus.publish !== 'function') {
      this.ctx.logger.debug(`fleet-teams: no fleet-bus composed; ${type} not published`)
    } else {
      let body: JsonValue = cleanPayload
      const identity = this.resolveAgentIdentity()
      if (identity !== undefined) {
        try {
          const signed = identity.sign({ type, actor, payload: cleanPayload, ts: this.clock.now() })
          body = { ...cleanPayload, signed: signed as unknown as JsonValue }
        } catch (error) {
          this.ctx.logger.debug(
            `fleet-teams: signing ${type} skipped — ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      bus.publish({ type, scope: 'team', actor, originKind: TEAMS_ORIGIN_KIND, payload: body })
    }
    this.ctx.emit('fleet-teams/event', { type, actor, ...(context.teamId !== undefined ? { teamId: context.teamId } : {}), ...(context.roomId !== undefined ? { roomId: context.roomId } : {}), payload: cleanPayload })
  }

  /**
   * Resolve the optional fleet-agent (identity) service for signing (the
   * `fleetAgent` ctx key, resolved optionally per the AGENTS.md optional
   * service rule).
   */
  private resolveAgentIdentity(): AgentIdentityLike | undefined {
    const identity = this.ctx.get('fleetAgent') as AgentIdentityLike | undefined
    if (identity !== undefined && typeof (identity as { sign?: unknown }).sign === 'function') return identity
    return undefined
  }
}

/** Default content of a fresh room memory file (sections + empty timeline). */
function initialMemoryContent(room: FleetRoom): string {
  const lines = [
    `# ${room.name} — room memory`,
    '',
    '> Shared durable room context (fleet-teams P4.1, claude_codex_bridge pattern).',
    `> Team: ${room.teamId} · Room scope: \`${room.scope}\` · Room id: \`${room.id}\`.`,
    '> Appended by team_post / room_memory; reloaded from disk on every boot.',
    '',
    '## Decisions',
    '(nothing yet)',
    '',
    '## Links',
    '(nothing yet)',
    '',
    '## Task refs',
    '(nothing yet)',
    '',
    '## Timeline',
    '',
  ]
  return `${lines.join('\n')}`
}

/** One timeline line: `` - `iso` **actor**: body `` (strictly parseable). */
function timelineLine(post: RoomPost): string {
  return `- \`${formatTime(post.ts)}\` **${post.actor}**: ${normalizeBody(post.body)}`
}

/** ISO-8601 UTC time for a clock ts (the timeline parse key). */
function formatTime(ts: number): string {
  return new Date(ts).toISOString()
}

/** Single-line body: newlines / tabs collapse to " / " (timeline is one line). */
function normalizeBody(body: string): string {
  return body.replace(/[\r\n\t]+/g, ' / ')
}

/** Rebuild a full GrantMask from a partial record (missing → false). */
function grantsFromRecord(record: Record<string, unknown> | undefined): GrantMask {
  return {
    read: record?.read === true,
    post: record?.post === true,
    join: record?.join === true,
  }
}
