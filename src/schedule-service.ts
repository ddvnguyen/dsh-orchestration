/**
 * ScheduleService — the `ctx.fleetSchedule` Cordis service behind the
 * fleet-schedule plugin: API-based heartbeat management.
 *
 * A schedule (heartbeat) is a prompt delivered to a target agent on a cadence
 * (`every N ms` or a 5-field cron expression, optional IANA timezone). The
 * service keeps an in-memory registry mirrored to
 * `$DSH_HOME/fleet/schedules.json` (atomic tmp+rename writes), ticks on a
 * configurable interval (default 1 s, per requirement §1), and on each tick
 * runs every *due* schedule: records a run (run history capped at the last
 * 20), delivers the prompt to the target via `ctx.fleet.sendMessage` (the
 * receiver's `onMessage` hook surfaces it as a follow-up turn — the
 * fleet-inject pattern), advances `nextRunAt`, and auto-pauses schedules whose
 * `maxRuns` is reached or `expiresAt` passed.
 *
 * Motion surface (the `fleet_heartbeat_*` tools, plugins/fleet-agent):
 * create / update / delete / pause / resume / runOnce / list / inspect /
 * getByAgent. Mutations are ownership-scoped: `update`/`delete`/`pause`/
 * `resume`/`runOnce` throw when the caller is not the schedule's target (its
 * owner). Every mutation publishes a `fleet/schedule-*` event to `ctx.fleetBus`
 * (originKind `schedule`, signed when the actor has a fleet-agent profile)
 * and emits a `fleet-schedule/event` Cordis event — both services are optional
 * (`ctx.get`), so the plugin is self-contained like fleet-tasks.
 * @module @hydra/dsh-fleet/schedule-service
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { FleetClock, ScheduleCadence, ScheduleRecord, ScheduleRunRecord, ScheduleStatus } from './types.ts'
import { systemClock } from './types.ts'
import { ScheduleStore, type ScheduleStoreConfig } from './schedule-store.ts'

/** Max run-history entries retained per schedule (requirement §1). */
export const MAX_SCHEDULE_RUN_HISTORY = 20
/** Synthetic sender identity for scheduled deliveries (fleet.sendMessage from). */
export const SCHEDULER_AGENT_ID = 'fleet-scheduler'

/** Event types the schedule service publishes to the fleet bus. */
export const FLEET_SCHEDULE_EVENT_TYPES = {
  created: 'fleet/schedule-created',
  updated: 'fleet/schedule-updated',
  deleted: 'fleet/schedule-deleted',
  paused: 'fleet/schedule-paused',
  resumed: 'fleet/schedule-resumed',
  executed: 'fleet/schedule-executed',
} as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetSchedule: ScheduleService
  }

  interface Events {
    /**
     * One fleet-schedule mutation occurred (created/updated/deleted/paused/
     * resumed/executed). Emitted synchronously after the store write and the
     * optional fleet-bus publish, so in-process observers get the schedule
     * even when no bus is composed.
     * @param info - the mutation type + the affected schedule + the actor.
     * @mode emit
     */
    'fleet-schedule/event'(info: { type: string; schedule: ScheduleRecord; actor: string }): void
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
  }): unknown
}

/** Structural fleet-agent surface for optional signing. */
export interface FleetAgentLike {
  sign(input: { type: string; actor: string; payload: unknown; ts?: number }): unknown
}

/** Structural fleet surface for delivery: sendMessage + the existence check. */
export interface FleetLike {
  getStatus(id: string): { id: string } | undefined
  ensureAgent(
    id: string,
    kind: 'dsh' | 'acp' | 'external' | 'claude-code',
    options?: { label?: string; sessionId?: string },
  ): unknown
  sendMessage(from: string, to: string, text: string): unknown
}

export interface ScheduleServiceConfig extends ScheduleStoreConfig {
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /** Tick timer cadence in ms. Default 1000 (requirement §2). */
  tickMs?: number
}

