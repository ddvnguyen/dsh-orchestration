/**
 * fleet-tasks vocabulary: the shared task queue model — task schema, the fixed
 * workflow-state taxonomy (#28), severity/escalation, artifact contracts, and
 * execution locks for the V3 flagship (issue #26, orchestration-v3 §4 P2.1).
 * @module @hydra/dsh-fleet-tasks/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** Severity ladder (gastown pattern): P0 urgent, P1 normal, P2 low. */
export type FleetTaskSeverity = 'P0' | 'P1' | 'P2'

/**
 * Fixed workflow-state taxonomy (#28). A task travels only along the allowed
 * transitions (validated by {@link canTransitionTaskState}):
 *   Triage/Backlog → Unstarted → Started → Completed → (accept or reject)
 * Any non-terminal state → Cancelled. Rejection reopens to Unstarted.
 */
export type FleetTaskState =
  | 'Triage'
  | 'Backlog'
  | 'Unstarted'
  | 'Started'
  | 'Completed'
  | 'Cancelled'

/** The states a task may be CREATED in (the claimable pool, minus Started). */
export const FLEET_TASK_CREATABLE_STATES: readonly FleetTaskState[] = [
  'Triage',
  'Backlog',
  'Unstarted',
]

/** The states from which a claim may atomically acquire the task. */
export const FLEET_TASK_CLAIMABLE_STATES: readonly FleetTaskState[] = [
  'Triage',
  'Backlog',
  'Unstarted',
]

/** Terminal states: no further work flows out of them. */
export const FLEET_TASK_TERMINAL_STATES: readonly FleetTaskState[] = [
  'Completed',
  'Cancelled',
]

/**
 * Allowed transitions. Keys are (from, to) pairs. `*` as `from` matches any
 * non-terminal state (cancellation); rejection reopens Completed → Unstarted.
 */
export const FLEET_TASK_TRANSITIONS: ReadonlyArray<readonly [FleetTaskState, FleetTaskState]> = [
  ['Triage', 'Backlog'],
  ['Triage', 'Unstarted'],
  ['Backlog', 'Unstarted'],
  ['Backlog', 'Triage'],
  ['Unstarted', 'Triage'],
  ['Unstarted', 'Backlog'],
  ['Triage', 'Started'],
  ['Backlog', 'Started'],
  ['Unstarted', 'Started'],
  ['Started', 'Completed'],
  ['Completed', 'Unstarted'],
  ['Triage', 'Cancelled'],
  ['Backlog', 'Cancelled'],
  ['Unstarted', 'Cancelled'],
  ['Started', 'Cancelled'],
]

/** The kind of a task lock. Only `execution` exists today (reserved for growth). */
export type FleetTaskLockKind = 'execution'

/**
 * An execution lock: proof that one agent holds the right to mutate a task
 * (update/complete/cancel). Acquired atomically at claim via the task's
 * `token`; released when the task is cancelled or rejected/reopened.
 */
export interface FleetTaskLock {
  readonly kind: FleetTaskLockKind
  /** The single holding agent id. */
  readonly holder: string
  /** Opaque claim token authorizing mutations while the lock is held. */
  readonly token: string
  /** Unix epoch ms (service clock) the lock was acquired. */
  readonly acquiredAt: number
}

/**
 * The artifact contract a completion must satisfy (acceptance-model pattern):
 * a stated expected result, the exact metric to measure, and a pass range.
 * `accept` evaluates completion evidence against this and REJECTS false-done.
 */
export interface FleetTaskArtifactContract {
  /** What "done" means, in words (e.g. "all tests pass, exit 0"). */
  expectedResult: string
  /** The exact metric to measure (e.g. "exit-code", "tests-passed"). */
  metric: string
  /** PASS predicate over the metric value (e.g. "== 0", ">= 1"). */
  passRange: string
}

/**
 * Severity-routed escalation (#28, gastown): raises the task's severity and
 * names the human/agent owner of the escalation plus the next concrete action.
 */
