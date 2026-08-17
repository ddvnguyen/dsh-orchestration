/**
 * @hydra/dsh-fleet-teams — the V3 social top layer: teams + rooms + grants +
 * team_post + the shared-room memory file (issue #26, orchestration-v3 §4
 * P4.1).
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`). It constructs the
 * {@link FleetTeamsService} (registers `ctx.fleetTeams`) and registers the
 * model-facing team_* / room_* tools on the global `ctx.tools` registry (the
 * fleet-tasks pattern, plugins/fleet-tasks/src/index.ts:87) so ANY in-process
 * agent can convene with other agents around real work.
 *
 * ```
 * - id: fleet-teams
 *   name: '@hydra/dsh-fleet-teams'
 *   config:
 *     strictScopes: true    # a bus scope without a real room is REJECTED
 *                           # (false = only flagged by validateScope)
 * ```
 *
 * A TEAM only CONNECTS agents to a team — membership + grants, nothing else
 * (agent-specific config lives in fleet-agent, P4.3). Rooms are where teams
 * convene; grants (read/post/join) are enforced on the join/post/read APIs;
 * `team_post` publishes `fleet/team-post` (actor, room, body) and appends the
 * durable shared-room memory file (`$DSH_HOME/fleet/teams/<room>.memory.md`,
 * claude_codex_bridge pattern) that survives restart. Bus scope validation is
 * the reason teams is built last: `team_scope` resolves a room scope to a real
 * room and flags/rejects free-form scopes per `strictScopes`.
 *
 * Deps: none required. `ctx.fleetBus` / `ctx.fleetAgent` are optional seams
 * resolved at event time (fleetIdentity accepted as a legacy rename
 * fallback). Events publish with `originKind: 'teams'` (self-trigger guard),
 * signed via the actor's fleet-agent profile when available.
 * @module @hydra/dsh-fleet-teams
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { FleetTeamsService, type FleetTeamsConfig } from './service.ts'
import type { GrantMask } from './types.ts'

export const name = 'fleet-teams'
/** fleet-bus / fleet-agent are optional seams, never required. */
export const inject: string[] = ['tools']

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetTeamsConfig {
  /** Register the team/room tools on ctx.tools (default true). Host-plane compositions set false. */
  injectTools: boolean
}

