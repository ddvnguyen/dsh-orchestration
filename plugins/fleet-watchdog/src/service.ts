/**
 * FleetWatchdogService — the `ctx.fleetWatchdog` Cordis service behind the
 * fleet-watchdog plugin (issue #26, orchestration-v3 §4 P2.4, #28).
 *
 * The verification gate on stopped work (paperclip Task Watchdog): watch a
 * task tree; when every leaf rests (Completed/Cancelled), VERIFY the stop
 * against evidence — structurally, with NO LLM calls (contract present?
 * evidence non-empty? metric in passRange?). Verification-shaped, distinct
 * from the supervisor's liveness/takeover. A false "done" is REJECTED: the
 * leaf reopens to Unstarted (via the fleet-tasks `accept` hook, the single
 * source of truth for the reopen), a marked review task is created under it,
 * and the leaf is reassigned by org-chart role routing (claimWake) so a live
 * path is restored.
 *
 * Seams (all optional via `ctx.get`, the AGENTS.md optional-service rule):
 * - `fleetTasks`   — REQUIRED for verification: reads leaf state/evidence/
 *   contracts, applies `accept` (the reopen), `create` (the review task),
 *   and `claimWake` (the reassignment). A watchdog without it can only
 *   watch/track; verification degrades with a debug log.
 * - `fleetBus`     — the event surface (fleet/watchdog-stopped, -pass,
 *   -reject). Absent → events dropped (debug log).
 * - `fleetAgent`— ed25519 signing of published events (best-effort).
 *
 * Self-trigger guard (#28): the review task the watchdog creates carries
 * `claimRole: 'watchdog-review'` (and a `[watchdog]` title prefix). That
 * marker flows through goal ancestry — any task whose ancestry chain contains
 * a review task is excluded from the watched subtree, so the watchdog never
 * re-verifies work it created (the task-space analog of fleet-bus'
 * `excludeOriginKinds`).
 *
 * Stop-fingerprint reuse (#28): when a tree rests, a fingerprint over the
 * stopped leaf set + contracts is published with `fleet/watchdog-stopped`;
 * an identical stopped state within `reverifyWindowMs` is not re-verified
 * (fleet-bus wake-dedupe semantics).
 * @module @hydra/dsh-fleet-watchdog/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { systemClock, type FleetClock } from '../../../src/types.ts'
import { computeFingerprint } from '../../fleet-bus/src/fingerprint.ts'
import type { FleetBusEvent } from '../../fleet-bus/src/types.ts'
import { FLEET_TASK_EVENT_TYPES, evaluateArtifactContract } from '../../fleet-tasks/src/service.ts'
import type {
  FleetTask,
  FleetTaskAcceptResult,
  FleetTaskClaimResult,
  FleetTaskCreateInput,
} from '../../fleet-tasks/src/types.ts'
import { FLEET_TASK_TERMINAL_STATES } from '../../fleet-tasks/src/types.ts'
import type {
  WatchRecord,
  WatchdogLeafResult,
  WatchdogLeafView,
  WatchdogVerifyResult,
  WatchdogWatchStatus,
} from './types.ts'
import { watchdogEvidenceSummary } from './types.ts'

/** Actor + mechanism label for every watchdog-produced event. */
export const WATCHDOG_ACTOR = 'watchdog'
export const WATCHDOG_ORIGIN_KIND = 'watchdog'
/** The claimRole marker on review tasks the watchdog creates (self-trigger guard). */
export const WATCHDOG_REVIEW_ROLE = 'watchdog-review'
/** Title prefix that also marks review tasks (human + filter readable). */
export const WATCHDOG_REVIEW_TITLE_PREFIX = '[watchdog]'