export interface FleetTaskEscalation {
  /** The escalated severity (P0/P1/P2). */
  severity: FleetTaskSeverity
  /** The named owner responsible for the escalation. */
  owner: string
  /** The next action the escalation requires. */
  nextAction: string
  /** Unix epoch ms (service clock) the escalation was raised. */
  raisedAt: number
}

/** Acceptance disposition after `accept` verifies a completion. */
export type FleetTaskAcceptanceStatus = 'pending' | 'accepted' | 'rejected'

/** The verification result of a completion against its artifact contract. */
export interface FleetTaskAcceptance {
  readonly status: FleetTaskAcceptanceStatus
  /** Unix epoch ms (service clock) the verification ran. */
  checkedAt?: number
  /** Why acceptance failed (present when status is `rejected`). */
  reason?: string
}

/** Artifact evidence submitted at `complete`; `result` is the metric value. */
export interface FleetTaskEvidence {
  /** The measured value of the task's artifact-contract metric. */
  result: string | number | boolean
  /** Free-form notes on how the result was produced. */
  notes?: string
  /** Artifact references (file paths, run ids, …). */
  artifacts?: string[]
  /** Unix epoch ms (service clock) the evidence was submitted. */
  submittedAt?: number
  /** The agent id that submitted the evidence. */
  submittedBy?: string
}

/**
 * One task in the shared queue.
 *
 * `goalAncestry` (#28) is the parent chain from the immediate parent up to the
 * top-level goal: `[parentId, grandParentId, …, goalId]`, derived from the
 * parent link at create time. A task with no parent has `goalAncestry: []` and
 * IS its own top-level goal.
 */
export interface FleetTask {
  /** Stable identity. */
  readonly id: string
  readonly title: string
  /** Parent chain → top-level goal (#28): [parent, …, goal]. */
  goalAncestry: readonly string[]
  /** Direct parent task id (sub-issue link; drives auto-close). */
  readonly parentId?: string
  /** Current workflow-taxonomy state. */
  state: FleetTaskState
  /** The single assignee (set only by an atomic claim). */
  assignee?: string
  /** Free-form priority hint (e.g. "high"), independent of severity. */
  priority?: string
  readonly severity: FleetTaskSeverity
  /** Severity-routed escalation (#28). */
  escalation?: FleetTaskEscalation
  /** The contract a completion must satisfy (false-done rejection). */
  artifactContract?: FleetTaskArtifactContract
  /** Org-chart routing hint: which role should claim this task. */
  claimRole?: string
  /** Locks; today a single `execution` lock held by the assignee. */
  locks: readonly FleetTaskLock[]
  /** Evidence submitted at complete. */
  evidence?: FleetTaskEvidence
  /** Acceptance disposition after `accept` verifies the completion. */
  acceptance?: FleetTaskAcceptance
  /** When this task was auto-closed by a completed parent (sub-issue auto-close). */
  autoClosedBy?: string
  readonly createdAt: number
  updatedAt: number
  completedAt?: number
}

/** The caller-provided half of `create`; id/timestamps are assigned. */
export interface FleetTaskCreateInput {
  readonly title: string
  /** Initial taxonomy state; must be in {@link FLEET_TASK_CREATABLE_STATES}. */
  state?: FleetTaskState
  readonly parentId?: string
  readonly priority?: string
  readonly severity?: FleetTaskSeverity
  readonly claimRole?: string
  readonly artifactContract?: FleetTaskArtifactContract
}

/** Fields `update` may patch (mutations outside the state verbs are restricted). */
export interface FleetTaskUpdatePatch {
  title?: string
  priority?: string
  severity?: FleetTaskSeverity
  claimRole?: string
  artifactContract?: FleetTaskArtifactContract
}