/** The caller-provided half of `create`; id/timestamps are assigned. */
export interface ScheduleCreateInput {
  /** The prompt delivered to the target agent on each run. */
  prompt: string
  /** Human label. */
  name?: string
  cadence: ScheduleCadence
  target: { type: 'agent'; agentId: string }
  /** Execute at most this many times, then auto-pause. */
  maxRuns?: number
  /** Absolute expiry (unix epoch ms); auto-pauses once now >= expiresAt. */
  expiresAt?: number
  /** Relative expiry: auto-pause after this many ms from creation. */
  expiresInMs?: number
}

/** Fields `update` may patch. A cadence change recomputes nextRunAt. */
export interface ScheduleUpdatePatch {
  /** null clears the label. */
  name?: string | null
  prompt?: string
  cadence?: ScheduleCadence
  /** null clears the run cap. */
  maxRuns?: number | null
  /** null clears the expiry. */
  expiresAt?: number | null
}

/** Result of one tick scan. */
export interface ScheduleTickResult {
  readonly executed: ScheduleRecord[]
  readonly paused: ScheduleRecord[]
}

export class ScheduleService extends Service {
  /** The in-memory registry (primary store; mirrored to disk on each mutation). */
  private readonly records = new Map<string, ScheduleRecord>()
  private readonly store: ScheduleStore
  private readonly clock: FleetClock
  private readonly tickMs: number

