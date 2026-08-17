/**
 * @hydra/dsh-fleet-budget — cost tracking + scoped caps + soft warnings +
 * escalation (issue #26, orchestration-v3 §4 P3.2, owner decision #4).
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`, see `@deepseek-ai/dsh-tool-todo` as
 * the registration template — the same shape as the sibling fleet-tasks
 * plugin). It constructs the {@link FleetBudgetService} (registers
 * `ctx.fleetBudget`) and registers three model-facing tools on the global
 * `ctx.tools` registry (the tool-todo pattern,
 * packages/todo/tool-todo/src/index.ts:149): `budget_set` (setBudget),
 * `budget_record` (recordCost), and `budget_status` (budgetStatus). The tools
 * use `exec.agent` for caller identity
 * (packages/core/tools/src/index.ts:360-361).
 *
 * ```
 * - id: fleet-budget
 *   name: '@hydra/dsh-fleet-budget'
 *   config:
 *     dir: ''               # default $DSH_HOME/fleet (durable SQLite store)
 *     softThreshold: 0.8    # default soft-warning fraction of the cap
 *     criticalThreshold: 1.0  # default escalation fraction of the cap
 * ```
 *
 * Deps: self-contained — `ctx.fleetBus` (event publish) and `ctx.fleetAgent`
 * (signed events) are resolved optionally at crossing time. `checkWake(agentId)`
 * satisfies the fleet-supervisor's structural `FleetBudgetLike` seam; the live
 * supervisor wiring is a documented follow-up, NOT part of this phase.
 * @module @hydra/dsh-fleet-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { FleetBudgetService, type FleetBudgetConfig } from './service.ts'
import type { FleetBudgetScope } from './types.ts'
import { fleetBudgetLevel } from './types.ts'

export const name = 'fleet-budget'
/** Self-contained: ctx.fleetBus / ctx.fleetAgent are resolved optionally. */
export const inject: string[] = ['tools']

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetBudgetConfig {
  /** Register the budget_* tools on ctx.tools (default true). Host-plane compositions set false. */
  injectTools: boolean
}

