/**
 * FleetTasksService — the `ctx.fleetTasks` Cordis service behind the
 * fleet-tasks plugin (issue #26, orchestration-v3 §4 P2.1).
 *
 * The V3 flagship: a shared, durable task queue with
 *  - create / claim (atomic single-assignee execution lock) / update /
 *    complete (artifact evidence required) / cancel / escalate (severity-
 *    routed) / accept (artifact-contract verification → false-done rejection),
 *  - goal ancestry + parent links (#28) with sub-issue auto-close,
 *  - the fixed workflow-state taxonomy (Triage|Backlog|Unstarted|Started|
 *    Completed|Cancelled, #28),
 *  - and the heartbeat-wake claim seam `claimWake(agentId, wakeEntry)` the
 *    fleet-scheduler (P2.2) wakes INTO. The seam is safe when the queue is
 *    empty and the plugin is absent (`ctx.get('fleetTasks')` returns
 *    `undefined` on the scheduler side — nothing here assumes a caller).
 *
 * Every mutation publishes to `ctx.fleetBus` (when composed) with
 * `originKind: 'task'` and, when `ctx.fleetAgent` is composed and the actor
 * has a profile, a signed event embedded in the payload. Both services are
 * optional (`ctx.get`), so the plugin is self-contained.
 * @module @hydra/dsh-fleet-tasks/service
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { FleetClock } from '../../../src/types.ts'
import { systemClock } from '../../../src/types.ts'
import { FleetTaskStore, type FleetTaskStoreConfig } from './store.ts'
import type {
  FleetTask,
  FleetTaskAcceptResult,
  FleetTaskAcceptInput,
  FleetTaskClaimResult,
  FleetTaskCreateInput,
  FleetTaskEscalation,
  FleetTaskEvidence,
  FleetTaskQueryFilter,
  FleetTaskState,
  FleetTaskUpdatePatch,
  FleetTaskWakeEntry,
} from './types.ts'
import {
  fleetTaskSeverityRank,
  FLEET_TASK_CREATABLE_STATES,
  FLEET_TASK_TERMINAL_STATES,
  isFleetTaskClaimable,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetTasks: FleetTasksService
  }

  interface Events {
    /**
     * One fleet-tasks mutation occurred (task created/claimed/updated/
     * completed/cancelled/escalated/accepted/rejected). Emitted synchronously
     * after the store write and the optional fleet-bus publish, so in-process
     * observers get the task even when no bus is composed.
     * @param info - the mutation type + the affected task + the acting agent.
     * @mode emit
     */
    'fleet-tasks/event'(info: { type: string; task: FleetTask; actor: string }): void
  }
}

/** The event types fleet-tasks publishes to the bus. */
export const FLEET_TASK_EVENT_TYPES = {
  created: 'fleet/task-created',
  claimed: 'fleet/task-claimed',
  updated: 'fleet/task-updated',
  completed: 'fleet/task-completed',
  cancelled: 'fleet/task-cancelled',
  escalated: 'fleet/task-escalated',
  accepted: 'fleet/task-accepted',
  rejected: 'fleet/task-rejected',
} as const

/** Structural fleet-bus surface (avoids importing the concrete service). */
export interface FleetBusLike {
  publish(input: {
    type: string
    scope: 'agent' | 'team' | 'fleet'
    actor: string
    originKind: string
    payload: JsonValue
  }): unknown
}

/** Structural fleet-agent surface for optional signing + role resolution. */
export interface FleetAgentLike {
  sign(input: { type: string; actor: string; payload: unknown; ts?: number }): unknown
  getProfile(agentId: string): { role?: string } | undefined
}

