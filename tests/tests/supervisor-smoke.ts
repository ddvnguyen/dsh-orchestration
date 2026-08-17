/**
 * VERIFY (issue #26 + #28): fleet-supervisor smoke test.
 * Unit coverage for the fleet-scheduler wake scan (due→wake with per-agent
 * coalescing), the budget seam (soft-warning escalates instead of waking), the
 * claimWake seam (fleet-tasks present vs task_claim fallback), wake-fingerprint
 * reuse on the bus (bus dedupe suppresses identical wake events), takeover on
 * stall, orphan recovery (re-due + re-wake), the #28 silent active-run
 * watchdog, periodic digests + ready-queue rollup, the verification-gated
 * merge queue (#28), and wake-queue store durability. No live LLM — fake
 * delivery targets + fake clock (the family harness pattern).
 *
 * Run: pnpm test:supervisor  (or)  tsx tests/supervisor-smoke.ts
 * @module @hydra/dsh-fleet/tests/supervisor-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertPass, fakeClock } from './harness.ts'
import { FleetService } from '../src/service.ts'
import { FleetBusService, type FleetBusDeliveryTarget } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'
import { FleetSupervisorService, SUPERVISOR_ORIGIN_KIND } from '../plugins/fleet-supervisor/src/service.ts'
import { WakeQueueStore } from '../plugins/fleet-supervisor/src/queue.ts'
import type {
  FleetBudgetLike,
  FleetTaskWakeEntryLike,
  FleetTasksLike,
  MergeQueueEntry,
  WakeEntry,
} from '../plugins/fleet-supervisor/src/types.ts'

interface CapturedDelivery {
  agentId: string
  mode: 'wake' | 'inject'
  text: string
}

/** Extract the text of the single delivered message block. */
function deliveryText(message: UserMessage): string {
  const block = message.content[0]
  return block !== undefined && block.type === 'text' ? block.text : ''
}

/** A delivery target that records followup (wake) / inject (quiet) calls. */
function makeTarget(agentId: string, deliveries: CapturedDelivery[]): FleetBusDeliveryTarget {
  return {
    followup(message) { deliveries.push({ agentId, mode: 'wake', text: deliveryText(message) }) },
    inject(message) { deliveries.push({ agentId, mode: 'inject', text: deliveryText(message) }) },
  }
}

interface MountedSupervisor {
  ctx: CordisContext
  clock: ReturnType<typeof fakeClock>
  bus: FleetBusService
  fleet: FleetService
  supervisor: FleetSupervisorService
  deliveries: CapturedDelivery[]
  targets: Map<string, FleetBusDeliveryTarget>
}

/**
 * Mount fleet-heartbeat + fleet-bus + fleet-supervisor on one fresh Context
 * with a SHARED fake clock (so stall math lines up) and fake delivery targets.
 */
function mountSupervisor(overrides: Partial<ConstructorParameters<typeof FleetSupervisorService>[1]> = {}): MountedSupervisor {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const deliveries: CapturedDelivery[] = []
  const targets = new Map<string, FleetBusDeliveryTarget>()
  const fleet = new FleetService(ctx, { clock, tickMs: 30_000, stallThresholdMs: 600_000 })
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-supervisor-')),
    clock,
    resolveAgent: agentId => targets.get(agentId),
  })
  const supervisor = new FleetSupervisorService(ctx, {
    clock,
    tickMs: 30_000,
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-wake-')),
    resolveAgent: agentId => targets.get(agentId),
    digestIntervalMs: 10 * 60_000,
    ...overrides,
  })
  assertPass('ctx.fleetSupervisor is registered', ctx.fleetSupervisor !== undefined)
  return { ctx, clock, bus, fleet, supervisor, deliveries, targets }
}

/** Deliveries to one agent (wake-mode followups). */
function wakesFor(deliveries: CapturedDelivery[], agentId: string): CapturedDelivery[] {
  return deliveries.filter(d => d.agentId === agentId && d.mode === 'wake')
}

/** Bus events of one type, newest-last. */
function eventsOf(bus: FleetBusService, type: string): FleetBusEvent[] {
  return bus.replay({ type })
}

/** Enqueue `count` due-now wake entries for one agent (same kind/context). */
function enqueueDue(supervisor: FleetSupervisorService, agentId: string, kind: string, context: Record<string, unknown>, count = 1): WakeEntry[] {
  const entries: WakeEntry[] = []
  for (let i = 0; i < count; i++) {
    entries.push(supervisor.enqueueWake({ targetAgentId: agentId, kind, context: { ...context, i } }))
  }
  return entries
}