export const Config: z<Config> = z.object({
  /** Directory holding the SQLite store. Default `$DSH_HOME/fleet`. */
  dir: z.string(),
  /** Store file name. Default `fleet-budget.sqlite`. */
  file: z.string(),
  /** Injectable clock (tests only). */
  clock: z.any(),
  /** Default soft-warning fraction of the cap. Default 0.8. */
  softThreshold: z.number(),
  /** Default escalation fraction of the cap. Default 1.0. */
  criticalThreshold: z.number(),
  /** Register tools (default true). Host-plane compositions set false. */
  injectTools: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const budget = new FleetBudgetService(ctx, config)
  if (config.injectTools) {
    registerFleetBudgetTools(ctx, budget)
  }
}

/** Scoped tools only run inside an agent; a caller without one has no id. */
function requireAgent(agent: { id: string } | undefined): { id: string } {
  if (agent === undefined) {
    throw new Error('fleet tools require an owning agent session')
  }
  return agent
}

/** Narrow a JSON output value to a record for render-time shaping. */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function renderBudgetSummary(value: JsonValue | undefined, prefix: string): { type: 'text'; text: string }[] {
  const record = asRecord(value)
  const budget = asRecord(record?.budget as JsonValue | undefined)
  if (budget === undefined) return [{ type: 'text', text: `${prefix}: no budget returned` }]
  const scope = asRecord(budget.scope as JsonValue | undefined)
  const scopeLabel = scope === undefined ? String(budget.scope) : scope.kind === 'global'
    ? 'global'
    : scope.kind === 'agent'
      ? `agent:${String(scope.agentId)}`
      : `task-kind:${String(scope.taskKind)}`
  const cap = Number(budget.cap)
  const unit = String(budget.unit)
  const spent = unit === 'cost' ? Number(budget.spentCost) : Number(budget.spentTokens)
  const pct = cap > 0 ? (spent / cap) : 0
  const level = fleetBudgetLevel({ softThreshold: Number(budget.softThreshold), criticalThreshold: Number(budget.criticalThreshold) }, pct)
  return [{ type: 'text', text: `${prefix} ${scopeLabel} [${level}] spent ${Math.round(pct * 100)}% of cap` }]
}

function renderCostSummary(value: JsonValue | undefined): { type: 'text'; text: string }[] {
  const record = asRecord(value)
  const cost = asRecord(record?.record as JsonValue | undefined)
  if (cost === undefined) return [{ type: 'text', text: 'recordCost: no record returned' }]
  const impacted = Array.isArray(record?.impacted) ? record.impacted : []
  const crossed = impacted
    .map((entry: unknown) => {
      const impact = asRecord(entry as JsonValue)
      return impact?.crossed === 'warning' || impact?.crossed === 'critical' ? String(impact.crossed) : undefined
    })
    .filter((entry: unknown): entry is string => typeof entry === 'string')
  const suffix = crossed.length > 0 ? ` — crossed: ${[...new Set(crossed)].join(', ')}` : ''
  return [{ type: 'text', text: `recordCost: ${String(cost.tokens ?? 0)} tokens / ${String(cost.cost ?? 0)} cost (${String(cost.agentId)})${suffix}` }]
}

/** Normalize a schemastery scope parameter into a typed FleetBudgetScope. */
function parseScope(args: { scope: { kind: string; agentId?: string; taskKind?: string } }): FleetBudgetScope {
  switch (args.scope.kind) {
    case 'global':
      return { kind: 'global' }
    case 'agent': {
      if (args.scope.agentId === undefined || args.scope.agentId.trim().length === 0) {
        throw new Error('budget_set: scope.kind "agent" requires scope.agentId')
      }
      return { kind: 'agent', agentId: args.scope.agentId }
    }
    case 'task-kind': {
      if (args.scope.taskKind === undefined || args.scope.taskKind.trim().length === 0) {
        throw new Error('budget_set: scope.kind "task-kind" requires scope.taskKind')
      }
      return { kind: 'task-kind', taskKind: args.scope.taskKind }
    }
    default:
      throw new Error(`budget_set: unknown scope kind "${args.scope.kind}"`)
  }
}

/** Register the three fleet-budget tools on the global tools registry. */
function registerFleetBudgetTools(ctx: Context, budget: FleetBudgetService): void {
  ctx.tools.register(defineTool({
    name: 'budget_set',
    description: 'Upsert a fleet budget (setBudget): a scoped cap in tokens or cost with a soft-warning threshold (fraction of the cap, default 0.8) and an escalation threshold (fraction, default 1.0). Scopes: global (whole fleet), agent:<id> (per identity), or task-kind:<kind> (per task kind). Crossing the soft threshold fires fleet/budget-warning; crossing the escalation threshold fires fleet/budget-escalated to the named owner (owner decision #4: soft warnings + human escalation, no hard stops).',
    parameters: {
      scope: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['global', 'agent', 'task-kind'], required: true, description: 'Budget scope: global, per-agent (agentId), or per-task-kind (taskKind).' },
          agentId: { type: 'string', description: 'The agent id for scope.kind "agent".' },
          taskKind: { type: 'string', description: 'The task kind for scope.kind "task-kind".' },
        },
        description: 'The budget scope.',
      },
      cap: { type: 'number', required: true, description: 'The budget cap in unit (positive number).' },
      unit: { type: 'string', enum: ['tokens', 'cost'], description: 'What the cap measures (default tokens).' },
      softThreshold: { type: 'number', description: 'Soft-warning fraction of the cap (default 0.8).' },
      criticalThreshold: { type: 'number', description: 'Escalation fraction of the cap (default 1.0).' },
      owner: { type: 'string', description: 'Named owner the escalation routes to (lead/owner, decision #4).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderBudgetSummary(value, 'Set'),
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const scope = parseScope(args)
      const result = budget.setBudget({
        scope,
        cap: args.cap,
        ...(args.unit !== undefined ? { unit: args.unit } : {}),
        ...(args.softThreshold !== undefined ? { softThreshold: args.softThreshold } : {}),
        ...(args.criticalThreshold !== undefined ? { criticalThreshold: args.criticalThreshold } : {}),
        ...(args.owner !== undefined ? { owner: args.owner } : {}),
      }, caller.id)
      return { budget: result } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Set fleet budget', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'budget_record',
    description: 'Record a cost input (recordCost): one worker turn\'s tokens/cost attributed to an agent and an optional task kind. The spend accumulates into the global budget, the agent budget, and the task-kind budget (when given). Crossing a threshold fires fleet/budget-warning (soft) or fleet/budget-escalated (breach, to the owner). Per owner decision #4 the record is ALWAYS applied — budgets warn + escalate, they do not hard-block work.',
    parameters: {
      agentId: { type: 'string', required: true, description: 'The agent whose work incurred the cost.' },
      taskKind: { type: 'string', description: 'Optional task kind the cost is attributed to.' },
      tokens: { type: 'number', description: 'Tokens used (accumulates into unit "tokens" budgets).' },
      cost: { type: 'number', description: 'Cost used (accumulates into unit "cost" budgets).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderCostSummary(value),
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const result = budget.recordCost({
        agentId: args.agentId,
        ...(args.taskKind !== undefined ? { taskKind: args.taskKind } : {}),
        ...(args.tokens !== undefined ? { tokens: args.tokens } : {}),
        ...(args.cost !== undefined ? { cost: args.cost } : {}),
      }, caller.id)
      return result as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Record fleet cost', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'budget_status',
    description: 'Show budget status (budgetStatus): the budgets matching the filter (global + the agent budget when agentId is given, + the task-kind budget when taskKind is given), each with its current level (ok/warning/critical), spend fraction of the cap, and the fleet-wide token/cost totals. Also rolls up the worst level across the matched budgets.',
    parameters: {
      agentId: { type: 'string', description: 'Include this agent\'s budget (plus the global budget).' },
      taskKind: { type: 'string', description: 'Include this task-kind\'s budget (plus the global budget).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const budgets = Array.isArray(record?.budgets) ? record.budgets : []
        const worst = String(record?.worst ?? 'ok')
        return [{ type: 'text', text: `Fleet budgets: ${budgets.length} matched (worst ${worst})` }]
      },
    },
    async execute(args, exec) {
      requireAgent(exec.agent)
      return budget.status({
        ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
        ...(args.taskKind !== undefined ? { taskKind: args.taskKind } : {}),
      }) as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Fleet budget status', kind: 'other', rawInput: args }),
  }))
}

/** Re-export the vocabulary for consumers of the plugin. */
export type { FleetBudgetEntry, FleetBudgetLevel, FleetBudgetScope } from './types.ts'