export interface FleetTasksConfig extends FleetTaskStoreConfig {
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /**
   * Org chart: agentId → role. Used by claimWake for role-routed claims,
   * overriding the fleetAgent profile role. Optional.
   */
  orgChart?: Record<string, string>
  /**
   * Resolve an agent's org-chart role. Defaults to the orgChart override, then
   * the agent's fleetAgent profile role (when one is composed), else
   * `undefined` (only un-routed tasks are claimable via claimWake).
   */
  resolveRole?: (agentId: string) => string | undefined
  /**
   * A task's `claimRole` is honored as a routing hint: claimWake prefers tasks
   * whose claimRole matches the agent's role, then un-routed tasks. Tasks
   * routed to a DIFFERENT role are skipped. Default true.
   */
  honorClaimRole?: boolean
  /** Auto-close descendant tasks when a parent completes/cancels. Default true. */
  autoCloseSubtree?: boolean
}

/** The role-claim preference tier for claimWake routing. */
type RoutingTier = 'matched-role' | 'unrouted'

export class FleetTasksService extends Service {
  readonly store: FleetTaskStore
  private readonly clock: FleetClock
  private readonly resolveRole: (agentId: string) => string | undefined
  private readonly honorClaimRole: boolean
  private readonly autoCloseSubtree: boolean

  constructor(ctx: Context, config: FleetTasksConfig = {}) {
    super(ctx, 'fleetTasks')
    this.clock = config.clock ?? systemClock
    this.honorClaimRole = config.honorClaimRole ?? true
    this.autoCloseSubtree = config.autoCloseSubtree ?? true
    this.resolveRole = config.resolveRole ?? ((agentId) => this.lookupRole(agentId, config.orgChart))
    this.store = new FleetTaskStore({ dir: config.dir, file: config.file })
  }

  // ---- reads ----

  /** All tasks, insertion order. */
  list(filter: FleetTaskQueryFilter = {}): FleetTask[] {
    return this.store.query(filter)
  }

  /** One task by id. */
  get(id: string): FleetTask | undefined {
    return this.store.get(id)
  }

  // ---- verbs ----

