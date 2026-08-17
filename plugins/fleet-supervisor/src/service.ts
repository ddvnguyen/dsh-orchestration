/**
 * FleetSupervisorService — the `ctx.fleetSupervisor` Cordis service behind the
 * fleet-supervisor plugin (issue #26, orchestration-v3 §4 P2.2 + §4.1).
 *
 * The fleet's timer-driven supervisor: a 30 s heartbeat tick (the fleet-heartbeat
 * pattern, src/service.ts:87-94) drives the fleet-scheduler wake scan, takeover,
 * orphan recovery, the #28 silent active-run watchdog, periodic digests, and the
 * verification-gated merge queue (#28, Bors-style, gastown Refinery).
 *
 * DELIVERY SEAM (shared with fleet-bus, file:line in the dsh submodule):
 * - `Agent.followup(message: UserMessage): void` —
 *   packages/core/agent/src/runtime-types.ts:124 (wake) — resolved through the
 *   same optional `ctx.get('agents')` registry access fleet-bus uses
 *   (packages/core/agent/src/index.ts:583), or a test-injected `resolveAgent`
 *   hook.
 * - Wake prompt construction mirrors fleet-bus
 *   (plugins/fleet-bus/src/service.ts:208-213): `createUserMessage` with the
 *   plugin `MessageSource` (packages/llm/llm/src/message.ts:100-105).
 *
 * Every supervisor event is published with `originKind: 'supervisor'` so
 * nothing the supervisor emits can self-trigger a supervisor subscriber (the
 * fleet-bus self-trigger guard), and is ed25519-signed via `ctx.fleetAgent`
 * when a `supervisor` profile is registered (best-effort: unsigned otherwise).
 *
 * Optional seams (all resolved via `ctx.get`, the AGENTS.md optional-service
 * rule — plugins/fleet-bus/src/service.ts:243-248):
 * - `fleet`        — registry: stall state (takeover), workspace (meta.cwd).
 * - `fleetBus`     — the event surface (fleet/wake, fleet/takeover, …).
 * - `fleetAgent`— ed25519 signing of published events.
 * - `fleetBudget`  — soft-warning escalation gate (owner decision #4).
 * - `fleetTasks`   — claimWake handoff + ready-queue rollup (P2.1, concurrent).
 * - `skills`       — skill content injected into wake prompts (dsh skill pkg).
 * @module @hydra/dsh-fleet-supervisor/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { renderSkillContent, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import { systemClock, type FleetAgentEntry, type FleetAgentView, type FleetClock } from '../../../src/types.ts'
import { computeFingerprint } from '../../fleet-bus/src/fingerprint.ts'
import type { FleetBusEvent, FleetBusEventInput } from '../../fleet-bus/src/types.ts'
import { WakeQueueStore } from './queue.ts'
import type {
  FleetBudgetLike,
  FleetDigestSummary,
  FleetSupervisorTickResult,
  FleetTasksLike,
  MergeGate,
  MergeGateResult,
  MergeQueueEntry,
  MergeQueueEntryInput,
  WakeEntry,
  WakeEntryInput,
} from './types.ts'

/** Actor + mechanism label for every supervisor-produced event. */
export const SUPERVISOR_ACTOR = 'supervisor'
export const SUPERVISOR_ORIGIN_KIND = 'supervisor'
/** Wake kinds that hand off to the fleet-tasks claim seam. */
export const TASK_CLAIM_KIND = 'task-claim'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetSupervisor: FleetSupervisorService
  }

  interface Events {
    /**
     * A fleet digest was emitted (also published as a `fleet/digest` bus
     * event). Observers use it for the board, dashboards, or policies.
     * @param summary - the digest summary.
     * @mode emit
     */
    'fleet-supervisor/digest'(summary: FleetDigestSummary): void
  }
}

/** The minimal live-agent surface delivery needs (structural: Agent satisfies it). */
export interface FleetSupervisorDeliveryTarget {
  followup(message: UserMessage): void
  inject(message: UserMessage): void
}

/** Structural view of the agent registry used for optional delivery lookup. */
interface AgentRegistryLike {
  get(id: string): FleetSupervisorDeliveryTarget | undefined
}

/** Structural view of the fleet-bus service (only what the supervisor needs). */
interface FleetBusLike {
  publish(input: FleetBusEventInput): FleetBusEvent
  replay(filter?: { type?: string; scope?: string }, since?: number): FleetBusEvent[]
}

