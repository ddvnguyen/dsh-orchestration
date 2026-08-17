/**
 * fleet-supervisor vocabulary (issue #26, orchestration-v3 §4 P2.2 + §4.1).
 *
 * Defines the fleet-scheduler model — the durable wake queue (entries: target
 * agent, dueAt, kind, context), the wake record (delivered → orphan tracking),
 * the silent-run watchdog state, the digest summary, and the verification-gated
 * merge queue (#28, Bors-style, gastown Refinery). All supervisor events carry
 * `originKind: 'supervisor'` so no supervisor-produced event can self-trigger a
 * supervisor subscriber (the fleet-bus self-trigger guard, plugins/fleet-bus).
 * @module @hydra/dsh-fleet-supervisor/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { FleetClock } from '../../../src/types.ts'

/** Lifecycle of one wake queue entry. */
export type WakeEntryStatus = 'pending' | 'woken' | 'completed' | 'blocked'

/**
 * One durable item in the wake queue (the paperclip heartbeat-execution model:
 * `docs/orchestration-v3.md §4.1`). Enqueued by any schedule / webhook /
 * task-claim request; consumed by the scheduler's wake scan on the heartbeat
 * tick.
 */
export interface WakeEntry {
  /** Stable `<kind>-<seq>` identity; unique per store. */
  readonly id: string
  /**
   * The agent to wake. Mutable: takeover re-targets a stalled entry to a
   * successor agent.
   */
  targetAgentId: string
  /** Unix epoch ms (service clock) at which this entry becomes due. */
  dueAt: number
  /**
   * Wake kind, e.g. `task-claim` / `cron` / `routine` / `notify` / `merge-fix`.
   * Kinds drive the wake prompt (which skills to load, which claim seam to use).
   */
  readonly kind: string
  /** JSON-safe, kind-specific payload delivered in the wake prompt. */
  readonly context: JsonValue
  /** Skill names the wake prompt should inject (resolved via `ctx.skills`). */
  skillNames?: string[]
  status: WakeEntryStatus
  /** Unix epoch ms the entry was enqueued. */
  readonly createdAt: number
  /** Unix epoch ms the entry was last delivered (woken). */
  wokenAt?: number
  /** Budget-blocked entries re-enter the due scan after this time. */
  retryAt?: number
  /** Human reason an entry is `blocked` (e.g. budget soft warning). */
  blockedReason?: string
  /** Trigger-state fingerprint (reused by fleet-bus wake dedupe). */
  fingerprint?: string
  /** Lineage: the entry this one was re-due from (orphan / takeover). */
  parentEntryId?: string
  /** Number of wake attempts so far (takeover/orphan re-due increments it). */
  attempt?: number
}

/** The caller-provided half of a wake entry; id/status/createdAt are assigned. */
export interface WakeEntryInput {
  /** The agent to wake. */
  readonly targetAgentId: string
  /** Wake kind. */
  readonly kind: string
  /** JSON-safe payload delivered in the wake prompt. */
  readonly context: JsonValue
  /** Defaults to now; a future value schedules a later wake. */
  readonly dueAt?: number
  /** Skill names to inject into the wake prompt. */
  readonly skillNames?: string[]
  /** Trigger-state fingerprint for fleet-bus dedupe reuse. */
  readonly fingerprint?: string
  /** Lineage: the entry this one was re-due from. */
  readonly parentEntryId?: string
}

/** What one scheduler tick did (observability + tests). */
export interface FleetSupervisorTickResult {
  /** Number of agents actually woken (one delivery per agent per tick). */
  readonly agentsWoken: string[]
  /** Wake entries delivered this tick. */
  readonly wokenEntries: string[]
  /** Entries re-due on takeover (stalled target). */
  readonly takenOverEntries: string[]
  /** Entries re-due on orphan recovery (woken run died silently). */
  readonly orphanEntries: string[]
  /** Agents newly flagged silent this tick. */
  readonly silentAgents: string[]
  /** Entries deferred by the budget hook this tick. */
  readonly budgetBlocked: string[]
  /** Whether a digest was emitted this tick. */
  readonly digestEmitted: boolean
  /** Merge entries scanned this tick. */
  readonly mergeScanned: number
}

/**
 * The optional fleet-budget seam (owner decision #4: soft warnings + human
 * escalation, no hard stops). fleet-budget (P3.2) implements this; when absent
 * the scheduler assumes `ok`. A soft-warning level escalates instead of waking.
 */