/** The bus event types that drive the "tree rests → verify" recompute. */
export const WATCHDOG_TRIGGER_EVENT_TYPES: readonly string[] = [
  FLEET_TASK_EVENT_TYPES.completed,
  FLEET_TASK_EVENT_TYPES.cancelled,
  FLEET_TASK_EVENT_TYPES.rejected,
]

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetWatchdog: FleetWatchdogService
  }

  interface Events {
    /**
     * One watchdog decision occurred (tree stopped / verified / rejected).
     * Emitted synchronously after the optional fleet-bus publish, so
     * in-process observers get the verdict even when no bus is composed.
     * @param info - the decision type + the tree root + a JSON-safe payload.
     * @mode emit
     */
    'fleet-watchdog/event'(info: { type: string; treeRootId: string; payload: JsonValue }): void
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
}

/** Structural fleet-agent surface for optional event signing. */
export interface FleetAgentLike {
  sign(input: { type: string; actor: string; payload: JsonValue; ts?: number }): { sig: string; pubkey: string }
}

/** The fleet-tasks surface the watchdog needs (structural; real service satisfies it). */
export interface FleetTasksLike {
  get(id: string): FleetTask | undefined
  list(filter?: { state?: string; goal?: string }): FleetTask[]
  create(input: FleetTaskCreateInput, actor: string): FleetTask
  accept(taskId: string, input: unknown, actor: string): FleetTaskAcceptResult
  claimWake(agentId: string, entry: { kind: string; agentId: string; taskId?: string; role?: string }): FleetTaskClaimResult
}

export interface FleetWatchdogConfig {
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /**
   * Stop-fingerprint re-verification window (ms, #28). An identical stopped
   * state (leaf set + contracts) re-encountered within the window is not
   * re-verified — the fleet-bus wake-dedupe semantics. Default 60 s.
   */
  reverifyWindowMs?: number
  /** Org-chart reassignment: role → agent id, used after a false-done reject. */
  reassignAgents?: Record<string, string>
  /**
   * Reassignment role resolver: given a leaf's claimRole, return the agent id
   * to reassign the reopened leaf to. Defaults to `reassignAgents[role]`; a
   * leaf without a role is left unassigned (re-claimable via the queue).
   */
  resolveAgentForRole?: (role: string | undefined) => string | undefined
}

/**
 * The structural shape the auto-trigger needs from a fleet-tasks mutation
 * event (both the Cordis `fleet-tasks/event` and the bus `fleet/task-*` seam).
 */
interface TaskEventLike {
  readonly id: string
  readonly goalAncestry: readonly string[]
}

export class FleetWatchdogService extends Service {
  private readonly clock: FleetClock
  /** Stop-fingerprint re-verification window (ms, #28) — surfaced by watchdog_status. */
  readonly reverifyWindowMs: number
  private readonly reassignAgents: Record<string, string>
  private readonly resolveAgentForRole: ((role: string | undefined) => string | undefined) | undefined
  /** Watched trees, keyed by tree root id. */
  private readonly watches = new Map<string, WatchRecord>()
  /** Trees currently inside a verification pass (re-entrancy guard). */
  private readonly verifying = new Set<string>()

  constructor(ctx: Context, config: FleetWatchdogConfig = {}) {
    super(ctx, 'fleetWatchdog')
    this.clock = config.clock ?? systemClock
    this.reverifyWindowMs = config.reverifyWindowMs ?? 60_000
    this.reassignAgents = config.reassignAgents ?? {}
    this.resolveAgentForRole = config.resolveAgentForRole

    // Auto-trigger: on every fleet-tasks mutation, recompute the watches whose
    // tree contains the mutated task. `fleet-tasks/event` fires per mutation
    // with the full task (the primary seam — verified against the real plugin);
    // the bus `fleet-bus/event` seam is a fallback for out-of-process
    // observers. Recomputation is idempotent: the rest-check + stop-fingerprint
    // dedupe make repeated triggers harmless.
    ctx.on('fleet-tasks/event', (info: { type: string; task: FleetTask }) => {
      this.recomputeForTask(info.task)
    })
    ctx.on('fleet-bus/event', (event: FleetBusEvent) => {
      if (!WATCHDOG_TRIGGER_EVENT_TYPES.includes(event.type)) return
      const taskId = readPayload(event.payload, 'taskId')
      if (typeof taskId !== 'string') return
      const task = this.ctx.get('fleetTasks') as FleetTasksLike | undefined
      const current = task?.get(taskId)
      if (current !== undefined) this.recomputeForTask(current)
    })
  }