  constructor(ctx: Context, config: ScheduleServiceConfig = {}) {
    super(ctx, 'fleetSchedule')
    this.clock = config.clock ?? systemClock
    this.tickMs = config.tickMs ?? 1000
    this.store = new ScheduleStore({ dir: config.dir, file: config.file })
    for (const record of this.store.load()) this.records.set(record.id, record)

    // The tick timer (the fleet-heartbeat pattern, src/service.ts:87-94).
    // `timer.unref()` so an idle process can exit; effect cleanup clears it.
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          this.runTick()
        } catch (error) {
          this.ctx.logger.warn(`fleet-schedule: tick failed — ${error instanceof Error ? error.message : String(error)}`)
        }
      }, this.tickMs)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'fleet-schedule: tick timer')
  }

  // ---- reads ----

  /**
   * All schedules, or only those targeting `agentId` when given.
   * Insertion (creation) order.
   */
  list(agentId?: string): ScheduleRecord[] {
    const records = [...this.records.values()]
    return agentId === undefined ? records : records.filter(record => record.target.agentId === agentId)
  }

  /** One schedule by id (full record incl. run history). */
  inspect(id: string): ScheduleRecord | undefined {
    return this.records.get(id)
  }

  /** Schedules targeting exactly this agent (heartbeats owned by that agent). */
  getByAgent(agentId: string): ScheduleRecord[] {
    return this.list(agentId)
  }

  // ---- verbs ----

  /**
   * Create a heartbeat schedule for `target.agentId` (the owning agent). The
   * initial status is `active` and `nextRunAt` is computed from the cadence
   * at creation. `expiresInMs` and `expiresAt` are mutually exclusive;
   * `maxRuns` must be a positive integer.
   */
  create(input: ScheduleCreateInput, actor: string): ScheduleRecord {
    const prompt = input.prompt.trim()
    if (prompt.length === 0) throw new Error('fleet-schedule: prompt must be non-empty')
    if (input.target.type !== 'agent' || input.target.agentId.length === 0) {
      throw new Error('fleet-schedule: target must be { type: "agent", agentId }')
    }
    this.validateCadence(input.cadence)
    if (input.maxRuns !== undefined && input.maxRuns !== null && (!Number.isInteger(input.maxRuns) || input.maxRuns < 1)) {
      throw new Error(`fleet-schedule: maxRuns must be a positive integer, got ${String(input.maxRuns)}`)
    }
    if (input.expiresAt !== undefined && input.expiresInMs !== undefined) {
      throw new Error('fleet-schedule: expiresAt and expiresInMs are mutually exclusive')
    }

    const now = this.clock.now()
    const expiresAt = input.expiresInMs !== undefined ? now + input.expiresInMs : input.expiresAt
    if (expiresAt !== undefined && expiresAt !== null && expiresAt <= now) {
      throw new Error('fleet-schedule: expiresAt must be in the future')
    }

    const record: ScheduleRecord = {
      id: `schedule-${randomUUID().slice(0, 8)}`,
      name: input.name ?? null,
      prompt,
      cadence: input.cadence,
      target: { type: 'agent', agentId: input.target.agentId },
      status: 'active',
      createdAt: now,
      updatedAt: now,
      nextRunAt: this.computeNext(input.cadence, now),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: expiresAt ?? null,
      maxRuns: input.maxRuns ?? null,
      runCount: 0,
      runs: [],
    }
    this.records.set(record.id, record)
    this.persist()
    this.publish(FLEET_SCHEDULE_EVENT_TYPES.created, record, actor)
    return record
  }

  /**
   * Update an existing heartbeat (owner only). A cadence change recomputes
   * `nextRunAt` from now; a tighter `maxRuns`/`expiresAt` immediately
   * auto-pauses when the new limits are already exhausted/passed.
   */
  update(id: string, actor: string, patch: ScheduleUpdatePatch): ScheduleRecord {
    const existing = this.requireOwned(id, actor)
    if (patch.prompt !== undefined && patch.prompt.trim().length === 0) {
      throw new Error('fleet-schedule: prompt must be non-empty')
    }
    if (patch.cadence !== undefined) this.validateCadence(patch.cadence)
    if (patch.maxRuns !== undefined && patch.maxRuns !== null && (!Number.isInteger(patch.maxRuns) || patch.maxRuns < 1)) {
      throw new Error(`fleet-schedule: maxRuns must be a positive integer, got ${String(patch.maxRuns)}`)
    }
    if (patch.expiresAt !== undefined && patch.expiresAt !== null && patch.expiresAt <= this.clock.now()) {
      throw new Error('fleet-schedule: expiresAt must be in the future')
    }

    const now = this.clock.now()
    const cadence = patch.cadence ?? existing.cadence
    const changedCadence = patch.cadence !== undefined
    const updated: ScheduleRecord = {
      ...existing,
      name: patch.name !== undefined ? patch.name : existing.name,
      prompt: patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt,
      cadence,
      maxRuns: patch.maxRuns !== undefined ? patch.maxRuns : existing.maxRuns,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : existing.expiresAt,
      updatedAt: now,
      nextRunAt: existing.status === 'active' && changedCadence
        ? this.computeNext(cadence, now)
        : existing.nextRunAt,
    }
    this.records.set(updated.id, updated)
    this.persist()
    this.publish(FLEET_SCHEDULE_EVENT_TYPES.updated, updated, actor)
    return this.applyAutoPause(updated, now)
  }

  /** Delete a heartbeat (owner only). Returns the removed id. */
  delete(id: string, actor: string): { id: string } {
    const schedule = this.requireOwned(id, actor)
    this.records.delete(id)
    this.persist()
    this.publish(FLEET_SCHEDULE_EVENT_TYPES.deleted, schedule, actor)
    return { id: schedule.id }
  }

  /**
   * Pause a heartbeat: stops the tick scan (nextRunAt → null), keeps the
   * record + run history. Owner only.
   */
  pause(id: string, actor: string): ScheduleRecord {
    const schedule = this.requireOwned(id, actor)
    if (schedule.status !== 'active') {
      throw new Error(`fleet-schedule: schedule "${id}" is not active (${schedule.status})`)
    }
    const now = this.clock.now()
    const paused: ScheduleRecord = {
      ...schedule,
      status: 'paused',
      pausedAt: now,
      nextRunAt: null,
      updatedAt: now,
    }
    this.records.set(paused.id, paused)
    this.persist()
    this.publish(FLEET_SCHEDULE_EVENT_TYPES.paused, paused, actor)
    return paused
  }

  /**
   * Resume a paused heartbeat: back to `active`, `nextRunAt` recomputed from
   * now. Owner only. (`completed` is reserved for terminal schedules — the
   * reference lifecycle vocabulary — and is not resumable in v0.1.)
   */
  resume(id: string, actor: string): ScheduleRecord {
    const schedule = this.requireOwned(id, actor)
    if (schedule.status !== 'paused') {
      throw new Error(`fleet-schedule: only a paused schedule can be resumed (${id} is ${schedule.status})`)
    }
    const now = this.clock.now()
    const resumed: ScheduleRecord = {
      ...schedule,
      status: 'active',
      pausedAt: null,
      nextRunAt: this.computeNext(schedule.cadence, now),
      updatedAt: now,
    }
    this.records.set(resumed.id, resumed)
    this.persist()
    this.publish(FLEET_SCHEDULE_EVENT_TYPES.resumed, resumed, actor)
    return resumed
  }

  /**
   * Execute a heartbeat immediately (manual trigger). Records a run,
   * delivers the prompt, and leaves the normal cadence (`nextRunAt`)
   * untouched. Refuses when the schedule is paused or auto-pause conditions
   * (expiry / maxRuns) already apply. Owner only.
   */
  runOnce(id: string, actor: string): ScheduleRecord {
    const schedule = this.requireOwned(id, actor)
    const now = this.clock.now()
    if (schedule.status !== 'active') {
      throw new Error(`fleet-schedule: cannot run "${id}" manually — schedule is ${schedule.status}`)
    }
    const check = this.autoPauseTarget(schedule, now)
    if (check.pause) {
      throw new Error(`fleet-schedule: cannot run "${id}" manually — ${check.reason}`)
    }
    return this.execute(schedule, now, 'manual')
  }

  // ---- the tick ----

  /**
   * One tick scan (public so tests drive it deterministically; the timer
   * calls it every tickMs). For each schedule:
   *  1. auto-pause when expiresAt passed or maxRuns reached (no run),
   *  2. otherwise, when `nextRunAt <= now`, execute (record run + deliver).
   * The scan is deliberately lightweight: a cheap `nextRunAt <= now` check.
   */
  runTick(now: number = this.clock.now()): ScheduleTickResult {
    const executed: ScheduleRecord[] = []
    const paused: ScheduleRecord[] = []
    for (const schedule of this.list()) {
      const auto = this.autoPauseTarget(schedule, now)
      if (auto.pause) {
        paused.push(this.applyAutoPause(schedule, now, auto.reason))
        continue
      }
      if (schedule.status === 'active' && schedule.nextRunAt !== null && schedule.nextRunAt <= now) {
        executed.push(this.execute(schedule, now, 'tick'))
      }
    }
    return { executed, paused }
  }

  // ---- internals ----

  /** Execute one due schedule: record the run, deliver, advance nextRunAt. */
  private execute(schedule: ScheduleRecord, now: number, trigger: 'tick' | 'manual'): ScheduleRecord {
    const run: ScheduleRunRecord = {
      id: `run-${randomUUID().slice(0, 8)}`,
      scheduledFor: schedule.nextRunAt ?? now,
      startedAt: now,
      status: 'running',
      agentId: schedule.target.agentId,
      error: null,
    }

    const fleet = this.ctx.get('fleet') as FleetLike | undefined
    const targetRegistered = fleet?.getStatus(schedule.target.agentId) !== undefined
    if (fleet === undefined || targetRegistered === false) {
      // Requirement: target must exist in the fleet registry — warn and skip.
      run.status = 'failed'
      run.error = fleet === undefined
        ? 'fleet service not composed; cannot deliver to the target agent'
        : `target agent "${schedule.target.agentId}" is not registered in the fleet registry`
      this.ctx.logger.warn(`fleet-schedule: ${run.error} (schedule "${schedule.id}")`)
    } else {
      try {
        // The synthetic sender must be registered before sendMessage.
        fleet.ensureAgent(SCHEDULER_AGENT_ID, 'external', { label: 'fleet scheduler' })
        fleet.sendMessage(SCHEDULER_AGENT_ID, schedule.target.agentId, schedule.prompt)
        run.status = 'succeeded'
      } catch (error) {
        run.status = 'failed'
        run.error = error instanceof Error ? error.message : String(error)
      }
    }

    const executed: ScheduleRecord = {
      ...schedule,
      runCount: schedule.runCount + 1,
      runs: [...schedule.runs, run].slice(-MAX_SCHEDULE_RUN_HISTORY),
      lastRunAt: now,
      updatedAt: now,
      // Manual runs leave the normal cadence untouched; tick runs advance it
      // strictly beyond the run so a slow tick can never re-trigger the same
      // occurrence (no catch-up storm).
      nextRunAt: trigger === 'manual' ? schedule.nextRunAt : this.computeNext(schedule.cadence, now),
    }
    this.records.set(executed.id, executed)
    this.persist()
    this.publish(FLEET_SCHEDULE_EVENT_TYPES.executed, executed, SCHEDULER_AGENT_ID, {
      trigger,
      run: { id: run.id, status: run.status, error: run.error },
    })
    // A final run may have exhausted maxRuns — auto-pause after recording it.
    this.applyAutoPause(executed, now)
    return this.records.get(executed.id)!
  }

  /** Auto-pause predicate: expiry passed or maxRuns reached. */
  private autoPauseTarget(schedule: ScheduleRecord, now: number): { pause: boolean; reason: string } {
    if (schedule.status !== 'active') return { pause: false, reason: '' }
    if (schedule.expiresAt !== null && now >= schedule.expiresAt) {
      return { pause: true, reason: `expiresAt ${schedule.expiresAt} passed` }
    }
    if (schedule.maxRuns !== null && schedule.runCount >= schedule.maxRuns) {
      return { pause: true, reason: `maxRuns ${schedule.maxRuns} reached` }
    }
    return { pause: false, reason: '' }
  }

  /** Transition a schedule to `paused` (persist + publish) and return it. */
  private applyAutoPause(schedule: ScheduleRecord, now: number, reason?: string): ScheduleRecord {
    const target = reason !== undefined ? { pause: true, reason } : this.autoPauseTarget(schedule, now)
    if (!target.pause || schedule.status !== 'active') return schedule
    const paused: ScheduleRecord = {
      ...schedule,
      status: 'paused',
      pausedAt: now,
      nextRunAt: null,
      updatedAt: now,
    }
    this.records.set(paused.id, paused)
    this.persist()
    this.ctx.logger.warn(`fleet-schedule: schedule "${paused.id}" auto-paused — ${target.reason}`)
    this.publish(FLEET_SCHEDULE_EVENT_TYPES.paused, paused, SCHEDULER_AGENT_ID, {
      auto: true,
      reason: target.reason,
    })
    return paused
  }

  /** Read a schedule and require the caller to be its target (owner). */
  private requireOwned(id: string, actor: string): ScheduleRecord {
    const schedule = this.records.get(id)
    if (schedule === undefined) throw new Error(`fleet-schedule: schedule "${id}" not found`)
    if (schedule.target.agentId !== actor) {
      throw new Error(`fleet-schedule: schedule "${id}" belongs to "${schedule.target.agentId}", not "${actor}"`)
    }
    return schedule
  }

  /** Mirror the in-memory registry to disk (atomic write). */
  private persist(): void {
    this.store.save([...this.records.values()])
  }

  /** Publish a fleet-schedule event to the bus (when composed) + emit locally. */
  private publish(type: string, schedule: ScheduleRecord, actor: string, extra: Record<string, JsonValue> = {}): void {
    const payload: Record<string, JsonValue> = {
      schedule: scheduleToJson(schedule),
      ...extra,
    }
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus?.publish === undefined) {
      this.ctx.logger.debug(`fleet-schedule: no fleet-bus composed; not publishing ${type}`)
    } else {
      const identity = this.ctx.get('fleetAgent') as FleetAgentLike | undefined
      let signed: JsonValue | undefined
      if (identity?.sign !== undefined) {
        try {
          signed = identity.sign({ type, actor, payload }) as JsonValue
        } catch (error) {
          this.ctx.logger.debug(`fleet-schedule: unsigned event (actor "${actor}" has no identity profile): ${String(error)}`)
        }
      }
      bus.publish({
        type,
        scope: 'fleet',
        actor,
        originKind: 'schedule',
        payload: signed !== undefined ? { ...payload, signed } : payload,
      })
    }
    this.ctx.emit('fleet-schedule/event', { type, schedule, actor })
  }

  // ---- cadence math ----
  // 'every' cadences: next = after + everyMs. Cron cadences: next occurrence
  // strictly after `after` — 5-field arithmetic scan (UTC) when no timezone
  // is set, or a timezone-aware day/hour/minute scan via Intl when one is.
  // Implemented here (simple 5-field parser) rather than importing
  // cron-parser: the prototype family's zero-new-deps rule (see
  // plugins/fleet-tasks/src/store.ts) and the requirement's explicit
  // "or implement simple 5-field parser" option.

  private computeNext(cadence: ScheduleCadence, after: number): number {
    if (cadence.type === 'every') {
      if (!Number.isInteger(cadence.everyMs) || cadence.everyMs < 1) {
        throw new Error(`fleet-schedule: everyMs must be a positive integer, got ${String(cadence.everyMs)}`)
      }
      return after + cadence.everyMs
    }
    return nextCronAfter(cadence.expression, cadence.timezone, after)
  }

  private validateCadence(cadence: ScheduleCadence): void {
    if (cadence.type === 'every') {
      if (!Number.isInteger(cadence.everyMs) || cadence.everyMs < 1) {
        throw new Error(`fleet-schedule: every everyMs must be a positive integer, got ${String(cadence.everyMs)}`)
      }
      return
    }
    try {
      parseCronExpression(cadence.expression)
      if (cadence.timezone !== undefined) validateTimezone(cadence.timezone)
    } catch (error) {
      throw new Error(`fleet-schedule: invalid cron cadence — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Simple 5-field cron parser + next-occurrence computation.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const CRON_SCAN_CAP = 5 * 366 * DAY_MS // next occurrence must be within 5 years

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  /** true when the field is exactly '*' (the OR-rule base case). */
  domWild: boolean
  dowWild: boolean
}

/** Parse a 5-field cron expression into value sets. Throws on invalid input. */
export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expression}"`)
  }
  const [minuteField, hourField, domField, monthField, dowField] = fields
  if (minuteField === undefined || hourField === undefined || domField === undefined || monthField === undefined || dowField === undefined) {
    throw new Error(`invalid cron expression: "${expression}"`)
  }
  const minutes = parseCronField(minuteField, 0, 59)
  const hours = parseCronField(hourField, 0, 23)
  const daysOfMonth = parseCronField(domField, 1, 31)
  const months = parseCronField(monthField, 1, 12, MONTH_NAMES)
  const rawDows = parseCronField(dowField, 0, 7, DAY_NAMES)
  const daysOfWeek = new Set<number>()
  for (const value of rawDows) daysOfWeek.add(value === 7 ? 0 : value) // 7 = Sunday
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domWild: domField.trim() === '*',
    dowWild: dowField.trim() === '*',
  }
}