/** Structural view of the fleet-agent service (signing seam). */
interface FleetAgentLike {
  sign(input: { type: string; actor: string; payload: JsonValue; ts?: number }): { sig: string; pubkey: string }
}

/**
 * The disabled-agent consult seam (P4.3, fleet-admin §4.3): the wake scan
 * consults `ctx.fleetAgent.isEnabled(agentId)` before delivering — a disabled
 * agent's wakes are skipped (entries stay pending; they flow once re-enabled).
 * Satisfied structurally by FleetAgentService.isEnabled (plugins/fleet-agent/
 * src/service.ts). Absent service → no gating (regression-safe default).
 */
interface FleetAgentEnabledLike {
  isEnabled(agentId: string): boolean
}

/** Structural view of the fleet-heartbeat registry (stall + workspace seam). */
interface FleetLike {
  list(): FleetAgentEntry[]
  getStatus(id: string): FleetAgentView | undefined
}

/** Structural view of the dsh skill registry (skill-loading seam). */
interface SkillRegistryLike {
  get(name: string): Promise<SkillDefinition | undefined>
}

/** One delivered wake, tracked for orphan recovery. */
interface ActiveWakeRecord {
  readonly entryId: string
  readonly agentId: string
  /** Unix epoch ms the wake was delivered. */
  readonly wokeAt: number
}

export interface FleetSupervisorConfig {
  /** Tick timer cadence. Default 30 s. */
  tickMs?: number
  /** Directory holding the durable wake queue. Default `$DSH_HOME/fleet`. */
  storeDir?: string
  /** Wake queue file name. Default `fleet-wake-queue.jsonl`. */
  storeFile?: string
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /** Delivery-target resolver (tests inject fake targets). */
  resolveAgent?: (agentId: string) => FleetSupervisorDeliveryTarget | undefined
  /**
   * Takeover successor resolver: given a stalled agent, return its successor.
   * Absent → takeover re-due's the entries to the stalled agent itself.
   */
  successorFor?: (agentId: string) => string | undefined
  /** Woken-run window before orphan recovery re-dues the entry. Default 15 min. */
  orphanThresholdMs?: number
  /** Active-but-silent window before `fleet/silent-run` fires (#28). Default 10 min. */
  silentThresholdMs?: number
  /** Re-arm interval for a repeated silent-run signal on the same agent. Default 60 s. */
  silentResendMs?: number
  /** Digest emission interval. Default 10 min. */
  digestIntervalMs?: number
  /** Budget-deferred entries re-enter the due scan after this delay. Default 5 min. */
  budgetRetryMs?: number
  /** Named verification gates the merge queue resolves at enqueue (#28). */
  mergeGates?: Record<string, MergeGate>
}

/** A `wake` entry grouped with the other due entries for the same agent. */
interface WakeGroup {
  readonly agentId: string
  readonly entries: WakeEntry[]
}

export class FleetSupervisorService extends Service {
  readonly wakeQueue: WakeQueueStore
  private readonly clock: FleetClock
  private readonly tickMs: number
  private readonly orphanThresholdMs: number
  private readonly silentThresholdMs: number
  private readonly silentResendMs: number
  private readonly digestIntervalMs: number
  private readonly budgetRetryMs: number
  private readonly resolveAgent: (agentId: string) => FleetSupervisorDeliveryTarget | undefined
  private readonly successorFor: ((agentId: string) => string | undefined) | undefined
  private readonly mergeGates = new Map<string, MergeGate>()
  /** Delivered wakes, tracked per entry id for orphan recovery. */
  private readonly activeWakes = new Map<string, ActiveWakeRecord>()
  /** Per-agent last observed bus activity (silent-run watchdog). */
  private readonly lastActivity = new Map<string, number>()
  /** Per-agent last silent-run notification (rate limiting). */
  private readonly lastSilentNotified = new Map<string, number>()
  private lastDigest: number
  /** Verification-gated merge queue (in-memory — BASIC prototype, see README). */
  private readonly mergeEntries: MergeQueueEntry[] = []
  private readonly mergeGateNames = new Set<string>()
  private wakeSeq = 0
  private mergeSeq = 0