  // ---- watch assignment ----

  /**
   * Assign a task tree (a top-level goal + its descendants, via goal ancestry
   * containment) to watched state. When the tree is already at rest it goes
   * straight to the verification phase; otherwise it waits for the leaves to
   * rest (each fleet/task-completed event recomputes the leaf set).
   * @param treeRootId - the top-level goal task id.
   * @returns the watch record.
   * @throws when the root task does not exist or fleet-tasks is absent.
   */
  watch(treeRootId: string): WatchRecord {
    const tasks = this.requireTasks()
    if (tasks.get(treeRootId) === undefined) {
      throw new Error(`fleet-watchdog: tree root "${treeRootId}" not found`)
    }
    let watch = this.watches.get(treeRootId)
    if (watch === undefined) {
      watch = { treeRootId, status: 'watching', createdAt: this.clock.now() }
      this.watches.set(treeRootId, watch)
    }
    this.verify(treeRootId)
    return watch
  }

  /** Remove a tree from watch. Returns true when it was watched. */
  unwatch(treeRootId: string): boolean {
    return this.watches.delete(treeRootId)
  }

  /** Watched trees, in watch order (status tool + tests). */
  listWatches(): readonly WatchRecord[] {
    return [...this.watches.values()]
  }

  /** One watch record. */
  status(treeRootId: string): WatchRecord | undefined {
    return this.watches.get(treeRootId)
  }

  // ---- verification ----

