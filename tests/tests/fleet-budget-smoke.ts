/**
 * VERIFY (issue #26): fleet-budget smoke test.
 * Unit coverage for the V3 budget plugin (orchestration-v3 §4 P3.2, owner
 * decision #4): scoped caps (global / per-agent / per-task-kind), soft-warning
 * + escalation threshold crossings with deduped `fleet/budget-warning` /
 * `fleet/budget-escalated` events, the `checkWake(agentId)` scheduler-consult
 * seam (satisfies the fleet-supervisor's `FleetBudgetLike`), persistence
 * reload, the three model-facing tools, and the bus/identity event contract
 * (originKind 'budget' + signed envelopes). No live LLM.
 *
 * Run: pnpm test:budget  (or)  tsx tests/fleet-budget-smoke.ts
 * @module @hydra/dsh-fleet/tests/fleet-budget-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertPass, fakeClock } from './harness.ts'
import { apply as applyBudget, type Config as BudgetConfig } from '../plugins/fleet-budget/src/index.ts'
import { FleetBudgetService, FLEET_BUDGET_EVENT_TYPES, type FleetBudgetConfig } from '../plugins/fleet-budget/src/service.ts'
import { FleetBudgetStore } from '../plugins/fleet-budget/src/store.ts'
import type { FleetBudgetLevel, FleetCostResult } from '../plugins/fleet-budget/src/types.ts'
import { fleetBudgetScopeKey } from '../plugins/fleet-budget/src/types.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'
import { FleetAgentService, type FleetSignedEvent } from '../plugins/fleet-agent/src/service.ts'

/** Mount fleet-budget on a fresh Context with a temp SQLite store + fake clock. */
function mountBudget(overrides: Partial<FleetBudgetConfig> = {}): {
  ctx: Context
  clock: ReturnType<typeof fakeClock>
  budget: FleetBudgetService
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const budget = new FleetBudgetService(ctx, {
    dir: mkdtempSync(join(tmpdir(), 'fleet-budget-')),
    clock,
    ...overrides,
  })
  assertPass('ctx.fleetBudget is registered', ctx.fleetBudget !== undefined)
  return { ctx, clock, budget }
}

/** Mount fleet-budget + a REAL fleet-bus on the same Context (event integration). */
function mountBudgetWithBus(): {
  ctx: Context
  clock: ReturnType<typeof fakeClock>
  budget: FleetBudgetService
  bus: FleetBusService
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-bus-')),
    clock,
    resolveAgent: () => undefined,
  })
  const budget = new FleetBudgetService(ctx, {
    dir: mkdtempSync(join(tmpdir(), 'fleet-budget-')),
    clock,
  })
  return { ctx, clock, budget, bus }
}

