/**
 * Shared fleet vocabulary for the dsh fleet plugin family (experiments/dsh-fleet).
 *
 * Defines the fleet registry model (agents, statuses, ledger events) and the
 * `SessionEventMap` declaration merge that lets fleet records be appended to a
 * real dsh session log exactly like `compaction/*` extends the vocabulary
 * (see docs/subsystems/session.md in the dsh submodule).
 * @module @hydra/dsh-fleet/types
 */

import type { SessionEventMap } from '@deepseek-ai/dsh-session'

/** Which process-world an agent lives in. */
export type FleetAgentKind = 'dsh' | 'acp' | 'external' | 'claude-code'

/**
 * Liveness status of a fleet agent.
 * - `active`: last heartbeat is within the stall threshold.
 * - `stalled`: no heartbeat for longer than the stall threshold.
 * - `offline`: explicitly marked (e.g. `agent/disposed`), retained for history.
 */
export type FleetStatus = 'active' | 'stalled' | 'offline'

/** The kinds of records appended to the per-agent fleet ledger. */
export type FleetEventKind = 'heartbeat' | 'stall' | 'resume' | 'message'

/** JSON-safe extras a registration may attach (label, model, …). */
export type FleetAgentMeta = Record<string, string | number | boolean | null>

/** One live fleet agent. */
export interface FleetAgentEntry {
  /** Stable agent identity (dsh SessionId string for dsh agents). */
  readonly id: string
  readonly kind: FleetAgentKind
  /** Human label; defaults to the id. */
  label: string
  /** Unix epoch ms of the last heartbeat (registeredAt on registration). */
  lastSeen: number
  status: FleetStatus
  /** Total heartbeats received. */
  heartbeatCount: number
  /** Unix epoch ms of registration. */
  readonly registeredAt: number
  /** Session id when backed by a real dsh Session (for the ledger mirror). */
  sessionId?: string
  meta?: FleetAgentMeta
  /** Optional delivery hook invoked by sendMessage for this agent. */
  onMessage?: (message: FleetMessage) => void
}

/** One record in the per-agent fleet ledger. */
export interface FleetLedgerEvent {
  /** Monotonic per-agent sequence. */
  readonly seq: number
  /** Unix epoch ms. */
  readonly time: number
  readonly kind: FleetEventKind
  readonly agentId: string
  readonly data: FleetLedgerData
}

export type FleetLedgerData =
  | { kind: 'heartbeat'; note?: string; heartbeatCount: number }
  | { kind: 'stall'; stalledMs: number }
  | { kind: 'resume'; stalledForMs: number }
  | { kind: 'message'; direction: 'out' | 'in'; from: string; to: string; text: string; messageId: string; state: FleetMessageState }

export type FleetMessageState = 'queued' | 'delivered' | 'rejected'

/** A cross-agent message as recorded in both ledgers. */
export interface FleetMessage {
  readonly messageId: string
  readonly from: string
  readonly to: string
  readonly text: string
  readonly time: number
  state: FleetMessageState
}

/** Public read view of one agent (what list/get_status expose). */
export interface FleetAgentView {
  readonly id: string
  readonly kind: FleetAgentKind
  readonly label: string
  readonly status: FleetStatus
  readonly lastSeen: number
  readonly heartbeatCount: number
  readonly registeredAt: number
  readonly sessionId?: string
  readonly meta?: FleetAgentMeta
}

/** Result of one tick's stall scan. */
export interface FleetTickResult {
  readonly stalled: string[]
  readonly resumed: string[]
}

/** Result of waitForAgent. */
export interface FleetWaitResult {
  readonly ok: boolean
  readonly reason: 'progress' | 'timeout'
  readonly agent?: FleetAgentView
}

/** Clock abstraction so tests can advance time deterministically. */
export interface FleetClock {
  now(): number
}

export const systemClock: FleetClock = { now: () => Date.now() }