export interface FleetBudgetLike {
  /**
   * Consult the budget for one agent before waking it.
   * @returns `ok` (wake), `warning` / `critical` (escalate, do not wake).
   */
  checkWake(agentId: string): 'ok' | 'warning' | 'critical'
}

/**
 * The optional fleet-tasks seam (P2.1, built concurrently by the sibling
 * worker — plugins/fleet-tasks). When present, waking a `task-claim` entry
 * hands a task-shaped wake entry to `fleetTasks.claimWake(agentId, wakeEntry)`
 * AND the wake prompt tells the agent to claim through that API; when absent
 * the prompt falls back to instructing the agent to use the `task_claim` tool
 * directly. The ready-queue reads unstarted tasks via `list({ state })`.
 */
export interface FleetTasksLike {
  /**
   * Hand a task-claim wake to the tasks layer (durable claim handoff). The
   * entry is the sibling's `FleetTaskWakeEntry` shape: `{ kind, agentId,
   * dueAt?, taskId?, role? }`.
   */
  claimWake(agentId: string, wakeEntry: FleetTaskWakeEntryLike): unknown
  /** Query tasks (the ready-queue reads `state: 'Unstarted'`). */
  list(filter?: { state?: string }): Array<{ id: string; state: string }>
}

/** The task-shaped wake entry `claimWake` accepts (sibling's contract). */
export interface FleetTaskWakeEntryLike {
  readonly kind: string
  /** Target agent id (the agent being woken). */
  readonly agentId: string
  /** When the wake is due (unix epoch ms). */
  readonly dueAt?: number
  /** Claim a specific task, when the wake context names one. */
  readonly taskId?: string
}

/** Lifecycle of one verification-gated merge queue entry (#28). */
export type MergeQueueStatus = 'pending' | 'verifying' | 'merged' | 'failed'

/** The result of one merge verification gate. */
export interface MergeGateResult {
  readonly ok: boolean
  /** Why the gate failed, when it did. */
  readonly reason?: string
}

/**
 * One verification contract a merge entry must satisfy before it is allowed
 * through (Bors-style, gastown Refinery). BASIC implementation: a gate is
 * either a synchronous `check` over the entry (pure contract check) or an
 * async `verify` callback (the full GitHub CI seam — out of scope, documented).
 */
export interface MergeGate {
  /** Short name surfaced in events, e.g. `build.pass`, `tests.green`. */
  readonly name: string
  readonly kind: 'check' | 'callback'
  /** `check` gates: a synchronous decision over the entry alone. */
  check?: (entry: MergeQueueEntry) => boolean
  /** `callback` gates: async verification with service access. */
  verify?: (entry: MergeQueueEntry, supervisor: unknown) => Promise<MergeGateResult>
}

/** One entry in the verification-gated merge queue. */
export interface MergeQueueEntry {
  /** Stable `<merge>-<seq>` identity. */
  readonly id: string
  readonly title: string
  /** Target branch/ref the entry would land on. */
  readonly target: string
  /** Source ref/branch the entry represents. */
  readonly sourceRef: string
  /** Agent re-dispatched the fix when a gate fails. */
  readonly ownerAgentId: string
  /** The gates that must all pass. */
  readonly gates: readonly MergeGate[]
  status: MergeQueueStatus
  /** Number of verification attempts. */
  attempts: number
  /** True once a gate has failed: isolated from the queue, fix re-dispatched. */
  isolated: boolean
  lastResult?: MergeGateResult
  /** Unix epoch ms the entry was enqueued. */
  readonly enqueuedAt: number
  /** Unix epoch ms the entry last passed verification. */
  verifiedAt?: number
}

/** The caller-provided half of a merge queue entry. */
export interface MergeQueueEntryInput {
  readonly title: string
  readonly target: string
  readonly sourceRef: string
  readonly ownerAgentId: string
  /** Gate names resolved against the supervisor's gate registry at enqueue. */
  readonly gateNames: string[]
}

/** The one-line summary `fleet/digest` carries (consumable by fleet-board). */
export interface FleetDigestSummary {
  /** Unix epoch ms (service clock). */
  readonly ts: number
  /** Registry truth when ctx.fleet is composed. */
  readonly agents: Array<{ id: string; status: string }>
  readonly activeCount: number
  readonly stalledCount: number
  readonly silentCount: number
  /** Pending wake queue length. */
  readonly pendingWakes: number
  /** Ready-queue length (fleet-tasks unstarted tasks; 0 when absent). */
  readonly readyQueueLength: number
  /** Fleet-bus events published since the last digest. */
  readonly recentActivity: number
}

/** Shared clock contract (family convention: tests inject a fake clock). */
export type { FleetClock }