  /**
   * Run the verification gate on a watched tree: recompute the leaf set, and
   * when every (non-review) leaf rests, verify each stopped leaf against its
   * artifact contract. PASS leaves stay Completed (accepted); a false-done
   * leaf is reopened + reassigned. Identical stopped states within the
   * reverify window are suppressed (stop-fingerprint, #28) unless `force`.
   */
  verify(treeRootId: string, opts: { force?: boolean; now?: number } = {}): WatchdogVerifyResult {
    const tasks = this.requireTasks()
    const watch = this.watches.get(treeRootId)
    if (watch === undefined) {
      return { treeRootId, rested: false, leaves: [], reason: `tree "${treeRootId}" is not watched` }
    }
    // Re-entrancy guard (must precede ANY watch mutation): a verification pass
    // applies accept/claimWake/create mutations, which emit fleet-tasks events
    // that re-enter recomputeForTask → verify. A tree already mid-verification
    // is skipped so the running pass (and its outcome) is not clobbered.
    if (this.verifying.has(treeRootId)) {
      return { treeRootId, rested: false, suppressed: true, reason: 'verification already in progress', leaves: [] }
    }
    const root = tasks.get(treeRootId)
    if (root === undefined) {
      return { treeRootId, rested: false, leaves: [], reason: `tree root "${treeRootId}" no longer exists` }
    }
    const leaves = this.computeLeaves(treeRootId)
    const rested = leaves.length > 0 && leaves.every(leaf => FLEET_TASK_TERMINAL_STATES.includes(leaf.state))
    if (!rested) {
      // A rejection outcome is STICKY (the "needs attention" signal): the
      // reopen + reassign mutations that follow a REJECT re-enter this branch
      // immediately, and must not erase the fact that a false-done was caught.
      // Only a later PASS clears it.
      if (watch.status !== 'rejected') watch.status = 'watching'
      return { treeRootId, rested: false, leaves: leavesToViews(leaves) }
    }

    const now = opts.now ?? this.clock.now()
    const fingerprint = computeFingerprint(this.stopFingerprintState(treeRootId, leaves))
    if (
      !opts.force
      && watch.stoppedFingerprint === fingerprint
      && watch.lastVerifiedAt !== undefined
      && now - watch.lastVerifiedAt < this.reverifyWindowMs
    ) {
      return {
        treeRootId,
        rested: true,
        suppressed: true,
        reason: 'identical stopped state within the reverify window (stop-fingerprint, #28)',
        stoppedFingerprint: fingerprint,
        leaves: leavesToViews(leaves),
      }
    }

    this.verifying.add(treeRootId)
    try {
      watch.status = 'verifying'
      watch.stoppedFingerprint = fingerprint
      watch.lastStoppedAt = now

      this.publishEvent('fleet/watchdog-stopped', {
        treeRootId,
        stoppedFingerprint: fingerprint,
        leafIds: leaves.map(leaf => leaf.id),
        leafStates: Object.fromEntries(leaves.map(leaf => [leaf.id, leaf.state])),
      }, { fingerprint, treeRootId })

      const results: WatchdogLeafResult[] = []
      const rejected: Array<{ taskId: string; reason: string }> = []
      for (const leaf of leaves) {
        const result = this.verifyLeaf(leaf, now)
        results.push(result)
        if (result.verdict === 'REJECT') rejected.push({ taskId: leaf.id, reason: result.reason ?? 'false-done' })
      }

      if (rejected.length > 0) {
        watch.status = 'rejected'
        watch.rejectedAt = now
        watch.lastVerdict = 'REJECT'
        watch.lastReason = rejected.map(entry => `${entry.taskId}: ${entry.reason}`).join('; ')
        for (const result of results) {
          if (result.verdict !== 'REJECT') continue
          const leaf = leaves.find(candidate => candidate.id === result.taskId)
          if (leaf !== undefined) this.handleReject(leaf, watch, now, result.reason)
        }
      } else {
        watch.status = 'verified'
        watch.verifiedAt = now
        watch.lastVerifiedAt = now
        watch.lastVerdict = 'PASS'
        this.publishEvent('fleet/watchdog-pass', {
          treeRootId,
          leaves: results.map(result => ({ taskId: result.taskId, state: result.state, verdict: result.verdict, ...(result.reason !== undefined ? { reason: result.reason } : {}) })),
        }, { treeRootId })
      }
      watch.leaves = results.map(result => ({
        taskId: result.taskId,
        state: result.state,
        verdict: result.verdict,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      }))

      return {
        treeRootId,
        rested: true,
        stoppedFingerprint: fingerprint,
        leaves: watch.leaves,
        verdict: rejected.length > 0 ? 'REJECT' : 'PASS',
        ...(rejected.length > 0 ? { rejected } : {}),
      }
    } finally {
      this.verifying.delete(treeRootId)
    }
  }

  /**
   * The leaf set of a watched tree (#28 goal ancestry): the root plus every
   * task whose ancestry contains it, MINUS watchdog review tasks (self-trigger
   * guard — the `watchdog-review` marker flows through the ancestry chain, so
   * a review task and its whole descendant subtree are excluded).
   */
  computeLeaves(treeRootId: string): FleetTask[] {
    const tasks = this.requireTasks()
    const all = tasks.list({ goal: treeRootId })
    const root = tasks.get(treeRootId)
    if (root === undefined) return []
    const treeTasks = [root, ...all]
    const reviewIds = new Set<string>()
    for (const task of tasks.list()) {
      if (task.claimRole === WATCHDOG_REVIEW_ROLE) reviewIds.add(task.id)
    }
    const isReview = (task: FleetTask): boolean =>
      task.claimRole === WATCHDOG_REVIEW_ROLE
      || task.goalAncestry.some(ancestor => reviewIds.has(ancestor))
    const nonReview = treeTasks.filter(task => !isReview(task))
    const parentIds = new Set<string>()
    for (const task of nonReview) {
      if (task.parentId !== undefined) parentIds.add(task.parentId)
    }
    // A leaf has no child inside the (non-review) tree.
    return nonReview.filter(task => !parentIds.has(task.id))
  }

  // ---- internals ----