async function main(): Promise<void> {
  console.log('fleet-budget-smoke: cost tracking — scoped caps, soft warnings, escalation, checkWake seam, persistence, tools, events')

  // ---- 1. setBudget + initial ok level ----
  {
    const { budget } = mountBudget()
    const global = budget.setBudget({ scope: { kind: 'global' }, cap: 1_000, unit: 'tokens' }, 'lead-1')
    assertPass('setBudget creates a budget with defaults', global.scope.kind === 'global' && global.cap === 1_000 && global.unit === 'tokens')
    assertPass('setBudget defaults the soft threshold to 0.8', global.softThreshold === 0.8)
    assertPass('setBudget defaults the escalation threshold to 1.0', global.criticalThreshold === 1.0)
    assertPass('new budget starts at zero spend', global.spentTokens === 0 && global.spentCost === 0)
    assertPass('setBudget is idempotent per scope (same key)', fleetBudgetScopeKey(global.scope) === 'global')
    const status = budget.status()
    assertPass('status reports worst level ok before any cost', status.worst === 'ok' && status.levels.global === 'ok')
  }

  // ---- 2. soft-warning crossing: 80% of the cap → fleet/budget-warning ----
  {
    const { ctx, budget } = mountBudget()
    budget.setBudget({ scope: { kind: 'global' }, cap: 1_000, unit: 'tokens' }, 'lead-1')
    const warnings: string[] = []
    ctx.on('fleet-budget/event', (info) => { if (info.type === FLEET_BUDGET_EVENT_TYPES.warning) warnings.push(info.budget.id) })

    const result = budget.recordCost({ agentId: 'agent-a', tokens: 800 }, 'agent-a')
    assertPass('recordCost appends a durable record', result.record.tokens === 800 && result.record.agentId === 'agent-a')
    assertPass('recordCost returns the impacted budget at the warning level',
      result.impacted.length === 1 && result.impacted[0]!.level === 'warning', JSON.stringify(result.impacted))
    assertPass('crossed is "warning" at the soft threshold', result.impacted[0]!.crossed === 'warning')
    assertPass('pct reflects spent/cap', result.impacted[0]!.pct === 0.8)

    const global = budget.get('global')!
    assertPass('spend accumulated into the global budget', global.spentTokens === 800 && global.warningEmitted === true)
    assertPass('checkWake returns warning at the soft threshold', budget.checkWake('agent-a') === 'warning')
    assertPass('fleet-budget/event emitted for the warning', warnings.length === 1, JSON.stringify(warnings))
  }

  // ---- 3. escalation crossing: 100% of the cap → fleet/budget-escalated to the owner ----
  {
    const { budget, clock } = mountBudget()
    budget.setBudget({ scope: { kind: 'global' }, cap: 1_000, unit: 'tokens', owner: 'lead-vortex' }, 'lead-1')
    budget.recordCost({ agentId: 'agent-a', tokens: 800 }, 'agent-a')
    clock.advance(100)
    const escalated = budget.recordCost({ agentId: 'agent-a', tokens: 200, cost: 0.05 }, 'agent-a')

    assertPass('crossed is "critical" at the cap breach', escalated.impacted[0]!.crossed === 'critical')
    assertPass('level is critical at/over the cap', escalated.impacted[0]!.level === 'critical')
    const global = budget.get('global')!
    assertPass('escalation flag set once', global.escalatedEmitted === true)
    assertPass('recordCost is ALWAYS applied (no hard stop, decision #4)',
      global.spentTokens === 1_000 && global.spentCost === 0.05)
    assertPass('checkWake returns critical at the cap breach', budget.checkWake('agent-a') === 'critical')
    assertPass('budget_status worst reflects the critical level', budget.status().worst === 'critical')
  }

  // ---- 4. dedupe: repeated records within a level emit no repeat events ----
  {
    const { ctx, budget } = mountBudget()
    budget.setBudget({ scope: { kind: 'global' }, cap: 1_000 }, 'lead-1')
    const seen: string[] = []
    ctx.on('fleet-budget/event', (info) => { seen.push(info.type) })
    budget.recordCost({ agentId: 'agent-a', tokens: 800 }, 'agent-a')
    budget.recordCost({ agentId: 'agent-a', tokens: 100 }, 'agent-a')
    budget.recordCost({ agentId: 'agent-a', tokens: 50 }, 'agent-a')
    budget.recordCost({ agentId: 'agent-a', tokens: 50 }, 'agent-a')
    assertPass('exactly one warning and one escalation across crossings',
      seen.filter(t => t === FLEET_BUDGET_EVENT_TYPES.warning).length === 1
        && seen.filter(t => t === FLEET_BUDGET_EVENT_TYPES.escalated).length === 1,
      JSON.stringify(seen))
    const last = budget.recordCost({ agentId: 'agent-a', tokens: 1 }, 'agent-a')
    assertPass('records past the breach keep landing with crossed "none" (no re-fire)',
      last.impacted[0]!.crossed === 'none' && last.impacted[0]!.level === 'critical')
  }

  // ---- 5. per-scope independence: agent + task-kind budgets accumulate separately ----
  {
    const { budget } = mountBudget()
    budget.setBudget({ scope: { kind: 'global' }, cap: 2_000 }, 'lead-1')
    budget.setBudget({ scope: { kind: 'agent', agentId: 'agent-a' }, cap: 500, unit: 'tokens', owner: 'lead-vortex' }, 'lead-1')
    budget.setBudget({ scope: { kind: 'task-kind', taskKind: 'build' }, cap: 300 }, 'lead-1')

    const result = budget.recordCost({ agentId: 'agent-a', taskKind: 'build', tokens: 600 }, 'agent-a')
    const impactedKeys = result.impacted.map(impact => fleetBudgetScopeKey(impact.budget.scope)).sort()
    assertPass('one record lands in every affected scope',
      impactedKeys.join(',') === 'agent:agent-a,global,task-kind:build', impactedKeys.join(','))
    const agentBudget = budget.get('agent:agent-a')!
    const taskBudget = budget.get('task-kind:build')!
    assertPass('agent budget breached independently (600/500)', agentBudget.spentTokens === 600 && budget.checkWake('agent-a') === 'critical')
    assertPass('task-kind budget breached independently (600/300)', taskBudget.spentTokens === 600 && taskBudget.escalatedEmitted === true)
    assertPass('global budget untouched by the agent breach (600/2000)',
      budget.get('global')!.spentTokens === 600 && budget.status().levels.global === 'ok')
    const agentStatus = budget.status({ agentId: 'agent-a' })
    assertPass('status(agentId) includes global + the agent budget',
      agentStatus.budgets.length === 2 && agentStatus.worst === 'critical')
  }

  // ---- 6. checkWake seam: no budget → ok; worst across global + agent ----
  {
    const { budget } = mountBudget()
    assertPass('checkWake with no budgets is ok', budget.checkWake('nobody') === 'ok')

    budget.setBudget({ scope: { kind: 'global' }, cap: 1_000 }, 'lead-1')
    budget.recordCost({ agentId: 'agent-x', tokens: 850 }, 'agent-x')
    assertPass('global warning makes checkWake warning for any agent',
      budget.checkWake('agent-x') === 'warning' && budget.checkWake('other') === 'warning')

    budget.setBudget({ scope: { kind: 'agent', agentId: 'agent-x' }, cap: 100 }, 'lead-1')
    budget.recordCost({ agentId: 'agent-x', tokens: 110 }, 'agent-x')
    assertPass('worst level aggregates the agent budget over the global',
      budget.checkWake('agent-x') === 'critical' && budget.checkWake('other') === 'warning')
  }

  // ---- 7. reset: recovered budget clears spend + flags and can re-warn ----
  {
    const { ctx, budget } = mountBudget()
    budget.setBudget({ scope: { kind: 'agent', agentId: 'agent-a' }, cap: 100 }, 'lead-1')
    const events: string[] = []
    ctx.on('fleet-budget/event', (info) => { events.push(info.type) })
    budget.recordCost({ agentId: 'agent-a', tokens: 90 }, 'agent-a')
    budget.recordCost({ agentId: 'agent-a', tokens: 20 }, 'agent-a')
    assertPass('pre-reset escalation fired once', events.filter(t => t === FLEET_BUDGET_EVENT_TYPES.escalated).length === 1)

    const reset = budget.reset('agent:agent-a', 'lead-1')!
    assertPass('reset zeroes spend + clears crossing flags',
      reset.spentTokens === 0 && reset.warningEmitted === false && reset.escalatedEmitted === false)
    assertPass('reset restores checkWake to ok', budget.checkWake('agent-a') === 'ok')

    budget.recordCost({ agentId: 'agent-a', tokens: 90 }, 'agent-a')
    assertPass('a recovered budget can warn again after reset (fresh crossing)',
      events.filter(t => t === FLEET_BUDGET_EVENT_TYPES.warning).length === 2
        && events[events.length - 1] === FLEET_BUDGET_EVENT_TYPES.warning,
      JSON.stringify(events))
  }

  // ---- 8. persistence reload: budgets + accumulated spend survive a restart ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-budget-store-'))
    const clock = fakeClock()
    const store1 = new FleetBudgetStore({ dir })
    const service1 = new FleetBudgetService(new CordisContext(), { dir, clock })
    service1.setBudget({ scope: { kind: 'global' }, cap: 1_000, owner: 'lead-vortex' }, 'lead-1')
    service1.setBudget({ scope: { kind: 'agent', agentId: 'agent-a' }, cap: 500 }, 'lead-1')
    service1.recordCost({ agentId: 'agent-a', tokens: 600, cost: 0.04 }, 'agent-a')
    store1.close()

    const store2 = new FleetBudgetStore({ dir })
    const service2 = new FleetBudgetService(new CordisContext(), { dir, clock })
    const reloaded = service2.list()
    assertPass('reload reads both persisted budgets back', reloaded.length === 2)
    const global = reloaded.find(b => b.scope.kind === 'global')!
    const agent = reloaded.find(b => b.scope.kind === 'agent')!
    assertPass('reload preserves spend + crossing flags',
      global.spentTokens === 600 && global.escalatedEmitted === false && agent.spentTokens === 600 && agent.escalatedEmitted === true)
    assertPass('reload preserves the escalation owner', global.owner === 'lead-vortex')
    assertPass('reload preserves totals over the cost ledger', service2.status().totals.tokens === 600 && service2.status().totals.cost === 0.04)
    store2.close()
  }

  // ---- 9. bus events: originKind "budget" + warning/escalated on the store ----
  {
    const { budget, bus, clock } = mountBudgetWithBus()
    budget.setBudget({ scope: { kind: 'global' }, cap: 1_000, owner: 'lead-vortex' }, 'lead-1')
    budget.recordCost({ agentId: 'agent-a', tokens: 800 }, 'agent-a')
    clock.advance(100)
    budget.recordCost({ agentId: 'agent-a', tokens: 200 }, 'agent-a')

    const byType = (type: string): FleetBusEvent[] => bus.replay({ type })
    const warnings = byType(FLEET_BUDGET_EVENT_TYPES.warning)
    const escalations = byType(FLEET_BUDGET_EVENT_TYPES.escalated)
    assertPass('fleet/budget-warning published at the soft threshold', warnings.length === 1)
    assertPass('fleet/budget-escalated published at the breach', escalations.length === 1)
    assertPass('budget events carry originKind "budget" (mechanism separation)',
      warnings[0]!.originKind === 'budget' && escalations[0]!.originKind === 'budget')
    assertPass('escalation payload carries the owner + next action',
      (escalations[0]!.payload as { owner?: string; nextAction?: string }).owner === 'lead-vortex'
        && typeof (escalations[0]!.payload as { nextAction?: string }).nextAction === 'string')
    assertPass('warning payload carries the spend fraction',
      (warnings[0]!.payload as { pct?: number }).pct === 0.8)
    assertPass('budget events are fleet-scoped', warnings[0]!.scope === 'fleet')
  }

  // ---- 10. signed events: identity signs budget events when available ----
  {
    const clock = fakeClock()
    const ctx = new CordisContext()
    const identity = new FleetAgentService(ctx, { home: mkdtempSync(join(tmpdir(), 'fleet-agent-')) })
    identity.register({ agentId: 'agent-a' })
    const bus = new FleetBusService(ctx, { storeDir: mkdtempSync(join(tmpdir(), 'fleet-bus-')), clock, resolveAgent: () => undefined })
    const budget = new FleetBudgetService(ctx, { dir: mkdtempSync(join(tmpdir(), 'fleet-budget-')), clock })

    budget.setBudget({ scope: { kind: 'global' }, cap: 100 }, 'lead-1')
    budget.recordCost({ agentId: 'agent-a', tokens: 100 }, 'agent-a')
    const events = bus.replay({ type: FLEET_BUDGET_EVENT_TYPES.escalated })
    const payload = events[0]!.payload as { signed?: FleetSignedEvent }
    assertPass('budget event embeds a signed envelope when identity is available', payload.signed !== undefined)
    assertPass('the embedded signature verifies against the actor profile', identity.verify(payload.signed!).ok === true)
  }

  // ---- 11. cordis event emission per crossing ----
  {
    const { ctx, budget } = mountBudget()
    budget.setBudget({ scope: { kind: 'global' }, cap: 1_000 }, 'lead-1')
    const seen: { type: string; level: FleetBudgetLevel; actor: string }[] = []
    ctx.on('fleet-budget/event', (info) => { seen.push(info) })
    budget.recordCost({ agentId: 'agent-a', tokens: 800 }, 'agent-a')
    budget.recordCost({ agentId: 'agent-a', tokens: 200 }, 'agent-a')
    assertPass('fleet-budget/event emitted per crossing',
      seen.length === 2 && seen[0]!.type === FLEET_BUDGET_EVENT_TYPES.warning && seen[1]!.type === FLEET_BUDGET_EVENT_TYPES.escalated
        && seen[0]!.level === 'warning' && seen[1]!.level === 'critical')
  }

  // ---- 12. model-facing tools execute against the service ----
  {
    const ctx = new CordisContext()
    const clock = fakeClock()
    const registered = new Map<string, ToolDefinition>()
    ctx.reflect.provide('tools', {
      register(def: ToolDefinition): () => void {
        registered.set(def.name, def)
        return () => { registered.delete(def.name) }
      },
    } as never)

    applyBudget(ctx, {
      dir: mkdtempSync(join(tmpdir(), 'fleet-budget-')),
      clock,
      injectTools: true,
    } as never)

    assertPass('apply registers the three budget tools',
      ['budget_set', 'budget_record', 'budget_status'].every(n => registered.has(n)),
      JSON.stringify([...registered.keys()]))

    const exec = { agent: { id: 'agent-a', session: { id: 'agent-a' } } }
    const set = registered.get('budget_set')!
    const setResult = await set.execute!({
      scope: { kind: 'global' },
      cap: 1_000,
      unit: 'tokens',
      owner: 'lead-vortex',
    }, exec as never) as { budget: { scope: { kind: string }; cap: number; spentTokens: number } }
    assertPass('budget_set executes', setResult.budget.scope.kind === 'global' && setResult.budget.cap === 1_000)

    const record = registered.get('budget_record')!
    const recordResult = await record.execute!({ agentId: 'agent-a', taskKind: 'build', tokens: 800 }, exec as never) as FleetCostResult
    assertPass('budget_record executes + attributes to the agent',
      recordResult.record.tokens === 800 && recordResult.record.agentId === 'agent-a')

    const status = registered.get('budget_status')!
    const statusResult = await status.execute!({ agentId: 'agent-a' }, exec as never) as { worst: FleetBudgetLevel; budgets: unknown[]; totals: { tokens: number; cost: number } }
    assertPass('budget_status executes with the worst level',
      statusResult.worst === 'warning' && statusResult.totals.tokens === 800)

    const noAgent = await record.execute!({ agentId: 'agent-a', tokens: 1 }, {} as never)
      .then(() => false, () => true)
    assertPass('budget tools require an owning agent session', noAgent === true)
  }

  console.log('fleet-budget-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`fleet-budget-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