/**
 * The session-log payloads for fleet records. Merged into `SessionEventMap`
 * (augmenting `@deepseek-ai/dsh-session/types` — the module that DECLARES the
 * interface, exactly like compaction: packages/compaction/compaction/src/types.ts
 * and agent: packages/core/agent/src/types.ts) so
 * `session.append('fleet/heartbeat', …)` type-checks and flows through the same
 * append pipeline as any other event.
 *
 * NOTE (prototype caveat): these types are NOT in the dsh persistence catalog
 * (`KNOWN_SESSION_EVENT_TYPES` in packages/core/session/src/known-event-types.ts)
 * and `Session.append` writes them without the `ignorable: true` marker, so a
 * persistence backend refuses to re-read a log containing them ("registration
 * surface for out-of-repo plugin events is deferred" per that file). The
 * in-memory per-agent fleet ledger is the primary store; the session mirror is
 * informational for live composition.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'fleet/heartbeat': {
      agentId: string
      status: FleetStatus
      heartbeatCount: number
    }
    'fleet/stall': {
      agentId: string
      stalledMs: number
    }
    'fleet/resume': {
      agentId: string
      stalledForMs: number
    }
    'fleet/message': {
      messageId: string
      from: string
      to: string
      text: string
      state: FleetMessageState
    }
    'fleet/audit': {
      seq: number
      actor: string
      action: string
      target: string
      sig: string
      pubkey: string
    }
  }
}

/** The session event types this family owns. */
export type FleetSessionEventType =
  | 'fleet/heartbeat'
  | 'fleet/stall'
  | 'fleet/resume'
  | 'fleet/message'
  | 'fleet/audit'

/**
 * Fleet schedule (heartbeat) vocabulary — API-based heartbeat management:
 * a prompt delivered to a target agent on a cadence, with run history,
 * pause/resume, and max-run / expiry auto-pause. Managed through the
 * `fleet_heartbeat_*` agent tools backed by the `ctx.fleetSchedule` service
 * (plugins/fleet-schedule). Model corresponds to the Paseo schedule daemon
 * (packages/cli/src/commands/schedule/types.ts) with the family's epoch-ms
 * timestamp convention.
 * @section schedules
 */

/** Lifecycle status of a fleet schedule. */
export type ScheduleStatus = 'active' | 'paused' | 'completed'

/**
 * How often a schedule fires: a fixed interval (`every`) or a 5-field cron
 * expression (`minute hour day-of-month month day-of-week` — `*`, lists,
 * ranges, steps, month/day names; optional IANA timezone).
 */
export type ScheduleCadence =
  | { type: 'every'; everyMs: number }
  | { type: 'cron'; expression: string; timezone?: string }

/** One execution record in a schedule's run history (kept last 20). */
export interface ScheduleRunRecord {
  readonly id: string
  /** Unix epoch ms the run was due (creation time for manual runs). */
  scheduledFor: number
  /** Unix epoch ms execution began. */
  startedAt: number
  /** 'running' while delivering; resolves to 'succeeded' / 'failed'. */
  status: 'running' | 'succeeded' | 'failed'
  /** The target agent id of the run. */
  agentId: string
  /** Delivery error text, when the run failed (null on success). */
  error: string | null
}

/**
 * One fleet schedule (heartbeat): `prompt` delivered to `target.agentId` on
 * `cadence`. Timestamps are Unix epoch ms. `runCount` is the cumulative run
 * counter used for `maxRuns` accounting — `runs` is trimmed to the last
 * {@link MAX_SCHEDULE_RUN_HISTORY} entries, so it cannot count runs itself.
 */
export interface ScheduleRecord {
  readonly id: string
  /** Human label (optional). */
  name: string | null
  /** The prompt delivered to the target agent on each run. */
  prompt: string
  cadence: ScheduleCadence
  /** Receiving agent (also the owning agent for tool-scoped mutations). */
  target: { type: 'agent'; agentId: string }
  status: ScheduleStatus
  readonly createdAt: number
  updatedAt: number
  /** Unix epoch ms of the next due run (null while paused/completed). */
  nextRunAt: number | null
  lastRunAt: number | null
  pausedAt: number | null
  expiresAt: number | null
  maxRuns: number | null
  /** Cumulative runs ever (maxRuns accounting; runs[] capped at 20). */
  runCount: number
  /** Run history, oldest → newest, capped at the last 20 runs. */
  runs: ScheduleRunRecord[]
}