  /** Verify ONE stopped leaf: structural evidence check + fleet-tasks accept. */
  private verifyLeaf(leaf: FleetTask, now: number): WatchdogLeafResult {
    const tasks = this.requireTasks()
    if (leaf.state === 'Cancelled') {
      return { taskId: leaf.id, state: leaf.state, verdict: 'PASS', reason: 'cancelled — legitimate stop, nothing to verify' }
    }
    if (leaf.state !== 'Completed') {
      return { taskId: leaf.id, state: leaf.state, verdict: 'SKIP', reason: `not terminal in this pass (${leaf.state})` }
    }
    const contract = leaf.artifactContract
    const evidence = leaf.evidence
    const evidencePresent = evidence !== undefined && evidence.result !== undefined && evidence.result !== null && evidence.result !== ''

    // No contract → nothing structural to verify (fleet-tasks accept agrees).
    if (contract === undefined) {
      tasks.accept(leaf.id, {}, WATCHDOG_ACTOR)
      return { taskId: leaf.id, state: 'Completed', verdict: 'PASS', reason: 'no artifact contract — nothing to verify' }
    }
    // Contract present but no evidence → structural false-done.
    if (!evidencePresent) {
      const result = tasks.accept(leaf.id, {}, WATCHDOG_ACTOR)
      return {
        taskId: leaf.id,
        state: result.task.state,
        verdict: 'REJECT',
        reason: result.reason ?? 'no artifact evidence supplied',
      }
    }
    const check = evaluateArtifactContract(contract, evidence)
    if (check.pass) {
      tasks.accept(leaf.id, {}, WATCHDOG_ACTOR)
      return { taskId: leaf.id, state: 'Completed', verdict: 'PASS', reason: `evidence satisfies [${contract.metric}] ${contract.passRange}` }
    }
    const result = tasks.accept(leaf.id, {}, WATCHDOG_ACTOR)
    return {
      taskId: leaf.id,
      state: result.task.state,
      verdict: 'REJECT',
      reason: result.reason ?? check.reason,
    }
  }

