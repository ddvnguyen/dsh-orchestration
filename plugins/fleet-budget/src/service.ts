/**
 * FleetBudgetService — the `ctx.fleetBudget` Cordis service behind the
 * fleet-budget plugin (issue #26, orchestration-v3 §4 P3.2).
 *
 * Cost tracking + scoped caps + **soft warnings + escalation** per owner
 * decision #4 (soft warnings + human escalation, NO hard blocking):
 *
 * - `setBudget(input)` upserts one budget (global / per-agent / per-task-kind),
 *   a cap measured in `tokens` or `cost` with soft/critical threshold fractions
 *   (defaults 0.8 / 1.0) and a named escalation `owner`.
 * - `recordCost(input, actor)` appends a durable cost record and accumulates
 *   spend into every affected scope (global + agent + task-kind when given).
 *   Crossing the soft threshold fires `fleet/budget-warning`; crossing the
 *   critical threshold fires `fleet/budget-escalated` (routed to the budget
 *   owner). Crossings are deduped per budget per level until the budget is
 *   reset — a budget is a soft alarm, not a tripwire.
 * - `checkWake(agentId)` is the scheduler consult seam (§4.1, the sibling
 *   supervisor's `FleetBudgetLike` at
 *   `plugins/fleet-supervisor/src/types.ts:104-110`): the worst level across
 *   the agent's own budget and the global budget. It returns
 *   `'ok' | 'warning' | 'critical'` so a soft-warning level escalates instead
 *   of waking. The supervisor itself is NOT wired here — that is a documented
 *   follow-up (fleet-supervisor stays untouched in this phase).
 *
 * Events publish to `ctx.fleetBus` (when composed) with `originKind: 'budget'`
 * and, when `ctx.fleetAgent` is composed and the actor has a profile, a
 * signed envelope embedded in the payload. Both services are optional
 * (`ctx.get`), so the plugin is self-contained.
 * @module @hydra/dsh-fleet-budget/service
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { FleetClock } from '../../../src/types.ts'
import { systemClock } from '../../../src/types.ts'
import { FleetBudgetStore, type FleetBudgetStoreConfig } from './store.ts'
import {
  fleetBudgetEffectiveSpent,
  fleetBudgetLevel,
  fleetBudgetPct,
  fleetBudgetScopeKey,
  worstFleetBudgetLevel,
  type FleetBudgetEntry,
  type FleetBudgetImpact,
  type FleetBudgetLevel,
  type FleetBudgetScope,
  type FleetBudgetSetInput,
  type FleetCostRecord,
  type FleetCostRecordInput,
  type FleetCostResult,
  type FleetBudgetStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetBudget: FleetBudgetService
  }

  interface Events {
    /**
     * One budget threshold crossing (warning/escalated) occurred. Emitted
     * synchronously after the store write and the optional fleet-bus publish,
     * so in-process observers get the crossing even when no bus is composed.
     * @param info - the event type + level + the budget that crossed + the acting agent.
     * @mode emit
     */
    'fleet-budget/event'(info: { type: string; level: FleetBudgetLevel; budget: FleetBudgetEntry; actor: string }): void
  }
}

