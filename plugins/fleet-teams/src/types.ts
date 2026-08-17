/**
 * fleet-teams vocabulary (issue #26, orchestration-v3 §4 P4.1).
 *
 * The V3 social top layer: teams + rooms + grants + team_post + the
 * shared-room memory file. A TEAM only CONNECTS agents to a team — membership
 * + grants, nothing else (agent-specific config lives in fleet-agent, P4.3).
 *
 * - A **team** is a named group of agents (membership = a list of agent ids;
 *   the agent roster itself comes from the fleet-agent identity profiles —
 *   referenced, never duplicated here). A team carries `defaultGrants` (read /
 *   post / join) that apply to its members in every room unless a room
 *   overrides them.
 * - A **room** belongs to a team. It is where agents convene around real work
 *   (tasks + the board feed). Room members inherit the team default grants
 *   unless the room overrides them (`grants` replaces the team defaults for the
 *   room; `overrides[agentId]` is a per-agent partial mask merged over that).
 * - **Grants** are enforced on the join / post / read APIs: `join` to enter a
 *   room, `post` to write, `read` to read the room memory. A non-member has NO
 *   grants — joining is the gate.
 * - A **room scope** is the bus scope reference for the room (canonically
 *   `room:<roomId>`). Scope validation (why teams is built last): a room scope
 *   must resolve to a real room id; free-form scopes without a room are
 *   flagged / rejected per the `strictScopes` config.
 * - The **shared-room memory file** (claude_codex_bridge pattern) is a per-room
 *   durable markdown file at `$DSH_HOME/fleet/teams/<roomId>.memory.md` —
 *   decisions / links / task refs sections plus an append-only Timeline that
 *   doubles as the durable post history. It survives restart (file on disk,
 *   reloaded on boot); agents joining a room receive its content + the recent
 *   room events.
 * @module @hydra/dsh-fleet-teams/types
 */

/** A grant an agent can hold in a room. */
export type TeamGrant = 'read' | 'post' | 'join'

/** The three grants a team/room governs. */
export type TeamGrantName = TeamGrant

/** Full grant mask. `read` / `post` / `join` default true on team creation. */
export interface GrantMask {
  readonly read: boolean
  readonly post: boolean
  readonly join: boolean
}

/** Every grant granted (a fresh team's default). */
export const ALL_GRANTS: GrantMask = { read: true, post: true, join: true }

/** No grants (a non-member, or a fully locked-down room). */
export const NO_GRANTS: GrantMask = { read: false, post: false, join: false }

/**
 * One named team — a group of agents. Membership is a list of agent ids only;
 * the agent roster lives in the fleet-agent identity profiles (referenced, not
 * duplicated — P4.1 owns membership + grants ONLY).
 */
export interface FleetTeam {
  /** Stable identity (`team-<n>`). */
  readonly id: string
  /** Human label. */
  readonly name: string
  /** Optional purpose note. */
  readonly description?: string
  /** Unix epoch ms (service clock) the team was created. */
  readonly createdAt: number
  /**
   * The team-wide default grants, inherited by every member in every room
   * unless a room overrides them.
   */
  defaultGrants: GrantMask
  /** Agents connected to the team (the roster is fleet-agent's, not this). */
  readonly memberIds: string[]
}

/**
 * One room inside a team — the durable place agents convene around work.
 * Room members inherit the team `defaultGrants` unless the room overrides.
 */
export interface FleetRoom {
  /** Stable identity (`room-<n>`). */
  readonly id: string
  /** The owning team. */
  readonly teamId: string
  /** Human label. */
  readonly name: string
  /**
   * The bus scope reference for the room — canonically `room:<roomId>`; a
   * custom scope may be set at creation (must be unique). `validateScope`
   * resolves any scope string against these.
   */
  scope: string
  /** Unix epoch ms (service clock) the room was created. */
  readonly createdAt: number
  /**
   * Room-wide grants; when set they REPLACE the team default grants for room
   * members. Undefined → members fall through to the team `defaultGrants`.
   */
  grants?: GrantMask
  /**
   * Per-agent partial overrides, merged over the effective (room-or-team)
   * base. An override may set any subset of the three grants; unset fields
   * fall through.
   */
  readonly overrides: Record<string, Partial<GrantMask>>
  /** Agents who joined the room (membership is the join gate). */
  readonly memberIds: string[]
}

/** One room post — the durable timeline entry. */
export interface RoomPost {
  /** Stable identity. */
  readonly id: string
  readonly roomId: string
  /** The posting agent id. */
  readonly actor: string
  /** The message body. */
  readonly body: string
  /** Unix epoch ms (service clock). */
  readonly ts: number
}

/** What a scope string resolves to (or why it does not). */
export interface RoomScopeValidation {
  /** True when the scope resolves to a real room or team. */
  readonly ok: boolean
  /** `room` when it resolves to a room, `team` when to a team. */
  readonly kind?: 'room' | 'team'
  /** The resolved room id (when kind is `room`). */
  readonly roomId?: string
  /** The resolved team id (when kind is `team`, or the room's team). */
  readonly teamId?: string
  /** The scope string as given. */
  readonly scope?: string
  /** Why a scope did not resolve (flagged/rejected per strictScopes). */
  readonly reason?: string
}

/**
 * The shared-room memory view: the durable memory file + its parsed timeline
 * (the post history) + the room/team context. Delivered on join and by
 * `readMemory`.
 */
export interface RoomMemoryView {
  readonly room: FleetRoom
  readonly team: FleetTeam
  /** Absolute path of the durable memory file (`$DSH_HOME/fleet/teams/<roomId>.memory.md`). */
  readonly memoryFile: string
  /** The full memory file content (markdown). */
  readonly content: string
  /** The parsed Timeline (post history), oldest-last. */
  readonly recentPosts: RoomPost[]
}