export const Config: z<Config> = z.object({
  /** Override the resolved DSH_HOME (tests only). */
  home: z.string(),
  /** Teams data root (default `<home>/fleet/teams`). */
  storeDir: z.string(),
  /** Injectable clock (tests only). */
  clock: z.any(),
  /** Free-form scopes without a real room are rejected (default true). */
  strictScopes: z.boolean().default(true),
  /** Register tools (default true). Host-plane compositions set false. */
  injectTools: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const teams = new FleetTeamsService(ctx, config)
  if (config.injectTools) {
    registerFleetTeamsTools(ctx, teams)
  }
}

/** Narrow a JSON output value to a record for render-time shaping. */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Scoped tools only run inside an agent; a caller without one has no id. */
function requireAgent(agent: { id: string } | undefined): { id: string } {
  if (agent === undefined) {
    throw new Error('fleet tools require an owning agent session')
  }
  return agent
}

/** Read the three optional grant booleans from tool args (undefined = unset). */
function grantsFromArgs(args: Record<string, unknown>): Partial<GrantMask> | undefined {
  const read = typeof args.read === 'boolean' ? args.read : undefined
  const post = typeof args.post === 'boolean' ? args.post : undefined
  const join = typeof args.join === 'boolean' ? args.join : undefined
  if (read === undefined && post === undefined && join === undefined) return undefined
  return {
    ...(read !== undefined ? { read } : {}),
    ...(post !== undefined ? { post } : {}),
    ...(join !== undefined ? { join } : {}),
  }
}

/** Register the fleet-teams tools on the global tools registry. */
function registerFleetTeamsTools(ctx: Context, teams: FleetTeamsService): void {
  ctx.tools.register(defineTool({
    name: 'team_create',
    description: 'Create a named team and connect the calling agent to it. A team CONNECTS agents (membership + grants ONLY — ' +
      'agent-specific config lives in fleet-agent). The creator is the first member; the team starts with read/post/join ' +
      'grants for everyone unless overridden later via team_grants / room_grants.',
    parameters: {
      name: { type: 'string', required: true, description: 'Team name.' },
      description: { type: 'string', description: 'Optional purpose note.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Team ${String(record?.name ?? '?')} (${String(record?.id ?? '?')}) — ${(record?.memberIds as unknown as unknown[] | undefined)?.length ?? 0} member(s)` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const team = teams.createTeam({ name: args.name as string, ...(args.description !== undefined ? { description: args.description as string } : {}) }, agent.id)
      return { id: team.id, name: team.name, description: team.description ?? null, memberIds: team.memberIds, defaultGrants: team.defaultGrants } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Create fleet team', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_join',
    description: 'Connect the calling agent to a team (membership only — the roster itself comes from fleet-agent profiles). ' +
      'Membership is the precondition for joining its rooms.',
    parameters: {
      teamId: { type: 'string', required: true, description: 'The team id to join.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Joined team ${String(record?.name ?? '?')} (${String(record?.id ?? '?')})` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const team = teams.joinTeam(args.teamId as string, agent.id)
      return { id: team.id, name: team.name, memberIds: team.memberIds } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Join fleet team', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_leave',
    description: 'Disconnect the calling agent from a team (and from every room of that team).',
    parameters: {
      teamId: { type: 'string', required: true, description: 'The team id to leave.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: record?.left === true ? `Left team ${String(record.teamId)}` : `Not a member of ${String(record?.teamId ?? '?')}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const left = teams.leaveTeam(args.teamId as string, agent.id)
      return { teamId: args.teamId, left } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Leave fleet team', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_list',
    description: 'Every fleet team with its members and rooms, plus the calling agent\'s effective grants in each room.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const count = (record?.teams as unknown as unknown[] | undefined)?.length ?? 0
        return [{ type: 'text', text: `Fleet teams: ${count}` }]
      },
    },
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent)
      return {
        teams: teams.listTeams().map(team => ({
          id: team.id,
          name: team.name,
          memberIds: team.memberIds,
          defaultGrants: team.defaultGrants,
          rooms: teams.listRooms(team.id).map(room => ({
            id: room.id,
            name: room.name,
            scope: room.scope,
            memberIds: room.memberIds,
            grants: room.grants ?? null,
            effective: teams.effectiveGrants(agent.id, room.id),
          })),
        })),
      } as unknown as JsonValue
    },
    presentCall: () => ({ card: 'generic', title: 'List fleet teams', kind: 'other', rawInput: null }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_grants',
    description: 'View or replace a team\'s DEFAULT grants (read/post/join) — the baseline every room member inherits unless a room ' +
      'overrides it. Omit all three to just view the current defaults. The calling agent must be a team member to change them.',
    parameters: {
      teamId: { type: 'string', required: true, description: 'The team id.' },
      read: { type: 'boolean', description: 'Grant room memory reads.' },
      post: { type: 'boolean', description: 'Grant room posting.' },
      join: { type: 'boolean', description: 'Grant room joining.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const grants = asRecord(record?.defaultGrants as JsonValue | undefined)
        const text = grants === undefined ? 'No grants' : `read=${String(grants.read)} post=${String(grants.post)} join=${String(grants.join)}`
        return [{ type: 'text', text: `Team ${String(record?.name ?? '?')} default grants: ${text}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const mask = grantsFromArgs(args)
      if (mask !== undefined) {
        teams.setTeamDefaultGrants(args.teamId as string, { read: mask.read ?? false, post: mask.post ?? false, join: mask.join ?? false }, agent.id)
      }
      const team = teams.getTeam(args.teamId as string)!
      return { teamId: team.id, name: team.name, defaultGrants: team.defaultGrants } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Team default grants', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'room_create',
    description: 'Create a room inside a team — the durable place the team convenes around work. The calling agent must be a team ' +
      'member. Room members inherit the team default grants unless the room overrides them (room_grants). ' +
      'The room scope canonically is room:<roomId>; a custom scope must be unique.',
    parameters: {
      teamId: { type: 'string', required: true, description: 'The owning team id.' },
      name: { type: 'string', required: true, description: 'Room name.' },
      scope: { type: 'string', description: 'Optional custom bus scope reference (default room:<roomId>).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Room ${String(record?.name ?? '?')} (${String(record?.id ?? '?')}) scope=${String(record?.scope ?? '?')}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const room = teams.createRoom({ teamId: args.teamId as string, name: args.name as string, ...(args.scope !== undefined ? { scope: args.scope as string } : {}) }, agent.id)
      return { id: room.id, teamId: room.teamId, name: room.name, scope: room.scope, createdAt: room.createdAt } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Create fleet room', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'room_join',
    description: 'Join a room (requires team membership + the join grant). Joining delivers the room BRIEFING: the shared-room memory ' +
      'file content (decisions/links/task refs + the timeline of past posts) and the recent room events — the durable cross-agent ' +
      'context the room is built around.',
    parameters: {
      roomId: { type: 'string', required: true, description: 'The room id to join.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const room = asRecord(record?.room as JsonValue | undefined)
        return [{ type: 'text', text: `Joined room ${String(room?.name ?? '?')} — memory ${String(record?.memoryFile ?? '?')}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const briefing = teams.joinRoom(args.roomId as string, agent.id)
      return {
        room: { id: briefing.room.id, teamId: briefing.room.teamId, name: briefing.room.name, scope: briefing.room.scope },
        teamId: briefing.team.id,
        memoryFile: briefing.memoryFile,
        memory: briefing.content,
        recentPosts: briefing.recentPosts,
        recentEvents: briefing.recentEvents.map(event => ({ id: event.id, type: event.type, actor: event.actor, ts: event.ts, payload: event.payload })),
      } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Join fleet room', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'room_leave',
    description: 'Leave a room (membership drops; grants no longer apply).',
    parameters: {
      roomId: { type: 'string', required: true, description: 'The room id to leave.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: record?.left === true ? `Left room ${String(record.roomId)}` : `Not a member of ${String(record?.roomId ?? '?')}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const left = teams.leaveRoom(args.roomId as string, agent.id)
      return { roomId: args.roomId, left } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Leave fleet room', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'room_list',
    description: 'Every fleet room (optionally only those of one team) with membership, scope, and the calling agent\'s effective grants.',
    parameters: {
      teamId: { type: 'string', description: 'Optional team id to filter by.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const count = (record?.rooms as unknown as unknown[] | undefined)?.length ?? 0
        return [{ type: 'text', text: `Fleet rooms: ${count}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      return {
        rooms: teams.listRooms(args.teamId as string | undefined).map(room => ({
          id: room.id,
          teamId: room.teamId,
          name: room.name,
          scope: room.scope,
          memberIds: room.memberIds,
          grants: room.grants ?? null,
          effective: teams.effectiveGrants(agent.id, room.id),
        })),
      } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'List fleet rooms', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'room_grants',
    description: 'View or set a room\'s grants: the room-wide read/post/join mask (overrides the team defaults for this room) and/or ' +
      'per-agent overrides (upserted). Omit everything to view your own effective grants. The calling agent must be a room member ' +
      'to change grants. Set a boolean to false to revoke, true to grant.',
    parameters: {
      roomId: { type: 'string', required: true, description: 'The room id.' },
      read: { type: 'boolean', description: 'Room-wide read grant.' },
      post: { type: 'boolean', description: 'Room-wide post grant.' },
      join: { type: 'boolean', description: 'Room-wide join grant.' },
      overrides: {
        type: 'array',
        description: 'Per-agent grant overrides to upsert: [{ agentId, read?, post?, join? }].',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agentId: { type: 'string' },
            read: { type: 'boolean' },
            post: { type: 'boolean' },
            join: { type: 'boolean' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const grants = asRecord(record?.grants as JsonValue | undefined)
        const text = grants === undefined ? 'inherits team defaults' : `read=${String(grants.read)} post=${String(grants.post)} join=${String(grants.join)}`
        return [{ type: 'text', text: `Room ${String(record?.name ?? '?')} grants: ${text}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const roomId = args.roomId as string
      const mask = grantsFromArgs(args)
      const overrides = args.overrides as Array<{ agentId: string; read?: boolean; post?: boolean; join?: boolean }> | undefined
      if (mask !== undefined || (overrides !== undefined && overrides.length > 0)) {
        const overrideRecord: Record<string, Partial<GrantMask>> = {}
        for (const entry of overrides ?? []) {
          if (typeof entry?.agentId !== 'string') continue
          const partial: Partial<GrantMask> = {
            ...(typeof entry.read === 'boolean' ? { read: entry.read } : {}),
            ...(typeof entry.post === 'boolean' ? { post: entry.post } : {}),
            ...(typeof entry.join === 'boolean' ? { join: entry.join } : {}),
          }
          overrideRecord[entry.agentId] = partial
        }
        teams.setRoomGrants(roomId, { ...(mask !== undefined ? { grants: { read: mask.read ?? false, post: mask.post ?? false, join: mask.join ?? false } } : {}), overrides: overrideRecord }, agent.id)
      }
      const room = teams.getRoom(roomId)!
      return {
        roomId: room.id,
        name: room.name,
        scope: room.scope,
        grants: room.grants ?? null,
        overrides: room.overrides,
        effective: teams.effectiveGrants(agent.id, roomId),
      } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Room grants', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_post',
    description: 'Post a message to a room (grant-checked: room member + post grant). The post is appended to the room\'s durable ' +
      'shared memory file and published as a fleet/team-post bus event (actor, room, body) that the board feed renders.',
    parameters: {
      roomId: { type: 'string', required: true, description: 'The room id to post into.' },
      body: { type: 'string', required: true, description: 'The message body.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `${String(record?.actor ?? '?')} → ${String(record?.room ?? '?')}: ${String(record?.body ?? '').slice(0, 80)}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const post = teams.post(args.roomId as string, args.body as string, agent.id)
      return { room: post.roomId, actor: post.actor, body: post.body, ts: post.ts } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Post to fleet room', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'room_memory',
    description: 'Read the room\'s shared memory (grant-checked: room member + read grant): the durable memory file — Decisions / ' +
      'Links / Task refs sections plus the timeline of past posts. With `section` + `note`, APPEND a context note into a section ' +
      '(grant-checked like a post): Decisions, Links, or Task refs.',
    parameters: {
      roomId: { type: 'string', required: true, description: 'The room id.' },
      section: { type: 'string', description: 'Append a note into this section (Decisions / Links / Task refs).' },
      note: { type: 'string', description: 'The context note to append (requires section).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const posts = (record?.recentPosts as unknown as unknown[] | undefined)?.length ?? 0
        return [{ type: 'text', text: `Room memory ${String(record?.memoryFile ?? '?')} — ${posts} post(s)` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const roomId = args.roomId as string
      if (args.section !== undefined || args.note !== undefined) {
        if (typeof args.section !== 'string' || typeof args.note !== 'string') {
          throw new Error('room_memory: section and note are both required to append a context note')
        }
        const view = teams.appendMemory(roomId, args.section, args.note, agent.id)
        return { memoryFile: view.memoryFile, content: view.content, recentPosts: view.recentPosts } as unknown as JsonValue
      }
      const view = teams.readMemory(roomId, agent.id)
      return { roomId, memoryFile: view.memoryFile, content: view.content, recentPosts: view.recentPosts } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Read room memory', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_scope',
    description: 'Validate a fleet-bus scope string against the real rooms/teams: room:<roomId> or a bare room id resolve to a real ' +
      'room; team:<teamId> to a real team. A free-form scope without a room is flagged (ok:false) and, under strictScopes, ' +
      'rejected for room-bound publication. This is why teams is the last fleet plugin: bus scopes stop being free-form.',
    parameters: {
      scope: { type: 'string', required: true, description: 'The scope string to validate (e.g. "room:room-1", "team:team-1", or garbage).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const ok = record?.ok === true
        return [{ type: 'text', text: ok ? `Scope resolves to ${String(record?.kind ?? '?')} ${String(record?.roomId ?? record?.teamId ?? '?')}` : `Scope rejected: ${String(record?.reason ?? '?')}` }]
      },
    },
    async execute(args, exec) {
      requireAgent(exec.agent)
      return teams.validateScope(args.scope as string) as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Validate fleet room scope', kind: 'other', rawInput: args }),
  }))
}