  constructor(ctx: Context, config: FleetSupervisorConfig = {}) {
    super(ctx, 'fleetSupervisor')
    this.clock = config.clock ?? systemClock
    this.tickMs = config.tickMs ?? 30_000
    this.orphanThresholdMs = config.orphanThresholdMs ?? 15 * 60_000
    this.silentThresholdMs = config.silentThresholdMs ?? 10 * 60_000
    this.silentResendMs = config.silentResendMs ?? 60_000
    this.digestIntervalMs = config.digestIntervalMs ?? 10 * 60_000
    this.budgetRetryMs = config.budgetRetryMs ?? 5 * 60_000
    this.resolveAgent = config.resolveAgent ?? ((agentId) => this.lookupLiveAgent(agentId))
    this.successorFor = config.successorFor
    this.lastDigest = this.clock.now()
    this.wakeQueue = new WakeQueueStore({ dir: config.storeDir, file: config.storeFile })

    // Pre-seed named verification gates (#28) from config.
    for (const [name, gate] of Object.entries(config.mergeGates ?? {})) this.registerMergeGate(name, gate)

    // The heartbeat tick (the fleet-heartbeat pattern, src/service.ts:87-94).
    // `timer.unref()` so an idle process can exit; the effect cleanup clears it.
    ctx.effect(() => {
      const timer = setInterval(() => {
        void this.runTick().catch((error: unknown) => {
          this.ctx.logger.warn(`fleet-supervisor: tick failed — ${error instanceof Error ? error.message : String(error)}`)
        })
      }, this.tickMs)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'fleet-supervisor: tick timer')

    // Silent-run watchdog activity source: any fleet-bus event the agent
    // produced counts as activity (distinct from heartbeat liveness — #28).
    ctx.on('fleet-bus/event', (event) => {
      this.observeActivity(event.actor)
    })
  }

  // ---- wake queue ----

  /**
   * Durably enqueue a wake entry. The scheduler's wake scan delivers it once
   * its `dueAt` passes.
   */
  enqueueWake(input: WakeEntryInput): WakeEntry {
    if (input.targetAgentId.length === 0) throw new Error('fleet-supervisor: wake target agent must be non-empty')
    if (input.kind.length === 0) throw new Error('fleet-supervisor: wake kind must be non-empty')
    const now = this.clock.now()
    const entry: WakeEntry = {
      id: `${input.kind}-${++this.wakeSeq}`,
      targetAgentId: input.targetAgentId,
      dueAt: input.dueAt ?? now,
      kind: input.kind,
      context: input.context,
      status: 'pending',
      createdAt: now,
      ...(input.skillNames !== undefined ? { skillNames: input.skillNames } : {}),
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
      ...(input.parentEntryId !== undefined ? { parentEntryId: input.parentEntryId } : {}),
    }
    this.wakeQueue.upsert(entry)
    this.publishEvent('fleet/wake-queued', {
      entryId: entry.id,
      agentId: entry.targetAgentId,
      kind: entry.kind,
      dueAt: entry.dueAt,
    })
    return entry
  }

  /** Enqueue now-due and run the wake scan immediately (manual wake path). */
  async wakeNow(agentId: string, input: Omit<WakeEntryInput, 'targetAgentId'>): Promise<WakeEntry> {
    const entry = this.enqueueWake({ targetAgentId: agentId, ...input, dueAt: input.dueAt ?? this.clock.now() })
    await this.wakeScan(this.clock.now())
    return entry
  }

  /** Pending wake entries (observability / queue-status tool). */
  listWakeQueue(): readonly WakeEntry[] {
    return this.wakeQueue.list()
  }

  /**
   * Mark a woken entry (or every wake of an agent) completed — the orphan
   * recovery path treats it as a finished run.
   */
  markWakeComplete(agentId: string, entryId?: string): void {
    if (entryId !== undefined) {
      this.completeWake(entryId, agentId)
      return
    }
    for (const [id, record] of [...this.activeWakes]) {
      if (record.agentId === agentId) this.completeWake(id, agentId)
    }
  }

  private completeWake(entryId: string, agentId: string): void {
    this.activeWakes.delete(entryId)
    const entry = this.wakeQueue.get(entryId)
    if (entry !== undefined) {
      entry.status = 'completed'
      this.wakeQueue.upsert(entry)
    }
    this.ctx.logger.debug(`fleet-supervisor: wake ${entryId} for ${agentId} completed`)
  }

  // ---- activity observation (silent-run watchdog, #28) ----

  /** Record that an agent produced event activity (resets its silent timer). */
  observeActivity(agentId: string): void {
    this.lastActivity.set(agentId, this.clock.now())
  }

  /** Force a digest now (tool + tests). */
  emitDigest(now: number = this.clock.now()): FleetDigestSummary {
    const fleet = this.ctx.get('fleet') as FleetLike | undefined
    const agents = (fleet?.list() ?? []).map(agent => ({ id: agent.id, status: agent.status }))
    const silentCount = (fleet?.list() ?? []).filter(agent => agent.status === 'active').filter((agent) => {
      const lastAct = this.lastActivity.get(agent.id) ?? now
      return now - lastAct > this.silentThresholdMs
    }).length
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    const summary: FleetDigestSummary = {
      ts: now,
      agents,
      activeCount: agents.filter(agent => agent.status === 'active').length,
      stalledCount: agents.filter(agent => agent.status === 'stalled').length,
      silentCount,
      pendingWakes: this.wakeQueue.list().filter(entry => entry.status === 'pending').length,
      readyQueueLength: this.readyQueue().length,
      recentActivity: bus?.replay({}, this.lastDigest).length ?? 0,
    }
    this.lastDigest = now
    this.publishEvent('fleet/digest', { ...summary })
    this.ctx.emit('fleet-supervisor/digest', summary)
    return summary
  }

  /** Ready-queue rollup: fleet-tasks unstarted tasks; empty when absent. */
  readyQueue(): Array<{ id: string; status: string }> {
    const tasks = this.ctx.get('fleetTasks') as FleetTasksLike | undefined
    if (tasks === undefined || typeof tasks.list !== 'function') return []
    try {
      return tasks.list({ state: 'Unstarted' }).map(task => ({ id: task.id, status: task.state }))
    } catch (error) {
      this.ctx.logger.warn(`fleet-supervisor: fleetTasks.list failed — ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  // ---- merge queue (#28, Bors-style) ----

  /** Register a named verification gate the merge queue resolves at enqueue. */
  registerMergeGate(name: string, gate: MergeGate): void {
    this.mergeGates.set(name, gate)
    this.mergeGateNames.add(name)
  }

  /** Gate names available to `fleet_merge_enqueue`. */
  listMergeGates(): string[] {
    return [...this.mergeGateNames]
  }

  /**
   * Enqueue a verification-gated merge entry. Every gate must be a registered
   * name (unknown gates fail fast at enqueue so the caller learns immediately).
   */
  enqueueMerge(input: MergeQueueEntryInput): MergeQueueEntry {
    const gates: MergeGate[] = []
    for (const name of input.gateNames) {
      const gate = this.mergeGates.get(name)
      if (gate === undefined) throw new Error(`fleet-supervisor: unknown merge gate "${name}"`)
      gates.push(gate)
    }
    const entry: MergeQueueEntry = {
      id: `merge-${++this.mergeSeq}`,
      title: input.title,
      target: input.target,
      sourceRef: input.sourceRef,
      ownerAgentId: input.ownerAgentId,
      gates,
      status: 'pending',
      attempts: 0,
      isolated: false,
      enqueuedAt: this.clock.now(),
    }
    this.mergeEntries.push(entry)
    this.publishEvent('fleet/merge-enqueued', {
      id: entry.id,
      title: entry.title,
      target: entry.target,
      sourceRef: entry.sourceRef,
      gates: gates.map(gate => gate.name),
    })
    return entry
  }

  /** Merge queue entries (status tool). */
  listMergeQueue(): readonly MergeQueueEntry[] {
    return this.mergeEntries
  }

  /**
   * Run every pending merge entry's gates. All pass → `merged` + `fleet/merge-pass`;
   * any gate fails → `failed`, isolated, `fleet/merge-fail`, and a `merge-fix`
   * wake is re-dispatched to the owner agent. Full GitHub integration is out of
   * scope — this is the verification contract seam (documented in the README).
   */
  async runMergeScan(): Promise<number> {
    let scanned = 0
    for (const entry of this.mergeEntries) {
      if (entry.status !== 'pending') continue
      entry.status = 'verifying'
      entry.attempts += 1
      let verdict: MergeGateResult = { ok: true }
      let failedGate: string | undefined
      for (const gate of entry.gates) {
        let result: MergeGateResult
        if (gate.kind === 'check' && gate.check !== undefined) result = { ok: gate.check(entry) }
        else if (gate.kind === 'callback' && gate.verify !== undefined) result = await gate.verify(entry, this)
        else result = { ok: false, reason: `gate "${gate.name}" has no verifier` }
        if (!result.ok) {
          verdict = result
          failedGate = gate.name
          break
        }
      }
      if (failedGate === undefined) {
        entry.status = 'merged'
        entry.verifiedAt = this.clock.now()
        this.publishEvent('fleet/merge-pass', {
          id: entry.id,
          gates: entry.gates.map(gate => gate.name),
        })
      } else {
        entry.status = 'failed'
        entry.isolated = true
        entry.lastResult = verdict
        this.publishEvent('fleet/merge-fail', {
          id: entry.id,
          gate: failedGate,
          reason: verdict.reason,
          isolated: true,
        })
        // Isolated + re-dispatched: the owner agent gets a fix wake.
        this.enqueueWake({
          targetAgentId: entry.ownerAgentId,
          kind: 'merge-fix',
          context: { mergeId: entry.id, sourceRef: entry.sourceRef, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) },
          dueAt: this.clock.now(),
        })
      }
      scanned += 1
    }
    return scanned
  }

  // ---- the heartbeat tick ----

  /**
   * One full supervisor pass, called on the heartbeat tick (and by tests):
   * wake scan → takeover → orphan recovery → silent-run watchdog → digest →
   * merge scan.
   */
  async runTick(now: number = this.clock.now()): Promise<FleetSupervisorTickResult> {
    const woke = await this.wakeScan(now)
    const takenOverEntries = this.takeoverScan(now)
    const orphanEntries = this.orphanScan(now)
    const silentAgents = this.silentScan(now)
    const digestEmitted = this.digestCheck(now)
    const mergeScanned = await this.runMergeScan()
    return {
      agentsWoken: woke.agentsWoken,
      wokenEntries: woke.wokenEntries,
      takenOverEntries,
      orphanEntries,
      silentAgents,
      budgetBlocked: woke.budgetBlocked,
      digestEmitted,
      mergeScanned,
    }
  }

  // ---- fleet-scheduler: the wake scan (§4.1) ----

  /**
   * Due entries → coalesce (ONE wake per agent per tick) → budget check
   * (soft-warning escalates instead of waking) → workspace resolution →
   * skill loading → `agent.followup(wake prompt)` → entries consumed →
   * `fleet/wake` published (originKind `supervisor`, signed, fingerprinted).
   */
  private async wakeScan(now: number): Promise<{ agentsWoken: string[]; wokenEntries: string[]; budgetBlocked: string[] }> {
    const agentsWoken: string[] = []
    const wokenEntries: string[] = []
    const budgetBlocked: string[] = []

    // Re-activate budget-blocked entries whose retryAt has passed.
    for (const entry of this.wakeQueue.list()) {
      if (entry.status === 'blocked' && entry.retryAt !== undefined && entry.retryAt <= now) {
        entry.status = 'pending'
        entry.blockedReason = undefined
        this.wakeQueue.upsert(entry)
      }
    }

    const due = this.wakeQueue.list().filter(entry =>
      entry.status === 'pending' && entry.dueAt <= now && (entry.retryAt === undefined || entry.retryAt <= now))
    if (due.length === 0) return { agentsWoken, wokenEntries, budgetBlocked }

    for (const group of groupByAgent(due)) {
      // Disabled-agent consult (P4.3 §4.3): a disabled profile never receives
      // wakes (and, transitively, never enters the claimWake handoff below).
      // Entries stay pending — they flow once the agent is re-enabled. Skips
      // BEFORE the budget check so a disabled agent is not budget-blocked.
      const fleetAgent = this.ctx.get('fleetAgent') as FleetAgentEnabledLike | undefined
      if (fleetAgent?.isEnabled(group.agentId) === false) {
        this.publishEvent('fleet/wake-skipped', {
          agentId: group.agentId,
          entryIds: group.entries.map(entry => entry.id),
          reason: 'disabled',
        })
        continue
      }

      // Budget check seam (owner decision #4): soft-warning level escalates
      // instead of waking; the entries defer and retry after budgetRetryMs.
      const budget = this.ctx.get('fleetBudget') as FleetBudgetLike | undefined
      const level = budget?.checkWake(group.agentId) ?? 'ok'
      if (level !== 'ok') {
        for (const entry of group.entries) {
          entry.status = 'blocked'
          entry.retryAt = now + this.budgetRetryMs
          entry.blockedReason = `budget ${level}`
          this.wakeQueue.upsert(entry)
          budgetBlocked.push(entry.id)
        }
        this.publishEvent('fleet/budget-escalate', {
          agentId: group.agentId,
          level,
          entryIds: group.entries.map(entry => entry.id),
        })
        continue
      }

      const target = this.resolveAgent(group.agentId)
      if (target === undefined) {
        this.ctx.logger.debug(
          `fleet-supervisor: no live delivery target for wake of "${group.agentId}"; entries stay pending`,
        )
        continue
      }

      const skills = await this.loadSkills(group.entries)
      const workspace = this.resolveWorkspace(group.agentId)
      const message = createUserMessage({
        content: [{ type: 'text', text: this.buildWakePrompt(group.agentId, group.entries, workspace, skills.rendered) }],
        source: { kind: 'plugin', plugin: 'hydra/dsh-fleet' },
      })
      target.followup(message)

      for (const entry of group.entries) {
        entry.status = 'woken'
        entry.wokenAt = now
        entry.attempt = (entry.attempt ?? 0) + 1
        this.wakeQueue.upsert(entry)
        this.activeWakes.set(entry.id, { entryId: entry.id, agentId: group.agentId, wokeAt: now })
      }
      this.claimWakeSeam(group.agentId, group.entries)
      agentsWoken.push(group.agentId)
      wokenEntries.push(...group.entries.map(entry => entry.id))

      // The wake event carries a trigger-state fingerprint so a fleet-bus
      // subscriber with dedupeMs can suppress identical re-wakes (#28 reuse).
      const fingerprint = computeFingerprint({
        agentId: group.agentId,
        triggers: group.entries.map(entry => ({ kind: entry.kind, context: entry.context })),
      })
      this.publishEvent('fleet/wake', {
        agentId: group.agentId,
        entryIds: group.entries.map(entry => entry.id),
        kinds: [...new Set(group.entries.map(entry => entry.kind))],
        ...(workspace !== undefined ? { workspace } : {}),
        ...(skills.names.length > 0 ? { skills: skills.names } : {}),
      }, fingerprint)
    }
    return { agentsWoken, wokenEntries, budgetBlocked }
  }

  // ---- takeover (stalled agent) ----

  /**
   * A stalled agent's pending/woken wake entries are re-due'd to its successor
   * (or to itself when no successor resolves) and a `fleet/takeover` event is
   * published. Stall state is read from the optional `ctx.fleet` registry.
   */
  private takeoverScan(now: number): string[] {
    const fleet = this.ctx.get('fleet') as FleetLike | undefined
    if (fleet === undefined) return []
    const takenOver: string[] = []
    // One entry may be taken over at most once per pass: after a stalled
    // agent's entries are re-due'd to a successor that is ITSELF stalled in
    // the same scan, the successor's iteration must not re-process them.
    const seen = new Set<string>()
    for (const agent of fleet.list()) {
      if (agent.status !== 'stalled') continue
      const entries = this.wakeQueue.list().filter(entry =>
        entry.targetAgentId === agent.id
        && (entry.status === 'pending' || entry.status === 'woken')
        && !seen.has(entry.id))
      if (entries.length === 0) continue
      const successor = this.successorFor?.(agent.id) ?? agent.id
      const entryIds = entries.map(entry => entry.id)
      for (const entry of entries) {
        seen.add(entry.id)
        entry.targetAgentId = successor
        entry.dueAt = now
        entry.attempt = (entry.attempt ?? 0) + 1
        this.wakeQueue.upsert(entry)
        this.activeWakes.delete(entry.id)
      }
      this.publishEvent('fleet/takeover', {
        fromAgentId: agent.id,
        toAgentId: successor,
        entryIds,
        reason: 'stalled',
      })
      takenOver.push(...entryIds)
    }
    return takenOver
  }

  // ---- orphan recovery ----

  /**
   * A woken run that died without task-state change (no completion marker AND
   * no heartbeat progress past its wake time) within the orphan window is
   * re-due'd and re-woken; `fleet/orphan` is published.
   */
  private orphanScan(now: number): string[] {
    const fleet = this.ctx.get('fleet') as FleetLike | undefined
    const orphans: string[] = []
    for (const [entryId, record] of [...this.activeWakes]) {
      if (now - record.wokeAt <= this.orphanThresholdMs) continue
      const entry = this.wakeQueue.get(entryId)
      if (entry === undefined) {
        this.activeWakes.delete(entryId)
        continue
      }
      // Progress = the agent heartbeated past the wake time → the run is alive.
      const agent = fleet?.getStatus(record.agentId)
      if (agent !== undefined && agent.lastSeen > record.wokeAt) {
        this.activeWakes.delete(entryId)
        continue
      }
      entry.status = 'pending'
      entry.dueAt = now
      entry.attempt = (entry.attempt ?? 0) + 1
      this.wakeQueue.upsert(entry)
      this.publishEvent('fleet/orphan', {
        agentId: record.agentId,
        entryId,
        sinceTs: record.wokeAt,
        reason: 'no completion within window',
      })
      this.activeWakes.delete(entryId)
      orphans.push(entryId)
    }
    return orphans
  }

  // ---- silent active-run watchdog (#28) ----

  /**
   * An ACTIVE agent (heartbeating → alive) that has produced no bus event
   * activity for `silentThresholdMs` is flagged `fleet/silent-run`. Distinct
   * from the heartbeat liveness stall: this is running-but-silent. Rate-limited
   * by `silentResendMs` so a long silence does not storm the bus.
   */
  private silentScan(now: number): string[] {
    const fleet = this.ctx.get('fleet') as FleetLike | undefined
    if (fleet === undefined) return []
    const silent: string[] = []
    for (const agent of fleet.list()) {
      if (agent.status !== 'active') continue
      // Seed on first sight: silence is measured from when the supervisor first
      // saw the agent, so freshly-registered agents are not instantly silent.
      if (!this.lastActivity.has(agent.id)) this.lastActivity.set(agent.id, now)
      const lastAct = this.lastActivity.get(agent.id)!
      const silentMs = now - lastAct
      if (silentMs <= this.silentThresholdMs) continue
      if (now - (this.lastSilentNotified.get(agent.id) ?? 0) < this.silentResendMs) continue
      this.lastSilentNotified.set(agent.id, now)
      this.publishEvent('fleet/silent-run', {
        agentId: agent.id,
        silentMs,
        thresholdMs: this.silentThresholdMs,
      })
      silent.push(agent.id)
    }
    return silent
  }

  // ---- digest ----

  /** Emit a digest only when the interval has elapsed since the last one. */
  private digestCheck(now: number): boolean {
    if (now - this.lastDigest < this.digestIntervalMs) return false
    this.emitDigest(now)
    return true
  }

  // ---- delivery seams ----

  private lookupLiveAgent(agentId: string): FleetSupervisorDeliveryTarget | undefined {
    const agents = this.ctx.get('agents') as AgentRegistryLike | undefined
    return agents?.get(agentId)
  }

  /** Workspace resolution: `ctx.fleet` agent meta `cwd` (family convention). */
  private resolveWorkspace(agentId: string): string | undefined {
    const fleet = this.ctx.get('fleet') as FleetLike | undefined
    const entry = fleet?.getStatus(agentId)
    const cwd = entry?.meta?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  }

  /** Skill loading: inject the rendered content of each requested skill. */
  private async loadSkills(entries: WakeEntry[]): Promise<{ names: string[]; rendered: string }> {
    const skills = this.ctx.get('skills') as SkillRegistryLike | undefined
    if (skills === undefined || typeof skills.get !== 'function') return { names: [], rendered: '' }
    const names = [...new Set(entries.flatMap(entry => entry.skillNames ?? []))]
    const rendered: string[] = []
    for (const name of names) {
      const skill = await skills.get(name)
      if (skill !== undefined) rendered.push(renderSkillContent(skill))
      else this.ctx.logger.debug(`fleet-supervisor: skill "${name}" not found; skipped`)
    }
    return { names, rendered: rendered.join('\n\n') }
  }

  /** The claim handoff seam: task-claim wakes route into `ctx.fleetTasks`. */
  private claimWakeSeam(agentId: string, entries: WakeEntry[]): void {
    const tasks = this.ctx.get('fleetTasks') as FleetTasksLike | undefined
    if (tasks === undefined || typeof tasks.claimWake !== 'function') return
    for (const entry of entries) {
      if (entry.kind !== TASK_CLAIM_KIND) continue
      try {
        // The sibling's FleetTaskWakeEntry contract: { kind, agentId, dueAt?, taskId? }.
        tasks.claimWake(agentId, {
          kind: entry.kind,
          agentId: entry.targetAgentId,
          ...(entry.dueAt !== undefined ? { dueAt: entry.dueAt } : {}),
          ...(extractTaskId(entry.context) !== undefined ? { taskId: extractTaskId(entry.context) } : {}),
        })
      } catch (error) {
        this.ctx.logger.warn(
          `fleet-supervisor: fleetTasks.claimWake failed — ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  private buildWakePrompt(agentId: string, entries: WakeEntry[], workspace: string | undefined, skillsRendered: string): string {
    const lines: string[] = ['[fleet-supervisor wake] You have due fleet work.', '', 'Due entries:']
    for (const entry of entries) {
      lines.push(`- #${entry.id} [${entry.kind}] ${JSON.stringify(entry.context)}`)
    }
    if (workspace !== undefined) lines.push('', `Workspace: ${workspace}`)
    if (skillsRendered.length > 0) lines.push('', 'Skills for this work:', skillsRendered)
    const claimLine = this.ctx.get('fleetTasks') === undefined
      ? 'Claim the waiting work with the task_claim tool (the fleet-tasks plugin is not mounted in this supervisor).'
      : 'Claim the waiting work through the fleet-tasks claim API (claimWake for the entries above).'
    lines.push('', claimLine)
    return lines.join('\n')
  }

  // ---- event publishing (originKind 'supervisor', signed, fingerprinted) ----

  /**
   * Publish a supervisor event on the fleet-bus (when composed), with
   * `originKind: 'supervisor'` (so nothing supervisor-produced can self-trigger
   * a supervisor subscriber) and, when a `supervisor` identity profile exists,
   * an ed25519 signature embedded in the payload. Best-effort: a bus or
   * identity that is absent degrades to a debug log / unsigned event.
   */
  private publishEvent(type: string, payload: Record<string, JsonValue | undefined>, fingerprint?: string): void {
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus === undefined) {
      this.ctx.logger.debug(`fleet-supervisor: no fleet-bus composed; ${type} not published`)
      return
    }
    const cleanPayload: Record<string, JsonValue> = Object.fromEntries(
      Object.entries(payload).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
    )
    let body: JsonValue = cleanPayload
    const identity = this.ctx.get('fleetAgent') as FleetAgentLike | undefined
    if (identity !== undefined && typeof identity.sign === 'function') {
      try {
        const signed = identity.sign({ type, actor: SUPERVISOR_ACTOR, payload: cleanPayload, ts: this.clock.now() })
        body = { ...cleanPayload, sig: signed.sig, pubkey: signed.pubkey }
      } catch (error) {
        this.ctx.logger.debug(
          `fleet-supervisor: signing ${type} skipped — ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    bus.publish({
      type,
      scope: 'fleet',
      actor: SUPERVISOR_ACTOR,
      originKind: SUPERVISOR_ORIGIN_KIND,
      payload: body,
      ...(fingerprint !== undefined ? { fingerprint } : {}),
    })
  }
}

/** Coalesce due entries into one group per target agent (one wake per tick). */
function groupByAgent(entries: WakeEntry[]): WakeGroup[] {
  const groups = new Map<string, WakeGroup>()
  for (const entry of entries) {
    const existing = groups.get(entry.targetAgentId)
    if (existing === undefined) groups.set(entry.targetAgentId, { agentId: entry.targetAgentId, entries: [entry] })
    else existing.entries.push(entry)
  }
  return [...groups.values()]
}

/** A task id from a task-claim wake context (`taskId` or `task` field). */
function extractTaskId(context: JsonValue): string | undefined {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return undefined
  const record = context as Record<string, unknown>
  if (typeof record.taskId === 'string') return record.taskId
  if (typeof record.task === 'string') return record.task
  return undefined
}