async function main(): Promise<void> {
  console.log('supervisor-smoke: fleet-scheduler + takeover + orphan + silent-run + digest + merge queue')

  // ---- 1. wake queue due→wake with coalescing (2 due entries → ONE followup) ----
  {
    const { ctx, supervisor, deliveries, targets } = mountSupervisor()
    targets.set('agent-a', makeTarget('agent-a', deliveries))
    enqueueDue(supervisor, 'agent-a', 'cron', { job: 'x' }, 2)

    const result = await supervisor.runTick()
    const wakes = wakesFor(deliveries, 'agent-a')
    assertPass('two due entries for one agent → ONE followup', wakes.length === 1, JSON.stringify(wakes))
    assertPass('coalesced wake prompt carries both entries',
      wakes[0]!.text.includes('cron-1') && wakes[0]!.text.includes('cron-2'),
      wakes[0]!.text.slice(0, 200))
    assertPass('tick reports one agent woken, two entries',
      result.agentsWoken.length === 1 && result.wokenEntries.length === 2,
      JSON.stringify(result))
    const entries = supervisor.listWakeQueue()
    assertPass('both entries consumed (woken)',
      entries.length === 2 && entries.every(e => e.status === 'woken'),
      JSON.stringify(entries.map(e => e.status)))
    assertPass('fleet/wake published once with both entry ids',
      eventsOf(ctx.fleetBus, 'fleet/wake').length === 1,
      'expected exactly one fleet/wake event')
  }

  // ---- 2. wake-fingerprint reuse on the bus (#28 dedupe) ----
  {
    const { ctx, clock, supervisor, deliveries, targets } = mountSupervisor()
    targets.set('agent-a', makeTarget('agent-a', deliveries))
    targets.set('agent-b', makeTarget('agent-b', deliveries))

    // agent-b observes fleet/wake events as wake deliveries with a dedupe window.
    ctx.fleetBus.subscribe('agent-b', { type: 'fleet/wake' }, 'wake', { dedupeMs: 10_000 })

    enqueueDue(supervisor, 'agent-a', 'cron', { job: 'x' }, 2)
    await supervisor.runTick()
    const firstWakes = eventsOf(ctx.fleetBus, 'fleet/wake')
    assertPass('fleet/wake event carries a trigger fingerprint',
      typeof firstWakes[0]!.fingerprint === 'string' && firstWakes[0]!.fingerprint!.length > 0,
      JSON.stringify(firstWakes[0]))

    clock.advance(1000)
    // Identical trigger state again (same agent, same kinds/contexts).
    enqueueDue(supervisor, 'agent-a', 'cron', { job: 'x' }, 2)
    await supervisor.runTick()
    const secondWakes = eventsOf(ctx.fleetBus, 'fleet/wake')
    assertPass('identical trigger → identical fingerprint',
      secondWakes.length === 2 && secondWakes[1]!.fingerprint === firstWakes[0]!.fingerprint,
      `${secondWakes[1]!.fingerprint} vs ${firstWakes[0]!.fingerprint}`)
    assertPass('bus dedupe suppressed the identical re-wake to agent-b',
      wakesFor(deliveries, 'agent-b').length === 1, JSON.stringify(wakesFor(deliveries, 'agent-b')))
    assertPass('the woken agent itself still got a fresh wake (coalesced per tick)',
      wakesFor(deliveries, 'agent-a').length === 2, JSON.stringify(wakesFor(deliveries, 'agent-a')))
  }

  // ---- 3. budget seam: soft-warning escalates instead of waking (owner decision #4) ----
  {
    const { ctx, clock, supervisor, deliveries, targets } = mountSupervisor()
    targets.set('agent-a', makeTarget('agent-a', deliveries))
    let budgetLevel: 'ok' | 'warning' = 'warning'
    const mutableBudget: FleetBudgetLike = { checkWake: () => budgetLevel }
    ctx.reflect.provide('fleetBudget', mutableBudget)
    enqueueDue(supervisor, 'agent-a', 'cron', { job: 'x' })

    const result = await supervisor.runTick()
    assertPass('budget warning blocks the wake', wakesFor(deliveries, 'agent-a').length === 0)
    assertPass('entries deferred as blocked with a retryAt',
      supervisor.listWakeQueue().every(e => e.status === 'blocked' && typeof e.retryAt === 'number'),
      JSON.stringify(supervisor.listWakeQueue().map(e => ({ status: e.status, retryAt: e.retryAt }))))
    assertPass('fleet/budget-escalate published', eventsOf(ctx.fleetBus, 'fleet/budget-escalate').length === 1)
    assertPass('no fleet/wake published', eventsOf(ctx.fleetBus, 'fleet/wake').length === 0)

    clock.advance(300_001) // past budgetRetryMs → re-activate + wake
    budgetLevel = 'ok' // budget recovered (owner decision #4: soft warning, no hard stop)
    await supervisor.runTick()
    assertPass('blocked entries re-enter the due scan and wake after retryAt',
      wakesFor(deliveries, 'agent-a').length === 1 && supervisor.listWakeQueue().every(e => e.status === 'woken'),
      JSON.stringify(wakesFor(deliveries, 'agent-a')))
  }

  // ---- 4. claimWake seam: fleet-tasks present hands off; absent → task_claim fallback ----
  {
    // Present: claimWake called for task-claim wakes.
    const { ctx, supervisor, deliveries, targets } = mountSupervisor()
    targets.set('agent-a', makeTarget('agent-a', deliveries))
    const claimed: Array<{ agentId: string; entry: FleetTaskWakeEntryLike }> = []
    const tasks: FleetTasksLike = {
      claimWake(agentId, entry) { claimed.push({ agentId, entry }) },
      list: () => [{ id: 't-1', state: 'Unstarted' }, { id: 't-2', state: 'Unstarted' }],
    }
    ctx.reflect.provide('fleetTasks', tasks)
    const entry = supervisor.enqueueWake({ targetAgentId: 'agent-a', kind: 'task-claim', context: { task: 't-1' } })
    await supervisor.runTick()
    assertPass('claimWake handed the task-claim entry to fleet-tasks',
      claimed.length === 1 && claimed[0]!.agentId === 'agent-a'
        && claimed[0]!.entry.kind === entry.kind && claimed[0]!.entry.taskId === 't-1',
      JSON.stringify(claimed))
    assertPass('wake prompt points at the fleet-tasks claim API',
      wakesFor(deliveries, 'agent-a')[0]!.text.includes('fleet-tasks claim API'),
      wakesFor(deliveries, 'agent-a')[0]!.text.slice(0, 200))

    // Absent: fallback prompt instructs the task_claim tool.
    const absent = mountSupervisor()
    absent.targets.set('agent-b', makeTarget('agent-b', absent.deliveries))
    absent.supervisor.enqueueWake({ targetAgentId: 'agent-b', kind: 'task-claim', context: { task: 't-2' } })
    await absent.supervisor.runTick()
    assertPass('fallback wake prompt instructs the task_claim tool',
      wakesFor(absent.deliveries, 'agent-b')[0]!.text.includes('task_claim tool'),
      wakesFor(absent.deliveries, 'agent-b')[0]!.text.slice(0, 200))
  }

  // ---- 5. takeover: stalled agent's entries re-due'd to a successor ----
  {
    const { clock, deliveries, targets } = mountSupervisor()
    targets.set('agent-a', makeTarget('agent-a', deliveries))
    targets.set('agent-b', makeTarget('agent-b', deliveries))
    const ctx = new CordisContext()
    const fleet = new FleetService(ctx, { clock, tickMs: 30_000, stallThresholdMs: 600_000 })
    const bus = new FleetBusService(ctx, { storeDir: mkdtempSync(join(tmpdir(), 'fleet-supervisor-')), clock, resolveAgent: id => targets.get(id) })
    const s = new FleetSupervisorService(ctx, {
      clock, tickMs: 30_000,
      storeDir: mkdtempSync(join(tmpdir(), 'fleet-wake-')),
      resolveAgent: id => targets.get(id),
      successorFor: () => 'agent-b',
    })
    fleet.registerAgent('agent-a', 'dsh')
    fleet.registerAgent('agent-b', 'dsh')
    // Future-due so the takeover is the FIRST action (the entry is not yet woken
    // when the source agent stalls).
    s.enqueueWake({ targetAgentId: 'agent-a', kind: 'cron', context: { job: 'y' }, dueAt: clock.current() + 900_001 })

    clock.advance(600_001) // past the 10 min stall threshold
    fleet.runTick() // heartbeat stall scan flips agent-a to stalled
    assertPass('agent-a stalled by the heartbeat registry', fleet.getStatus('agent-a')!.status === 'stalled')

    const result = await s.runTick()
    assertPass('takeover re-due\'d the entry to the successor',
      s.listWakeQueue()[0]!.targetAgentId === 'agent-b',
      JSON.stringify(s.listWakeQueue()))
    assertPass('fleet/takeover published with from/to',
      eventsOf(bus, 'fleet/takeover').length === 1
        && (eventsOf(bus, 'fleet/takeover')[0]!.payload as { fromAgentId: string; toAgentId: string }).fromAgentId === 'agent-a'
        && (eventsOf(bus, 'fleet/takeover')[0]!.payload as { fromAgentId: string; toAgentId: string }).toAgentId === 'agent-b')
    assertPass('tick reports the takeover entry', result.takenOverEntries.length === 1, JSON.stringify(result))
    assertPass('the stalled source agent was not woken (entry not yet due)',
      wakesFor(deliveries, 'agent-a').length === 0, JSON.stringify(wakesFor(deliveries, 'agent-a')))

    // The re-due'd entry (now targeting agent-b) wakes on the next tick.
    await s.runTick()
    assertPass('successor agent woken on the next tick',
      wakesFor(deliveries, 'agent-b').length === 1, JSON.stringify(wakesFor(deliveries, 'agent-b')))
  }

  // ---- 6. orphan recovery: woken run dies → re-due + re-wake ----
  {
    const { ctx, clock, supervisor, deliveries, targets } = mountSupervisor({ orphanThresholdMs: 5_000 })
    targets.set('agent-a', makeTarget('agent-a', deliveries))
    ctx.fleet.registerAgent('agent-a', 'dsh')
    supervisor.enqueueWake({ targetAgentId: 'agent-a', kind: 'notify', context: { msg: 'hello' } })

    await supervisor.runTick()
    assertPass('first wake delivered', wakesFor(deliveries, 'agent-a').length === 1)

    // No completion, no heartbeat progress; past the orphan window.
    clock.advance(5_001)
    const result = await supervisor.runTick()
    assertPass('fleet/orphan published for the dead run',
      eventsOf(ctx.fleetBus, 'fleet/orphan').length === 1,
      JSON.stringify(eventsOf(ctx.fleetBus, 'fleet/orphan')))
    assertPass('orphan entry re-due\'d (pending, due now)',
      supervisor.listWakeQueue()[0]!.status === 'pending' && supervisor.listWakeQueue()[0]!.attempt === 2,
      JSON.stringify(supervisor.listWakeQueue()))
    assertPass('tick reports the orphan entry', result.orphanEntries.length === 1, JSON.stringify(result))

    await supervisor.runTick()
    assertPass('orphan entry re-woken (second followup)',
      wakesFor(deliveries, 'agent-a').length === 2, JSON.stringify(wakesFor(deliveries, 'agent-a')))
  }

  // ---- 7. silent active-run watchdog (#28): active-but-silent fires ----
  {
    const { ctx, clock, supervisor, deliveries, targets } = mountSupervisor({ silentThresholdMs: 4_000 })
    targets.set('agent-a', makeTarget('agent-a', deliveries))
    ctx.fleet.registerAgent('agent-a', 'dsh')

    await supervisor.runTick() // seed lastActivity (agent active, silentMs 0)
    assertPass('freshly-registered active agent is not silent yet',
      eventsOf(ctx.fleetBus, 'fleet/silent-run').length === 0)

    clock.advance(4_001)
    await supervisor.runTick()
    const silentEvents = eventsOf(ctx.fleetBus, 'fleet/silent-run')
    assertPass('active-but-silent agent fires fleet/silent-run',
      silentEvents.length === 1
        && (silentEvents[0]!.payload as { agentId: string }).agentId === 'agent-a',
      JSON.stringify(silentEvents))

    // Activity resets the silent timer.
    supervisor.observeActivity('agent-a')
    clock.advance(4_001)
    await supervisor.runTick()
    assertPass('activity clears the silent signal (no re-fire while active)',
      eventsOf(ctx.fleetBus, 'fleet/silent-run').length === 1,
      'expected no new silent-run after observed activity')
    assertPass('silent-run is distinct from the liveness stall',
      ctx.fleet.getStatus('agent-a')!.status === 'active',
      'agent must remain active (heartbeating) while silent')
  }

  // ---- 8. digest emits (interval) + ready-queue rollup ----
  {
    const { ctx, clock, supervisor, deliveries, targets } = mountSupervisor({ digestIntervalMs: 5_000 })
    targets.set('agent-a', makeTarget('agent-a', deliveries))
    ctx.fleet.registerAgent('agent-a', 'dsh')
    const tasks: FleetTasksLike = {
      claimWake: () => {},
      list: () => [{ id: 't-1', state: 'Unstarted' }, { id: 't-2', state: 'Unstarted' }],
    }
    ctx.reflect.provide('fleetTasks', tasks)
    ctx.fleetBus.publish({ type: 'build.status', scope: 'fleet', actor: 'agent-a', payload: {} })

    clock.advance(5_001)
    const result = await supervisor.runTick()
    assertPass('digest emitted when the interval elapses', result.digestEmitted === true)
    const digests = eventsOf(ctx.fleetBus, 'fleet/digest')
    assertPass('fleet/digest published', digests.length === 1, JSON.stringify(digests))
    const summary = digests[0]!.payload as { activeCount: number; readyQueueLength: number; recentActivity: number }
    assertPass('digest carries registry counts',
      summary.activeCount === 1 && summary.readyQueueLength === 2,
      JSON.stringify(summary))
    assertPass('digest counts fleet-bus activity since the last digest',
      summary.recentActivity >= 1, JSON.stringify(summary))

    clock.advance(5_001)
    await supervisor.runTick()
    assertPass('digest is periodic (interval-gated)', eventsOf(ctx.fleetBus, 'fleet/digest').length === 2)
  }

  // ---- 9. verification-gated merge queue (#28): gate pass + gate fail ----
  {
    const { ctx, clock, supervisor, deliveries, targets } = mountSupervisor()
    targets.set('owner-1', makeTarget('owner-1', deliveries))
    supervisor.registerMergeGate('build.pass', { name: 'build.pass', kind: 'check', check: () => true })
    supervisor.registerMergeGate('tests.green', {
      name: 'tests.green', kind: 'check', check: (entry: MergeQueueEntry) => entry.sourceRef !== 'broken',
    })

    const good = supervisor.enqueueMerge({
      title: 'land feature', target: 'main', sourceRef: 'feat/a', ownerAgentId: 'owner-1', gateNames: ['build.pass', 'tests.green'],
    })
    await supervisor.runMergeScan()
    assertPass('passing gates merge the entry',
      good.status === 'merged' && good.attempts === 1,
      JSON.stringify(good))
    assertPass('fleet/merge-pass published',
      eventsOf(ctx.fleetBus, 'fleet/merge-pass').some(e => (e.payload as { id: string }).id === good.id))

    const bad = supervisor.enqueueMerge({
      title: 'land broken', target: 'main', sourceRef: 'broken', ownerAgentId: 'owner-1', gateNames: ['build.pass', 'tests.green'],
    })
    await supervisor.runMergeScan()
    assertPass('failing gate rejects the entry (isolated + failed)',
      bad.status === 'failed' && bad.isolated === true && bad.lastResult?.ok === false,
      JSON.stringify(bad))
    assertPass('fleet/merge-fail published with the failing gate + reason',
      eventsOf(ctx.fleetBus, 'fleet/merge-fail').some(e => {
        const p = e.payload as { id: string; gate: string }
        return p.id === bad.id && p.gate === 'tests.green'
      }),
      JSON.stringify(eventsOf(ctx.fleetBus, 'fleet/merge-fail').map(e => e.payload)))
    assertPass('failed entry re-dispatches a merge-fix wake to the owner',
      supervisor.listWakeQueue().some(e => e.kind === 'merge-fix' && e.targetAgentId === 'owner-1'),
      JSON.stringify(supervisor.listWakeQueue().map(e => ({ kind: e.kind, target: e.targetAgentId }))))
  }

  // ---- 10. events carry originKind 'supervisor' ----
  {
    const { ctx, supervisor } = mountSupervisor()
    supervisor.enqueueWake({ targetAgentId: 'ghost', kind: 'notify', context: {} })
    const queued = eventsOf(ctx.fleetBus, 'fleet/wake-queued')
    assertPass('supervisor events use originKind "supervisor"',
      queued.length === 1 && queued[0]!.originKind === SUPERVISOR_ORIGIN_KIND && queued[0]!.actor === 'supervisor',
      JSON.stringify(queued))
  }

  // ---- 11. wake queue store durability (reload preserves due-state) ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-wake-store-'))
    const store1 = new WakeQueueStore({ dir })
    store1.upsert({
      id: 'cron-1', targetAgentId: 'agent-a', dueAt: 1_000, kind: 'cron',
      context: { job: 'x' }, status: 'pending', createdAt: 900,
    })
    const store2 = new WakeQueueStore({ dir }) // new instance → reload from disk
    assertPass('wake queue survives restart with due-state',
      store2.list().length === 1 && store2.get('cron-1')!.status === 'pending' && store2.get('cron-1')!.dueAt === 1_000,
      JSON.stringify(store2.list()))
  }

  console.log('supervisor-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`supervisor-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