/** Parse one cron field: `*`, lists, ranges, steps, and names. */
function parseCronField(field: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const values = new Set<number>()
  for (const raw of field.split(',')) {
    const text = raw.trim()
    if (text.length === 0) throw new Error(`empty segment in cron field "${field}"`)
    let base = text
    let step = 1
    const slash = text.indexOf('/')
    if (slash !== -1) {
      base = text.slice(0, slash).trim()
      const stepText = text.slice(slash + 1).trim()
      step = Number.parseInt(stepText, 10)
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step "${stepText}" in "${field}"`)
    }
    let lo: number
    let hi: number
    const dash = base.indexOf('-')
    if (dash !== -1) {
      lo = parseCronValue(base.slice(0, dash).trim(), names, min, max, field)
      hi = parseCronValue(base.slice(dash + 1).trim(), names, min, max, field)
      if (lo > hi) throw new Error(`reversed range "${base}" in "${field}"`)
    } else if (base === '*') {
      lo = min
      hi = max
    } else {
      lo = parseCronValue(base, names, min, max, field)
      hi = lo
    }
    for (let value = lo; value <= hi; value += step) values.add(value)
  }
  return values
}

/** Parse one cron value: a 3-letter name, or an integer within [min, max]. */
function parseCronValue(text: string, names: Record<string, number> | undefined, min: number, max: number, context: string): number {
  const lowered = text.toLowerCase()
  if (names !== undefined && /^[a-z]{3}$/.test(lowered) && names[lowered] !== undefined) {
    const named = names[lowered]!
    if (named < min || named > max) throw new Error(`name "${text}" out of range in "${context}"`)
    return named
  }
  const value = Number.parseInt(text, 10)
  if (Number.isNaN(value)) throw new Error(`cannot parse "${text}" in cron field "${context}"`)
  if (value < min || value > max) throw new Error(`value ${value} out of range ${min}-${max} in "${context}"`)
  return value
}

/**
 * Day-of-month / day-of-week OR rule (Vixie cron): when BOTH fields are
 * restricted (not exactly '*'), the day matches when EITHER matches; when one
 * is restricted, it governs.
 */
function dayMatches(cron: ParsedCron, dom: number, dow: number): boolean {
  if (cron.domWild && cron.dowWild) return true
  if (cron.domWild) return cron.daysOfWeek.has(dow)
  if (cron.dowWild) return cron.daysOfMonth.has(dom)
  return cron.daysOfMonth.has(dom) || cron.daysOfWeek.has(dow)
}

/** Next occurrence strictly after `after` (epoch ms), timezone-aware. */
export function nextCronAfter(expression: string, timezone: string | undefined, after: number): number {
  const cron = parseCronExpression(expression)
  return timezone === undefined
    ? nextCronArithmetic(cron, after)
    : nextCronInTimezone(cron, timezone, after)
}

/** Fast arithmetic scan (UTC wall clock). Jumps by day/hour/minute granularity. */
function nextCronArithmetic(cron: ParsedCron, after: number): number {
  let t = Math.ceil((after + 1) / MINUTE_MS) * MINUTE_MS // next whole minute strictly after
  const cap = t + CRON_SCAN_CAP
  while (t < cap) {
    const date = new Date(t)
    const minute = date.getUTCMinutes()
    const hour = date.getUTCHours()
    const dom = date.getUTCDate()
    const month = date.getUTCMonth() + 1
    const dow = date.getUTCDay()
    if (cron.months.has(month) && dayMatches(cron, dom, dow) && cron.hours.has(hour) && cron.minutes.has(minute)) {
      return t
    }
    if (!cron.months.has(month) || !dayMatches(cron, dom, dow)) {
      t = Math.ceil((t + 1) / DAY_MS) * DAY_MS // next UTC day
    } else if (!cron.hours.has(hour)) {
      t = Math.ceil((t + 1) / HOUR_MS) * HOUR_MS // next UTC hour
    } else {
      t += MINUTE_MS
    }
  }
  throw new Error(`no cron occurrence within 5 years: "${expressionOf(cron)}"`)
}

/** Timezone-aware scan: day-by-day in the target zone, then hour/minute within a matching day. */
function nextCronInTimezone(cron: ParsedCron, timezone: string, after: number): number {
  validateTimezone(timezone)
  const cap = after + CRON_SCAN_CAP
  let dayStart = startOfTzDay(after + 1, timezone)
  let guard = 0
  while (dayStart < cap && guard++ < 1900) {
    const date = formatParts(dayStart, timezone)
    if (cron.months.has(date.m) && dayMatches(cron, date.d, weekdayOfWallDate(date.y, date.m, date.d))) {
      for (const hour of sortedValues(cron.hours)) {
        for (const minute of sortedValues(cron.minutes)) {
          const candidate = wallToEpoch(date.y, date.m, date.d, hour, minute, timezone, dayStart)
          if (candidate > after && candidate < cap) return candidate
        }
      }
    }
    // Advance one WALL day (robust across DST length changes).
    dayStart = wallToEpoch(date.y, date.m, date.d + 1, 0, 0, timezone, dayStart + 1)
  }
  throw new Error(`no cron occurrence within 5 years in timezone "${timezone}": "${expressionOf(cron)}"`)
}

// ---- timezone helpers (Intl-based; deterministic for valid IANA zones) ----

interface TzParts { y: number; m: number; d: number; h: number; min: number }

const tzFormatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = tzFormatters.get(timezone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric',
      hour12: false,
    })
    tzFormatters.set(timezone, formatter)
  }
  return formatter
}

function formatParts(epochMs: number, timezone: string): TzParts {
  const out: Partial<TzParts> = {}
  for (const part of formatterFor(timezone).formatToParts(epochMs)) {
    switch (part.type) {
      case 'year': out.y = Number(part.value); break
      case 'month': out.m = Number(part.value); break
      case 'day': out.d = Number(part.value); break
      case 'hour': out.h = part.value === '24' ? 0 : Number(part.value); break
      case 'minute': out.min = Number(part.value); break
    }
  }
  return { y: out.y!, m: out.m!, d: out.d!, h: out.h!, min: out.min! }
}

/** The timezone's offset in ms at an instant: (wall-as-UTC) − epoch. */
function tzOffsetAt(epochMs: number, timezone: string): number {
  const p = formatParts(epochMs, timezone)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - epochMs
}

/** Epoch of local midnight of the tz day containing `epochMs`. */
function startOfTzDay(epochMs: number, timezone: string): number {
  const p = formatParts(epochMs, timezone)
  return wallToEpoch(p.y, p.m, p.d, 0, 0, timezone, epochMs)
}

/**
 * Convert a tz wall-clock time to an epoch, converging on the offset
 * (handles DST by re-probing). Returns a best-effort epoch within the hour
 * when the wall time is skipped by a spring-forward.
 */
function wallToEpoch(y: number, m: number, d: number, hour: number, minute: number, timezone: string, seed: number): number {
  let guess = Date.UTC(y, m - 1, d, hour, minute) - tzOffsetAt(seed, timezone)
  for (let i = 0; i < 3; i++) {
    const p = formatParts(guess, timezone)
    if (p.y === y && p.m === m && p.d === d && p.h === hour && p.min === minute) {
      // Intl truncates to whole minutes, so the offset is only known within
      // the minute; requested wall times are always minute-aligned and modern
      // IANA offsets are whole minutes — snap to the minute boundary.
      return guess - (guess % MINUTE_MS)
    }
    guess = Date.UTC(y, m - 1, d, hour, minute) - tzOffsetAt(guess, timezone)
  }
  return guess // best effort: DST spring-forward skipped this wall time
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new Error(`unknown timezone "${timezone}"`)
  }
}

/** Weekday (0=Sunday..6=Saturday) of a wall date — calendar math, tz-independent. */
function weekdayOfWallDate(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

function sortedValues(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b)
}

function expressionOf(cron: ParsedCron): string {
  return `min:${[...cron.minutes].join(',')} hour:${[...cron.hours].join(',')} dom:${[...cron.daysOfMonth].join(',')} month:${[...cron.months].join(',')} dow:${[...cron.daysOfWeek].join(',')}`
}

/** A JSON-safe, compact projection of a schedule for tool output and events. */
export function scheduleToJson(schedule: ScheduleRecord): JsonValue {
  const value: Record<string, JsonValue> = {
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt,
    cadence: { ...schedule.cadence } as unknown as JsonValue,
    target: { type: 'agent', agentId: schedule.target.agentId },
    status: schedule.status,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    pausedAt: schedule.pausedAt,
    expiresAt: schedule.expiresAt,
    maxRuns: schedule.maxRuns,
    runCount: schedule.runCount,
    runs: schedule.runs.map(run => ({
      id: run.id,
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      status: run.status,
      agentId: run.agentId,
      error: run.error,
    })),
  }
  return value
}