/** The artifact contract checked in `accept`; contract/evidence may be passed in. */
export interface FleetTaskAcceptInput {
  /** Optional override evidence; defaults to the task's stored evidence. */
  evidence?: FleetTaskEvidence
  /** Optional override contract; defaults to the task's artifactContract. */
  artifactContract?: FleetTaskArtifactContract
}

/** Outcome of `claim` / `claimWake`. */
export interface FleetTaskClaimResult {
  readonly ok: boolean
  readonly task?: FleetTask
  /** Claim token authorizing updates while the execution lock is held. */
  readonly token?: string
  readonly reason?: string
}

/** Outcome of `accept`. */
export interface FleetTaskAcceptResult {
  readonly accepted: boolean
  readonly task: FleetTask
  readonly reason?: string
}

/**
 * A scheduler wake entry (the claimWake seam). `kind: 'task-claim'` is the
 * heartbeat-wake claim; the scheduler may target a specific task via `taskId`
 * or leave it to role/org-chart routing. Optional `role` overrides the
 * resolved agent role for routing.
 */
export interface FleetTaskWakeEntry {
  readonly kind: 'task-claim' | string
  /** Target agent id (the agent being woken). */
  readonly agentId: string
  /** When the wake is due (unix epoch ms). */
  readonly dueAt?: number
  /** Claim a specific task, when present. */
  readonly taskId?: string
  /** Org-chart routing override for this wake. */
  readonly role?: string
}

/** List filter for the queryable store. */
export interface FleetTaskQueryFilter {
  state?: FleetTaskState
  assignee?: string
  /** Match tasks whose goal ancestry contains this goal id (#28). */
  goal?: string
  severity?: FleetTaskSeverity
}

/** Severity order for routing: P0 < P1 < P2 (ascending = more urgent). */
export const FLEET_TASK_SEVERITY_ORDER: readonly FleetTaskSeverity[] = ['P0', 'P1', 'P2']

export function fleetTaskSeverityRank(severity: FleetTaskSeverity): number {
  const rank = FLEET_TASK_SEVERITY_ORDER.indexOf(severity)
  return rank === -1 ? FLEET_TASK_SEVERITY_ORDER.length : rank
}

/** True when a task is in a state from which work can begin. */
export function isFleetTaskClaimable(task: FleetTask): boolean {
  return FLEET_TASK_CLAIMABLE_STATES.includes(task.state)
}

/** True when a task is in a terminal state. */
export function isFleetTaskTerminal(task: FleetTask): boolean {
  return FLEET_TASK_TERMINAL_STATES.includes(task.state)
}

/** True when the (from → to) transition is in the taxonomy table. */
export function canTransitionTaskState(from: FleetTaskState, to: FleetTaskState): boolean {
  return FLEET_TASK_TRANSITIONS.some(([f, t]) => f === from && t === to)
}

/** A JSON-safe, compact projection of a task for events/feeds. */
export function fleetTaskToJsonValue(task: FleetTask): JsonValue {
  const value: Record<string, JsonValue> = {
    id: task.id,
    title: task.title,
    state: task.state,
    goalAncestry: [...task.goalAncestry],
    severity: task.severity,
    locks: task.locks.map(lock => ({ kind: lock.kind, holder: lock.holder, acquiredAt: lock.acquiredAt })),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  if (task.parentId !== undefined) value.parentId = task.parentId
  if (task.assignee !== undefined) value.assignee = task.assignee
  if (task.priority !== undefined) value.priority = task.priority
  if (task.escalation !== undefined) value.escalation = task.escalation as unknown as JsonValue
  if (task.artifactContract !== undefined) value.artifactContract = task.artifactContract as unknown as JsonValue
  if (task.claimRole !== undefined) value.claimRole = task.claimRole
  if (task.acceptance !== undefined) value.acceptance = task.acceptance as unknown as JsonValue
  if (task.autoClosedBy !== undefined) value.autoClosedBy = task.autoClosedBy
  if (task.completedAt !== undefined) value.completedAt = task.completedAt
  return value
}
