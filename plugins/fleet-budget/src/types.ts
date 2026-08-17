/**
 * fleet-budget vocabulary (issue #26, orchestration-v3 §4 P3.2).
 *
 * Cost tracking + scoped caps + **soft warnings + escalation** (owner decision
 * #4: budgets are soft warnings + human escalation, NOT hard blocking). A
 * budget is a cap measured in one unit (`tokens` or `cost`) scoped to the whole
 * fleet (`global`), one agent (`agent:<id>`), or one task kind
 * (`task-kind:<kind>`). Spend accumulates from cost records; each record lands
 * in every affected scope. Thresholds are fractions of the cap:
 *
 * - below `softThreshold` (default 0.8) → level `ok`
 * - at/above `softThreshold` (and below the critical threshold) → `warning`
 * - at/above `criticalThreshold` (default 1.0) → `critical`
 *
 * Crossings are emitted once per budget per crossing (deduped by flags) as
 * `fleet/budget-warning` and `fleet/budget-escalated` (the escalation carries
 * the budget `owner`, routed to the lead/owner per decision #4). The scheduler
 * consult seam (§4.1: "before waking, consult fleet-budget threshold") is the
 * {@link FleetBudgetService.checkWake} method — it satisfies the sibling
 * supervisor's structural `FleetBudgetLike` interface
 * (`plugins/fleet-supervisor/src/types.ts:104-110`); wiring it into a composed
 * supervisor profile is a documented follow-up, the supervisor itself is
 * untouched in this phase.
 * @module @hydra/dsh-fleet-budget/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** What a budget cap is measured in. */
export type FleetBudgetUnit = 'tokens' | 'cost'

/** The decision level of a budget at its current spend. */
export type FleetBudgetLevel = 'ok' | 'warning' | 'critical'

/**
 * A budget scope. Keyed as `global` / `agent:<id>` / `task-kind:<kind>` for
 * the durable store (one budget per scope key).
 */
export type FleetBudgetScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'task-kind'; readonly taskKind: string }

/** Canonical store key for a scope (unique per budget). */
export function fleetBudgetScopeKey(scope: FleetBudgetScope): string {
  switch (scope.kind) {
    case 'global': return 'global'
    case 'agent': return `agent:${scope.agentId}`
    case 'task-kind': return `task-kind:${scope.taskKind}`
  }
}

/** Parse a store key back to a scope; `undefined` for unknown keys. */
export function fleetBudgetScopeFromKey(key: string): FleetBudgetScope | undefined {
  if (key === 'global') return { kind: 'global' }
  const agent = /^agent:(.+)$/.exec(key)
  if (agent !== null) return { kind: 'agent', agentId: agent[1]! }
  const taskKind = /^task-kind:(.+)$/.exec(key)
  if (taskKind !== null) return { kind: 'task-kind', taskKind: taskKind[1]! }
  return undefined
}

/**
 * One durable budget. `spentTokens`/`spentCost` are both accumulated for every
 * cost record regardless of the budget's `unit`; the level is computed against
 * the effective spend in `unit`.
 */
export interface FleetBudgetEntry {
  readonly id: string
  readonly scope: FleetBudgetScope
  /** Cap in `unit`. */
  readonly cap: number
  readonly unit: FleetBudgetUnit
  /** Fraction of the cap at which the soft warning fires. Default 0.8. */
  readonly softThreshold: number
  /** Fraction of the cap at which escalation fires. Default 1.0. */
  readonly criticalThreshold: number
  /** Spend accumulated in tokens. */
  spentTokens: number
  /** Spend accumulated in cost. */
  spentCost: number
  /** Warning fired at least once at the current spend level. */
  warningEmitted: boolean
  /** Escalation fired at least once at the current spend level. */
  escalatedEmitted: boolean
  /** Named owner the escalation routes to (lead/owner, decision #4). */
  readonly owner?: string
  readonly createdAt: number
  updatedAt: number
}

/** The caller-provided half of `setBudget`; id/timestamps are assigned. */
export interface FleetBudgetSetInput {
  readonly scope: FleetBudgetScope
  readonly cap: number
  readonly unit?: FleetBudgetUnit
  readonly softThreshold?: number
  readonly criticalThreshold?: number
  readonly owner?: string
}