  /**
   * Create a task. The initial state must be in the claimable pool
   * (Triage/Backlog/Unstarted; default Triage). When `parentId` is given the
   * parent must exist; the goal ancestry (#28) is derived as
   * `[parentId, …parent.goalAncestry]` so the chain reaches the top-level goal.
   * @param input - title + optional state/parent/priority/severity/role/contract.
   * @param actor - the creating agent id.
   * @returns the created task.
   */
  create(input: FleetTaskCreateInput, actor: string): FleetTask {
    if (input.title.trim().length === 0) throw new Error('fleet-tasks: title must be non-empty')
    const state = input.state ?? 'Triage'
    if (!FLEET_TASK_CREATABLE_STATES.includes(state)) {
      throw new Error(`fleet-tasks: cannot create a task in state "${state}"; must be one of ${FLEET_TASK_CREATABLE_STATES.join(', ')}`)
    }
    const severity = input.severity ?? 'P1'
    if (!['P0', 'P1', 'P2'].includes(severity)) {
      throw new Error('fleet-tasks: severity must be P0, P1, or P2')
    }

    let goalAncestry: string[] = []
    let parentId: string | undefined
    if (input.parentId !== undefined) {
      const parent = this.store.get(input.parentId)
      if (parent === undefined) throw new Error(`fleet-tasks: parent task "${input.parentId}" not found`)
      parentId = parent.id
      goalAncestry = [parent.id, ...parent.goalAncestry]
    }

    const now = this.clock.now()
    const task: FleetTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      title: input.title,
      goalAncestry,
      ...(parentId !== undefined ? { parentId } : {}),
      state,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      severity,
      ...(input.claimRole !== undefined ? { claimRole: input.claimRole } : {}),
      ...(input.artifactContract !== undefined ? { artifactContract: input.artifactContract } : {}),
      locks: [],
      createdAt: now,
      updatedAt: now,
    }
    this.store.put(task)
    this.publish(FLEET_TASK_EVENT_TYPES.created, task, actor)
    return task
  }

  /**
   * ATOMIC single-assignee claim. Acquires an execution lock (with an opaque
   * `token` that authorizes later mutations) in one guarded SQL UPDATE — two
   * claimants racing for the same task cannot both win.
   * @param taskId - the task to claim.
   * @param agentId - the claiming agent (the single assignee).
   * @returns `{ ok, task, token }` on success; `{ ok: false, reason }` when the
   *   task is missing, not claimable, or already claimed.
   */
  claim(taskId: string, agentId: string): FleetTaskClaimResult {
    const existing = this.store.get(taskId)
    if (existing === undefined) return { ok: false, reason: `task "${taskId}" not found` }
    if (!isFleetTaskClaimable(existing)) {
      return { ok: false, reason: `task "${taskId}" is not claimable in state "${existing.state}"` }
    }
    if (existing.assignee !== undefined) {
      return { ok: false, reason: `task "${taskId}" is already assigned to "${existing.assignee}"` }
    }

    const now = this.clock.now()
    const lock = { kind: 'execution' as const, holder: agentId, token: randomUUID(), acquiredAt: now }
    if (!this.store.atomicClaim(taskId, agentId, lock, now)) {
      return { ok: false, reason: `task "${taskId}" claim lost the race (already claimed or not claimable)` }
    }
    const task = this.store.get(taskId)!
    this.publish(FLEET_TASK_EVENT_TYPES.claimed, task, agentId)
    return { ok: true, task, token: lock.token }
  }

  /**
   * Update mutable fields of a task. Requires the execution-lock token.
   * State transitions are NOT patchable here — they flow through the verbs
   * (claim/complete/cancel/accept).
   */
  update(taskId: string, token: string, patch: FleetTaskUpdatePatch, actor: string): FleetTask {
    const task = this.mutateWithLock(taskId, token)
    const next: FleetTask = {
      ...task,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
      ...(patch.claimRole !== undefined ? { claimRole: patch.claimRole } : {}),
      ...(patch.artifactContract !== undefined ? { artifactContract: patch.artifactContract } : {}),
      updatedAt: this.clock.now(),
    }
    this.store.put(next)
    this.publish(FLEET_TASK_EVENT_TYPES.updated, next, actor)
    return next
  }

  /**
   * Complete a task with artifact evidence. Requires the execution-lock token
   * and NON-EMPTY evidence (the artifact contract's metric value). A
   * completed parent AUTO-CLOSES its descendant subtree (#28 sub-issue
   * auto-close): each non-terminal descendant is marked Completed with
   * `autoClosedBy` set to the completed task, and its execution lock is
   * released. Acceptance remains `pending` until `accept` verifies the
   * completion against the artifact contract.
   */
  complete(taskId: string, token: string, evidence: FleetTaskEvidence, actor: string): FleetTask {
    const task = this.mutateWithLock(taskId, token)
    if (task.state !== 'Started') throw new Error(`fleet-tasks: cannot complete task "${taskId}" in state "${task.state}"`)
    if (evidence === undefined || evidence.result === undefined || evidence.result === null || evidence.result === '') {
      throw new Error('fleet-tasks: complete requires artifact evidence (result with the contract metric value)')
    }
    const now = this.clock.now()
    const completed: FleetTask = {
      ...task,
      state: 'Completed',
      evidence: { ...evidence, submittedAt: evidence.submittedAt ?? now, submittedBy: evidence.submittedBy ?? actor },
      acceptance: { status: 'pending' },
      updatedAt: now,
      completedAt: now,
    }
    this.store.put(completed)
    this.publish(FLEET_TASK_EVENT_TYPES.completed, completed, actor)

    if (this.autoCloseSubtree) {
      this.autoCloseDescendants(completed.id, 'Completed', actor)
    }
    return this.store.get(taskId)!
  }

  /**
   * Cancel a task. Requires the execution-lock token. A cancelled parent also
   * cancels its descendant subtree (non-terminal descendants → Cancelled with
   * `autoClosedBy` set; execution locks released).
   */
  cancel(taskId: string, token: string, reason: string | undefined, actor: string): FleetTask {
    const task = this.mutateWithLock(taskId, token)
    if (task.state === 'Completed' || task.state === 'Cancelled') {
      throw new Error(`fleet-tasks: cannot cancel task "${taskId}" in terminal state "${task.state}"`)
    }
    const now = this.clock.now()
    const cancelled: FleetTask = {
      ...task,
      state: 'Cancelled',
      evidence: undefined,
      acceptance: undefined,
      updatedAt: now,
    }
    this.store.put(cancelled)
    this.store.releaseLock(taskId, now)
    const released = this.store.get(taskId)!
    this.publish(FLEET_TASK_EVENT_TYPES.cancelled, released, actor)

    if (this.autoCloseSubtree) {
      this.autoCloseDescendants(released.id, 'Cancelled', actor)
    }
    return this.store.get(taskId)!
  }

  /**
   * Severity-routed escalation (#28, gastown): raise the task's severity and
   * record the named owner + next action. No execution lock required —
   * escalation is an intervention by a lead/watchdog, not the assignee.
   */
  escalate(taskId: string, input: { severity: FleetTask['severity']; owner: string; nextAction: string }, actor: string): FleetTask {
    if (!['P0', 'P1', 'P2'].includes(input.severity)) {
      throw new Error('fleet-tasks: escalation severity must be P0, P1, or P2')
    }
    if (input.owner.trim().length === 0 || input.nextAction.trim().length === 0) {
      throw new Error('fleet-tasks: escalation requires a named owner and a next action')
    }
    const task = this.store.get(taskId)
    if (task === undefined) throw new Error(`fleet-tasks: task "${taskId}" not found`)
    const escalation: FleetTaskEscalation = {
      severity: input.severity,
      owner: input.owner,
      nextAction: input.nextAction,
      raisedAt: this.clock.now(),
    }
    const next: FleetTask = { ...task, severity: input.severity, escalation, updatedAt: escalation.raisedAt }
    this.store.put(next)
    this.publish(FLEET_TASK_EVENT_TYPES.escalated, next, actor, {
      severity: input.severity,
      escalation: { severity: input.severity, owner: input.owner, nextAction: input.nextAction },
    })
    return next
  }

  /**
   * Accept (or reject) a completion: artifact verification against the
   * task's artifact contract — the watchdog hook. Evidence and contract
   * default to the task's stored values (both may be overridden).
   *
   * PASS → `acceptance: { status: 'accepted' }`, state stays Completed.
   * FAIL → `acceptance: { status: 'rejected', reason }`, the task REOPENS to
   * Unstarted and its execution lock + assignee are released so it can be
   * re-claimed (false-done rejection). A task with no artifact contract and no
   * override has nothing to verify and is accepted trivially.
   */
  accept(taskId: string, input: FleetTaskAcceptInput = {}, actor: string): FleetTaskAcceptResult {
    const task = this.store.get(taskId)
    if (task === undefined) throw new Error(`fleet-tasks: task "${taskId}" not found`)
    if (task.state !== 'Completed') {
      throw new Error(`fleet-tasks: accept requires a Completed task; task "${taskId}" is "${task.state}"`)
    }
    const contract = input.artifactContract ?? task.artifactContract
    const evidence = input.evidence ?? task.evidence
    if (contract === undefined) {
      const now = this.clock.now()
      const accepted = { ...task, acceptance: { status: 'accepted' as const, checkedAt: now }, updatedAt: now }
      this.store.put(accepted)
      this.publish(FLEET_TASK_EVENT_TYPES.accepted, accepted, actor)
      return { accepted: true, task: accepted }
    }
    const check = evaluateArtifactContract(contract, evidence)
    const now = this.clock.now()
    if (check.pass) {
      const accepted = { ...task, acceptance: { status: 'accepted' as const, checkedAt: now }, updatedAt: now }
      this.store.put(accepted)
      this.publish(FLEET_TASK_EVENT_TYPES.accepted, accepted, actor)
      return { accepted: true, task: accepted }
    }
    // False-done: reopen to Unstarted, release the execution lock + assignee.
    const reason = `[${contract.metric}] ${check.reason}`
    const reopened: FleetTask = {
      ...task,
      state: 'Unstarted',
      assignee: undefined,
      locks: [],
      acceptance: { status: 'rejected', checkedAt: now, reason },
      updatedAt: now,
    }
    this.store.put(reopened)
    this.publish(FLEET_TASK_EVENT_TYPES.rejected, reopened, actor, { reason })
    return { accepted: false, task: reopened, reason }
  }

  /**
   * The heartbeat-wake claim seam: process a scheduler wake into a claim.
   * With `wakeEntry.taskId` it claims that specific task; otherwise it routes
   * by role/org chart — preferring tasks whose `claimRole` matches the
   * agent's role, then un-routed tasks (tasks routed to a different role are
   * skipped), most-severe first. Safe on an empty/unclaimable queue:
   * returns `{ ok: false, reason: 'no claimable task' }`.
   */
  claimWake(agentId: string, wakeEntry: FleetTaskWakeEntry): FleetTaskClaimResult {
    if (wakeEntry.taskId !== undefined) {
      return this.claim(wakeEntry.taskId, agentId)
    }
    const role = wakeEntry.role ?? this.resolveRole(agentId)
    const claimable = this.list().filter(isFleetTaskClaimable)
    if (claimable.length === 0) return { ok: false, reason: 'no claimable task' }

    let routed: FleetTask[] = []
    if (this.honorClaimRole && role !== undefined) {
      const matched = claimable.filter(task => task.claimRole === role)
      if (matched.length > 0) routed = matched
      else {
        const unrouted = claimable.filter(task => task.claimRole === undefined)
        if (unrouted.length > 0) routed = unrouted
      }
    } else {
      routed = claimable
    }
    if (routed.length === 0) return { ok: false, reason: `no claimable task for role "${role ?? 'unknown'}"` }

    const candidate = [...routed].sort((a, b) => rankTaskForClaim(a) - rankTaskForClaim(b))[0]!
    return this.claim(candidate.id, agentId)
  }

  // ---- internals ----

  /** Read a task, require an active execution lock with a matching token. */
  private mutateWithLock(taskId: string, token: string): FleetTask {
    const task = this.store.get(taskId)
    if (task === undefined) throw new Error(`fleet-tasks: task "${taskId}" not found`)
    const lock = task.locks.find(lock => lock.kind === 'execution')
    if (lock === undefined) throw new Error(`fleet-tasks: task "${taskId}" has no execution lock (claim it first)`)
    if (lock.token !== token) throw new Error(`fleet-tasks: task "${taskId}" lock token mismatch — caller does not hold the execution lock`)
    return task
  }

  /** Recursively close all non-terminal descendants of a task (sub-issue auto-close). */
  private autoCloseDescendants(parentId: string, closeState: 'Completed' | 'Cancelled', actor: string): void {
    const now = this.clock.now()
    // Immediate children only; recursion handles grandchildren so each
    // auto-close marks its DIRECT closing parent.
    const children = this.list().filter(task => task.parentId === parentId && !FLEET_TASK_TERMINAL_STATES.includes(task.state))
    for (const child of children) {
      const closed: FleetTask = {
        ...child,
        state: closeState,
        assignee: undefined,
        locks: [],
        autoClosedBy: parentId,
        ...(closeState === 'Completed' ? { completedAt: now } : {}),
        updatedAt: now,
      }
      this.store.put(closed)
      this.publish(FLEET_TASK_EVENT_TYPES.completed, closed, actor, {
        ...(closeState === 'Completed' ? { autoClosedBy: parentId } : {}),
        ...(closeState === 'Cancelled' ? { cancelled: true, autoClosedBy: parentId } : {}),
      })
      this.autoCloseDescendants(child.id, closeState, actor)
    }
  }

  /** Publish a fleet-tasks event to the bus (when composed) + emit a Cordis event. */
  private publish(type: string, task: FleetTask, actor: string, extra: Record<string, JsonValue> = {}): void {
    const payload: Record<string, JsonValue> = {
      taskId: task.id,
      title: task.title,
      state: task.state,
      severity: task.severity,
      ...(task.goalAncestry.length > 0 ? { goalAncestry: [...task.goalAncestry] } : {}),
      ...extra,
    }
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus?.publish === undefined) {
      this.ctx.logger.debug(`fleet-tasks: no fleet-bus composed; not publishing ${type}`)
    } else {
      const identity = this.ctx.get('fleetAgent') as FleetAgentLike | undefined
      let signed: JsonValue | undefined
      if (identity?.sign !== undefined) {
        try {
          signed = identity.sign({ type, actor, payload }) as JsonValue
        } catch (error) {
          this.ctx.logger.debug(`fleet-tasks: unsigned event (actor "${actor}" has no identity profile): ${String(error)}`)
        }
      }
      bus.publish({
        type,
        scope: 'fleet',
        actor,
        originKind: 'task',
        payload: signed !== undefined ? { ...payload, signed } : payload,
      })
    }
    this.ctx.emit('fleet-tasks/event', { type, task, actor })
  }

  private lookupRole(agentId: string, orgChart: Record<string, string> | undefined): string | undefined {
    if (orgChart?.[agentId] !== undefined) return orgChart[agentId]
    const identity = this.ctx.get('fleetAgent') as FleetAgentLike | undefined
    return identity?.getProfile(agentId)?.role
  }
}