  /**
   * A false-done leaf: publish `fleet/watchdog-reject` (evidence summary),
   * create a marked review task under it (self-trigger guard), and reassign
   * the reopened leaf by org-chart role routing (claimWake) to restore a live
   * path.
   */
  private handleReject(leaf: FleetTask, watch: WatchRecord, now: number, leafReason: string | undefined): void {
    const tasks = this.requireTasks()
    const evidence = watchdogEvidenceSummary(leaf.artifactContract, leaf.evidence)
    const reason = leafReason ?? leaf.acceptance?.reason ?? 'false-done'
    const payload: Record<string, JsonValue> = {
      treeRootId: watch.treeRootId,
      taskId: leaf.id,
      title: leaf.title,
      reason,
      reopened: true,
      evidence,
    }

    let reviewTaskId: string | undefined
    try {
      const review = tasks.create({
        title: `${WATCHDOG_REVIEW_TITLE_PREFIX} verify "${leaf.title}" after false-done`,
        parentId: leaf.id,
        severity: 'P1',
        claimRole: WATCHDOG_REVIEW_ROLE,
      }, WATCHDOG_ACTOR)
      reviewTaskId = review.id
      payload.reviewTaskId = review.id
    } catch (error) {
      this.ctx.logger.warn(`fleet-watchdog: review task creation failed — ${error instanceof Error ? error.message : String(error)}`)
    }

    const reassignAgent = this.resolveReassignAgent(leaf.claimRole)
    if (reassignAgent !== undefined) {
      try {
        const claim = tasks.claimWake(reassignAgent, { kind: 'task-claim', agentId: reassignAgent, taskId: leaf.id, ...(leaf.claimRole !== undefined ? { role: leaf.claimRole } : {}) })
        if (claim.ok) {
          payload.reassignedAgentId = reassignAgent
        } else {
          this.ctx.logger.debug(`fleet-watchdog: reassign of "${leaf.id}" to "${reassignAgent}" failed — ${claim.reason ?? 'unknown'}`)
        }
      } catch (error) {
        this.ctx.logger.warn(`fleet-watchdog: reassign of "${leaf.id}" failed — ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.publishEvent('fleet/watchdog-reject', payload, { treeRootId: watch.treeRootId })
  }

  /** Resolve the reassignment agent for a leaf's claimRole (org-chart routing). */
  private resolveReassignAgent(role: string | undefined): string | undefined {
    if (role !== undefined && this.reassignAgents[role] !== undefined) return this.reassignAgents[role]
    return this.resolveAgentForRole?.(role)
  }

  /** Recompute every watch whose tree contains the mutated task. */
  private recomputeForTask(task: TaskEventLike): void {
    for (const watch of this.watches.values()) {
      if (watch.treeRootId === task.id || task.goalAncestry.includes(watch.treeRootId)) {
        this.verify(watch.treeRootId)
      }
    }
  }

  /** The stop-fingerprint state: tree root + sorted leaf {id, state, contract}. */
  private stopFingerprintState(treeRootId: string, leaves: FleetTask[]): JsonValue {
    return {
      treeRootId,
      leaves: leaves
        .map(leaf => ({ id: leaf.id, state: leaf.state, contract: (leaf.artifactContract ?? null) as JsonValue }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }
  }

  /** fleet-tasks is REQUIRED for verification; degrade gracefully when absent. */
  private requireTasks(): FleetTasksLike {
    const tasks = this.ctx.get('fleetTasks') as FleetTasksLike | undefined
    if (tasks === undefined || typeof tasks.get !== 'function') {
      throw new Error('fleet-watchdog: ctx.fleetTasks is required (mount the fleet-tasks plugin first)')
    }
    return tasks
  }

  /**
   * Publish a watchdog event on the fleet-bus (when composed), with
   * `originKind: 'watchdog'` (so nothing watchdog-produced can self-trigger a
   * watchdog subscriber — the fleet-bus self-trigger guard) and, when a
   * `watchdog` identity profile exists, an ed25519 signature embedded in the
   * payload. Best-effort: absent bus/identity degrades to a debug log /
   * unsigned event.
   */
  private publishEvent(type: string, payload: Record<string, JsonValue | undefined>, context: { fingerprint?: string; treeRootId: string } = { treeRootId: '' }): void {
    const cleanPayload: Record<string, JsonValue> = Object.fromEntries(
      Object.entries(payload).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
    )
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus === undefined || typeof bus.publish !== 'function') {
      this.ctx.logger.debug(`fleet-watchdog: no fleet-bus composed; ${type} not published`)
    } else {
      let body: JsonValue = cleanPayload
      const identity = this.ctx.get('fleetAgent') as FleetAgentLike | undefined
      if (identity !== undefined && typeof identity.sign === 'function') {
        try {
          const signed = identity.sign({ type, actor: WATCHDOG_ACTOR, payload: cleanPayload, ts: this.clock.now() })
          body = { ...cleanPayload, signed: signed as unknown as JsonValue }
        } catch (error) {
          this.ctx.logger.debug(
            `fleet-watchdog: signing ${type} skipped — ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      bus.publish({
        type,
        scope: 'fleet',
        actor: WATCHDOG_ACTOR,
        originKind: WATCHDOG_ORIGIN_KIND,
        payload: body,
        ...(context.fingerprint !== undefined ? { fingerprint: context.fingerprint } : {}),
      })
    }
    this.ctx.emit('fleet-watchdog/event', { type, treeRootId: context.treeRootId, payload: cleanPayload })
  }
}

/** Narrow a task to the JSON view the watchdog returns. */
function leavesToViews(leaves: FleetTask[]): WatchdogLeafView[] {
  return leaves.map(leaf => ({
    taskId: leaf.id,
    state: leaf.state,
    ...(leaf.assignee !== undefined ? { assignee: leaf.assignee } : {}),
    ...(leaf.claimRole !== undefined ? { claimRole: leaf.claimRole } : {}),
    ...(leaf.artifactContract !== undefined ? { artifactContract: leaf.artifactContract } : {}),
  }))
}

/** Read a JSON-safe payload field as a string (best-effort). */
function readPayload(payload: JsonValue, key: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  return (payload as Record<string, JsonValue>)[key]
}