/** One cost accounting input: a worker turn's token/cost usage by an agent. */
export interface FleetCostRecordInput {
  /** The agent whose work incurred the cost. */
  readonly agentId: string
  /** Optional task kind the cost is attributed to (per-scope tracking). */
  readonly taskKind?: string
  /** Tokens used (unit `tokens` budgets accumulate this). */
  readonly tokens?: number
  /** Cost used (unit `cost` budgets accumulate this). */
  readonly cost?: number
}

/** One durable cost record (append-only ledger). */
export interface FleetCostRecord {
  readonly id: string
  readonly agentId: string
  readonly taskKind?: string
  readonly tokens: number
  readonly cost: number
  readonly ts: number
}

/** How one record impacted one affected budget. */
export interface FleetBudgetImpact {
  readonly budget: FleetBudgetEntry
  readonly level: FleetBudgetLevel
  /** Effective spend in the budget's unit. */
  readonly spent: number
  /** `spent / cap` as a fraction. */
  readonly pct: number
  /** Which threshold crossing this record produced (if any). */
  readonly crossed: 'warning' | 'critical' | 'none'
}

/** Result of `recordCost`: the ledger record + every budget it touched. */
export interface FleetCostResult {
  readonly record: FleetCostRecord
  readonly impacted: FleetBudgetImpact[]
}

/** The `budgetStatus` view: matched budgets + per-scope levels + fleet totals. */
export interface FleetBudgetStatus {
  readonly levels: Record<string, FleetBudgetLevel>
  /** The worst level across the matched budgets. */
  readonly worst: FleetBudgetLevel
  readonly budgets: FleetBudgetEntry[]
  /** Fleet-wide totals over every cost record. */
  readonly totals: { tokens: number; cost: number }
}

/**
 * Threshold semantics (owner decision #4). A budget's level is purely a
 * function of spend vs cap — there is NO hard stop; a breached budget warns +
 * escalates and the scheduler defers (soft warning) rather than cancelling
 * work. `softThreshold`/`criticalThreshold` are fractions (0..1] of the cap.
 */
export function fleetBudgetThresholds(budget: Pick<FleetBudgetEntry, 'softThreshold' | 'criticalThreshold'>): {
  soft: number
  critical: number
} {
  return { soft: budget.softThreshold, critical: budget.criticalThreshold }
}

/** Effective spend of a budget in its own unit. */
export function fleetBudgetEffectiveSpent(budget: FleetBudgetEntry): number {
  return budget.unit === 'cost' ? budget.spentCost : budget.spentTokens
}

/** `spent / cap` as a fraction (0 when cap is 0/undefined). */
export function fleetBudgetPct(budget: FleetBudgetEntry): number {
  if (budget.cap <= 0) return 0
  return fleetBudgetEffectiveSpent(budget) / budget.cap
}

/** Level for a pct against a budget's thresholds. */
export function fleetBudgetLevel(budget: Pick<FleetBudgetEntry, 'softThreshold' | 'criticalThreshold'>, pct: number): FleetBudgetLevel {
  if (pct >= budget.criticalThreshold) return 'critical'
  if (pct >= budget.softThreshold) return 'warning'
  return 'ok'
}

/** The worst of two levels (used to aggregate scopes). */
export function worstFleetBudgetLevel(a: FleetBudgetLevel, b: FleetBudgetLevel): FleetBudgetLevel {
  const rank = { ok: 0, warning: 1, critical: 2 } as const
  return rank[a] >= rank[b] ? a : b
}

/** A JSON-safe summary of a budget for events/status payloads. */
export function fleetBudgetToJsonValue(budget: FleetBudgetEntry): JsonValue {
  return {
    id: budget.id,
    scope: budget.scope,
    scopeKey: fleetBudgetScopeKey(budget.scope),
    cap: budget.cap,
    unit: budget.unit,
    softThreshold: budget.softThreshold,
    criticalThreshold: budget.criticalThreshold,
    spent: fleetBudgetEffectiveSpent(budget),
    pct: fleetBudgetPct(budget),
    level: fleetBudgetLevel(budget, fleetBudgetPct(budget)),
    ...(budget.owner !== undefined ? { owner: budget.owner } : {}),
  }
}