/** The event types fleet-budget publishes to the bus. */
export const FLEET_BUDGET_EVENT_TYPES = {
  warning: 'fleet/budget-warning',
  escalated: 'fleet/budget-escalated',
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

/** Structural fleet-agent surface for optional signing. */
export interface FleetAgentLike {
  sign(input: { type: string; actor: string; payload: unknown; ts?: number }): unknown
}

export interface FleetBudgetConfig extends FleetBudgetStoreConfig {
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /** Default soft threshold fraction when a budget omits it. Default 0.8. */
  softThreshold?: number
  /** Default critical threshold fraction when a budget omits it. Default 1.0. */
  criticalThreshold?: number
}

/** The scope keys a cost record lands in (agent scoped to the record). */
function scopesForRecord(agentId: string, taskKind: string | undefined): string[] {
  const keys = ['global', `agent:${agentId}`]
  if (taskKind !== undefined) keys.push(`task-kind:${taskKind}`)
  return keys
}

export class FleetBudgetService extends Service {
  readonly store: FleetBudgetStore
  private readonly clock: FleetClock
  private readonly defaultSoftThreshold: number
  private readonly defaultCriticalThreshold: number

  constructor(ctx: Context, config: FleetBudgetConfig = {}) {
    super(ctx, 'fleetBudget')
    this.clock = config.clock ?? systemClock
    this.defaultSoftThreshold = config.softThreshold ?? 0.8
    this.defaultCriticalThreshold = config.criticalThreshold ?? 1.0
    this.store = new FleetBudgetStore({ dir: config.dir, file: config.file })
  }

  // ---- reads ----

  /** All budgets, creation order. */
  list(): FleetBudgetEntry[] {
    return this.store.listBudgets()
  }

  /** One budget by scope key; `undefined` when absent. */
  get(scopeKey: string): FleetBudgetEntry | undefined {
    return this.store.getBudget(scopeKey)
  }

  /**
   * The budget status view: budgets matching the filter (global + the agent's
   * budget when `agentId` is given, + the task-kind budget when `taskKind` is
   * given; all budgets when neither) with per-scope levels, the worst level,
   * and fleet-wide totals.
   */
  status(filter: { agentId?: string; taskKind?: string } = {}): FleetBudgetStatus {
    const budgets = this.list().filter(budget => {
      // The global budget always matches; per-scope budgets only match when
      // their dimension is requested (an agentId filter does not pull in
      // task-kind budgets, and vice versa).
      if (budget.scope.kind === 'global') return true
      if (budget.scope.kind === 'agent') {
        return filter.agentId !== undefined && budget.scope.agentId === filter.agentId
      }
      return filter.taskKind !== undefined && budget.scope.taskKind === filter.taskKind
    })
    const levels: Record<string, FleetBudgetLevel> = {}
    let worst: FleetBudgetLevel = 'ok'
    for (const budget of budgets) {
      const key = fleetBudgetScopeKey(budget.scope)
      const level = fleetBudgetLevel(budget, fleetBudgetPct(budget))
      levels[key] = level
      worst = worstFleetBudgetLevel(worst, level)
    }
    return { levels, worst, budgets, totals: this.store.totals() }
  }

  // ---- verbs ----

  /**
   * Upsert a budget for a scope. An existing budget keeps its accumulated
   * spend; only the cap/unit/thresholds/owner are updated. A new budget starts
   * at zero spend.
   */
  setBudget(input: FleetBudgetSetInput, actor: string): FleetBudgetEntry {
    if (!(input.cap > 0)) throw new Error('fleet-budget: cap must be a positive number')
    const unit = input.unit ?? 'tokens'
    if (unit !== 'tokens' && unit !== 'cost') throw new Error('fleet-budget: unit must be "tokens" or "cost"')
    const softThreshold = input.softThreshold ?? this.defaultSoftThreshold
    const criticalThreshold = input.criticalThreshold ?? this.defaultCriticalThreshold
    if (!(softThreshold > 0) || !(criticalThreshold > 0)) {
      throw new Error('fleet-budget: thresholds must be positive fractions of the cap')
    }
    if (criticalThreshold < softThreshold) {
      throw new Error('fleet-budget: criticalThreshold must be >= softThreshold')
    }

    const scopeKey = fleetBudgetScopeKey(input.scope)
    const existing = this.store.getBudget(scopeKey)
    const now = this.clock.now()
    const budget: FleetBudgetEntry = existing !== undefined
      ? {
          ...existing,
          cap: input.cap,
          unit,
          softThreshold,
          criticalThreshold,
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          updatedAt: now,
        }
      : {
          id: `budget-${randomUUID().slice(0, 8)}`,
          scope: input.scope,
          cap: input.cap,
          unit,
          softThreshold,
          criticalThreshold,
          spentTokens: 0,
          spentCost: 0,
          warningEmitted: false,
          escalatedEmitted: false,
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          createdAt: now,
          updatedAt: now,
        }
    this.store.putBudget(budget)
    return budget
  }

  /**
   * Record one cost input. Appends a durable ledger record and accumulates its
   * tokens/cost into every affected budget (global + `agent:<id>` +
   * `task-kind:<kind>` when given), then evaluates threshold crossings:
   *
   * - reaching `softThreshold` fires `fleet/budget-warning` (once per budget
   *   per level, until reset);
   * - reaching `criticalThreshold` fires `fleet/budget-escalated` with the
   *   budget owner + next action (owner decision #4 — a soft alarm, NOT a hard
   *   stop; the record is always applied).
   *
   * @returns the ledger record + every impacted budget with its level/pct.
   */
  recordCost(input: FleetCostRecordInput, actor: string): FleetCostResult {
    if (input.agentId.trim().length === 0) throw new Error('fleet-budget: recordCost requires a non-empty agentId')
    const tokens = input.tokens ?? 0
    const cost = input.cost ?? 0
    if (tokens < 0 || cost < 0) throw new Error('fleet-budget: tokens/cost must be non-negative')

    const now = this.clock.now()
    const record: FleetCostRecord = {
      id: `cost-${randomUUID().slice(0, 8)}`,
      agentId: input.agentId,
      ...(input.taskKind !== undefined ? { taskKind: input.taskKind } : {}),
      tokens,
      cost,
      ts: now,
    }
    this.store.appendCost(record)

    const impacted: FleetBudgetImpact[] = []
    for (const scopeKey of scopesForRecord(input.agentId, input.taskKind)) {
      const budget = this.store.getBudget(scopeKey)
      if (budget === undefined) continue
      impacted.push(this.accumulate(budget, tokens, cost, now, actor))
    }
    return { record, impacted }
  }

  /**
   * Reset a budget's spend to zero and clear its crossing flags, so a
   * recovered budget can warn/escalate again (owner decision #4: a soft
   * warning is not sticky forever).
   */
  reset(scopeKey: string, actor: string): FleetBudgetEntry | undefined {
    const budget = this.store.getBudget(scopeKey)
    if (budget === undefined) return undefined
    const reset: FleetBudgetEntry = {
      ...budget,
      spentTokens: 0,
      spentCost: 0,
      warningEmitted: false,
      escalatedEmitted: false,
      updatedAt: this.clock.now(),
    }
    this.store.putBudget(reset)
    this.ctx.logger.debug(`fleet-budget: ${scopeKey} reset by ${actor}`)
    return reset
  }

  /**
   * THE SCHEDULER CONSULT SEAM (§4.1: "before waking, consult fleet-budget
   * threshold"). The worst level across the agent's own budget and the global
   * budget — a soft-warning level escalates instead of waking. Satisfies the
   * sibling supervisor's structural `FleetBudgetLike`:
   * `checkWake(agentId): 'ok' | 'warning' | 'critical'`.
   * (Task-kind budgets are not consultable from a wake — the wake does not
   * name a task kind yet; see the follow-up in the state doc.)
   */
  checkWake(agentId: string): FleetBudgetLevel {
    let worst: FleetBudgetLevel = 'ok'
    for (const scopeKey of ['global', `agent:${agentId}`]) {
      const budget = this.store.getBudget(scopeKey)
      if (budget === undefined) continue
      worst = worstFleetBudgetLevel(worst, fleetBudgetLevel(budget, fleetBudgetPct(budget)))
    }
    return worst
  }

  // ---- internals ----

  /** Accumulate a record into one budget, evaluate + emit crossings. */
  private accumulate(budget: FleetBudgetEntry, tokens: number, cost: number, now: number, actor: string): FleetBudgetImpact {
    const prevSpent = fleetBudgetEffectiveSpent(budget)
    const prevPct = budget.cap > 0 ? prevSpent / budget.cap : 0
    const prevLevel = fleetBudgetLevel(budget, prevPct)

    const next: FleetBudgetEntry = {
      ...budget,
      spentTokens: budget.spentTokens + tokens,
      spentCost: budget.spentCost + cost,
      updatedAt: now,
    }
    const pct = fleetBudgetPct(next)
    const level = fleetBudgetLevel(next, pct)

    let crossed: FleetBudgetImpact['crossed'] = 'none'
    const warningCrossed = !next.warningEmitted && prevLevel !== 'warning' && prevLevel !== 'critical' && pct >= next.softThreshold
    const criticalCrossed = !next.escalatedEmitted && prevLevel !== 'critical' && pct >= next.criticalThreshold
    if (criticalCrossed) crossed = 'critical'
    else if (warningCrossed) crossed = 'warning'
    if (warningCrossed) next.warningEmitted = true
    if (criticalCrossed) next.escalatedEmitted = true

    this.store.putBudget(next)

    if (criticalCrossed) {
      this.publish(FLEET_BUDGET_EVENT_TYPES.escalated, next, 'critical', actor, {
        agentId: actor,
        ...(next.owner !== undefined ? { owner: next.owner } : {}),
        nextAction: 'human/lead review the budget before the fleet does more paid work',
        pct,
        spent: fleetBudgetEffectiveSpent(next),
        cap: next.cap,
      })
    } else if (warningCrossed) {
      this.publish(FLEET_BUDGET_EVENT_TYPES.warning, next, 'warning', actor, {
        agentId: actor,
        ...(next.owner !== undefined ? { owner: next.owner } : {}),
        pct,
        spent: fleetBudgetEffectiveSpent(next),
        cap: next.cap,
      })
    }

    return { budget: next, level, spent: fleetBudgetEffectiveSpent(next), pct, crossed }
  }

  /** Publish a crossing event to the bus (when composed) + emit a Cordis event. */
  private publish(type: string, budget: FleetBudgetEntry, level: FleetBudgetLevel, actor: string, extra: Record<string, JsonValue>): void {
    const payload: Record<string, JsonValue> = {
      scopeKey: fleetBudgetScopeKey(budget.scope),
      scope: budget.scope as unknown as JsonValue,
      unit: budget.unit,
      level,
      ...extra,
    }
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus?.publish === undefined) {
      this.ctx.logger.debug(`fleet-budget: no fleet-bus composed; not publishing ${type}`)
    } else {
      const identity = this.ctx.get('fleetAgent') as FleetAgentLike | undefined
      let signed: JsonValue | undefined
      if (identity?.sign !== undefined) {
        try {
          signed = identity.sign({ type, actor, payload }) as JsonValue
        } catch (error) {
          this.ctx.logger.debug(`fleet-budget: unsigned event (actor "${actor}" has no identity profile): ${String(error)}`)
        }
      }
      bus.publish({
        type,
        scope: 'fleet',
        actor,
        originKind: 'budget',
        payload: signed !== undefined ? { ...payload, signed } : payload,
      })
    }
    this.ctx.emit('fleet-budget/event', { type, level, budget, actor })
  }
}