/** Claim-priority rank: lower wins. Severity first, then priority, then age. */
function rankTaskForClaim(task: FleetTask): number {
  const severityRank = fleetTaskSeverityRank(task.severity) * 1_000_000
  const priority = Number.parseInt(String(task.priority ?? ''), 10)
  const priorityRank = Number.isNaN(priority) ? 0 : priority * 10_000
  return severityRank + priorityRank + task.createdAt
}

/**
 * Evaluate completion evidence against an artifact contract.
 * `passRange` accepts a comparison operator (`>=|<=|>|<|==|!=`) plus a number,
 * a bare number (equality), or a plain string (equality).
 */
export function evaluateArtifactContract(
  contract: { metric: string; passRange: string },
  evidence: FleetTaskEvidence | undefined,
): { pass: boolean; reason: string } {
  if (evidence === undefined || evidence.result === undefined) {
    return { pass: false, reason: 'no artifact evidence supplied' }
  }
  const actual = evidence.result
  const range = contract.passRange.trim()

  const opMatch = /^(>=|<=|>|<|==|!=)\s*(.*)$/.exec(range)
  if (opMatch !== null) {
    const op = opMatch[1]!
    const expectedText = opMatch[2]!.trim()
    const expectedNum = Number(expectedText)
    const actualNum = Number(actual)
    if (Number.isNaN(expectedNum) || Number.isNaN(actualNum)) {
      return { pass: false, reason: `passRange "${range}" requires numeric evidence; got "${String(actual)}"` }
    }
    switch (op) {
      case '>=': return actualNum >= expectedNum ? pass() : fail(`${actualNum} !>= ${expectedNum}`)
      case '<=': return actualNum <= expectedNum ? pass() : fail(`${actualNum} !<= ${expectedNum}`)
      case '>': return actualNum > expectedNum ? pass() : fail(`${actualNum} !> ${expectedNum}`)
      case '<': return actualNum < expectedNum ? pass() : fail(`${actualNum} !< ${expectedNum}`)
      case '==': return actualNum === expectedNum ? pass() : fail(`${actualNum} !== ${expectedNum}`)
      case '!=': return actualNum !== expectedNum ? pass() : fail(`${actualNum} === ${expectedNum}`)
    }
  }
  // Bare number → numeric equality; otherwise string equality.
  const expectedText = range
  const expectedNum = Number(expectedText)
  if (!Number.isNaN(expectedNum) && typeof actual === 'number') {
    return actual === expectedNum ? pass() : fail(`${actual} !== ${expectedNum}`)
  }
  return String(actual) === expectedText ? pass() : fail(`${JSON.stringify(actual)} !== "${expectedText}"`)
}

function pass(): { pass: boolean; reason: string } {
  return { pass: true, reason: '' }
}

function fail(reason: string): { pass: boolean; reason: string } {
  return { pass: false, reason }
}
