/**
 * VERIFY (issue #26): fleet-bus smoke test.
 * Unit coverage for publish→subscriber routing (wake vs inject mode), filter
 * matching, replay correctness, store append/reload durability, plus one
 * integration-style smoke: two fake agents in ctx.fleetBus — A publishes, B
 * receives (delivery + mode asserted), replay returns the event. No live LLM.
 *
 * Run: pnpm test:bus  (or)  tsx tests/bus-smoke.ts
 * @module @hydra/dsh-fleet/tests/bus-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertPass, fakeClock } from './harness.ts'
import { apply as applyBus, type Config as BusConfig } from '../plugins/fleet-bus/src/index.ts'
import { FleetBusService, type FleetBusDeliveryTarget } from '../plugins/fleet-bus/src/service.ts'
import { FleetEventStore } from '../plugins/fleet-bus/src/store.ts'
import type { FleetBusEvent, FleetBusScope } from '../plugins/fleet-bus/src/types.ts'

interface CapturedDelivery {
  mode: 'wake' | 'inject'
  text: string
}

/** Extract the text of the single delivered message block. */
function deliveryText(message: UserMessage): string {
  const block = message.content[0]
  return block !== undefined && block.type === 'text' ? block.text : ''
}

/** A delivery target that records followup (wake) / inject (quiet) calls. */
function makeTarget(deliveries: CapturedDelivery[]): FleetBusDeliveryTarget {
  return {
    followup(message) { deliveries.push({ mode: 'wake', text: deliveryText(message) }) },
    inject(message) { deliveries.push({ mode: 'inject', text: deliveryText(message) }) },
  }
}

/** Mount fleet-bus on a fresh Context with a temp store and fake agents. */
function mountBus(overrides: Partial<BusConfig> = {}): {
  ctx: Context
  clock: ReturnType<typeof fakeClock>
  bus: FleetBusService
  deliveries: CapturedDelivery[]
  targets: Map<string, FleetBusDeliveryTarget>
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const deliveries: CapturedDelivery[] = []
  const targets = new Map<string, FleetBusDeliveryTarget>()
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-bus-')),
    clock,
    resolveAgent: agentId => targets.get(agentId),
    ...overrides,
  })
  assertPass('ctx.fleetBus is registered', ctx.fleetBus !== undefined)
  return { ctx, clock, bus, deliveries, targets }
}

async function main(): Promise<void> {
  console.log('bus-smoke: fleet-bus event store + publish/subscribe/replay + followup/inject delivery')

  // ---- 1. publish → subscriber routing: wake vs inject mode ----
  {
    const { bus, deliveries, targets } = mountBus()
    targets.set('agent-a', makeTarget(deliveries))
    targets.set('agent-b', makeTarget(deliveries))

    const sub = bus.subscribe('agent-b', { type: 'build.status' }, 'inject')
    const published = bus.publish({
      type: 'build.status',
      scope: 'fleet',
      actor: 'agent-a',
      payload: { ok: true },
    })

    assertPass('publish returns a fully-assigned event', published.id === 'build.status-1' && published.seq === 1)
    assertPass('inject-mode subscriber receives a quiet delivery',
      deliveries.length === 1 && deliveries[0]!.mode === 'inject',
      JSON.stringify(deliveries))
    assertPass('delivered text carries the event', deliveries[0]!.text.includes('build.status') && deliveries[0]!.text.includes('agent-a'))
    assertPass('non-subscriber (agent-a) receives nothing', deliveries.length === 1)
    assertPass('unsubscribe stops delivery', (bus.unsubscribe(sub.id) && deliveries.length === 1))

    const wakeSub = bus.subscribe('agent-b', { type: 'build.status' }, 'wake')
    bus.publish({ type: 'build.status', scope: 'fleet', actor: 'agent-a', payload: { ok: true } })
    assertPass('wake-mode subscriber receives a followup turn',
      deliveries.length === 2 && deliveries[1]!.mode === 'wake',
      JSON.stringify(deliveries))
    assertPass('subscription is registered for the right agent', wakeSub.agentId === 'agent-b')
  }

  // ---- 2. filter correctness (type + scope) ----
  {
    const { bus, deliveries, targets } = mountBus()
    targets.set('agent-b', makeTarget(deliveries))
    bus.subscribe('agent-b', { type: 'build.status', scope: 'team' }, 'inject')

    bus.publish({ type: 'build.status', scope: 'fleet', actor: 'agent-a', payload: {} })
    assertPass('scope mismatch is not delivered', deliveries.length === 0, JSON.stringify(deliveries))

    bus.publish({ type: 'task.done', scope: 'team', actor: 'agent-a', payload: {} })
    assertPass('type mismatch is not delivered', deliveries.length === 0, JSON.stringify(deliveries))

    bus.publish({ type: 'build.status', scope: 'team', actor: 'agent-a', payload: {} })
    assertPass('exact type+scope match is delivered', deliveries.length === 1 && deliveries[0]!.mode === 'inject')
  }

  // ---- 3. replay filter correctness (type / scope / since) ----
  {
    const { bus, clock } = mountBus()
    bus.publish({ type: 'build.status', scope: 'team', actor: 'agent-a', payload: { s: 1 } })
    clock.advance(100)
    bus.publish({ type: 'build.status', scope: 'fleet', actor: 'agent-a', payload: { s: 2 } })
    clock.advance(100)
    bus.publish({ type: 'task.done', scope: 'fleet', actor: 'agent-b', payload: { s: 3 } })

    const byType = bus.replay({ type: 'build.status' })
    assertPass('replay filters by type', byType.length === 2 && byType.every(e => e.type === 'build.status'), JSON.stringify(byType.map(e => e.seq)))
    const byScope = bus.replay({ scope: 'fleet' })
    assertPass('replay filters by scope', byScope.length === 2 && byScope.every(e => e.scope === 'fleet'))
    const since = bus.replay({}, clock.current() - 150)
    assertPass('replay filters by since (ts cutoff)',
      since.length === 2 && since.every(e => e.seq >= 2),
      JSON.stringify(since.map(e => ({ seq: e.seq, ts: e.ts }))))
    assertPass('replay preserves seq order', bus.replay().every((e, i) => e.seq === i + 1))
  }

  // ---- 4. store durability: append + reload (survives a new instance) ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bus-store-'))
    const store1 = new FleetEventStore({ dir })
    store1.append({
      id: 'build.status-1', type: 'build.status', scope: 'fleet', actor: 'agent-a', originKind: 'agent',
      payload: { ok: true }, ts: 1_000, seq: 1,
    })
    store1.append({
      id: 'task.done-2', type: 'task.done', scope: 'team', actor: 'agent-b', originKind: 'scheduler',
      payload: { ok: true }, ts: 1_100, seq: 2,
    })
    const store2 = new FleetEventStore({ dir }) // new instance → must reload from disk
    assertPass('store reloads persisted events', store2.list().length === 2 && store2.list()[1]!.seq === 2)
    const firstPayload = store2.list()[0]!.payload
    assertPass('store survives restart with full payload',
      typeof firstPayload === 'object' && firstPayload !== null && !Array.isArray(firstPayload)
        && firstPayload.ok === true && store2.list()[0]!.actor === 'agent-a')

    // Service-level seq continuity across a fresh service on the same store.
    const ctx = new CordisContext()
    const clock = fakeClock()
    const bus2 = new FleetBusService(ctx, { storeDir: dir, clock, resolveAgent: () => undefined })
    assertPass('fresh service replays persisted events', bus2.replay().length === 2)
    const continued = bus2.publish({ type: 'build.status', scope: 'fleet', actor: 'agent-a', payload: {} })
    assertPass('seq continues across restart', continued.seq === 3, `seq=${continued.seq}`)
  }

  // ---- 5. cordis event emission per publish ----
  {
    const { ctx, bus, targets } = mountBus()
    targets.set('agent-b', makeTarget([]))
    const seen: FleetBusEvent[] = []
    ctx.on('fleet-bus/event', (event) => { seen.push(event) })
    bus.publish({ type: 'build.status', scope: 'fleet', actor: 'agent-a', payload: {} })
    assertPass('fleet-bus/event emitted per publish', seen.length === 1 && seen[0]!.type === 'build.status')
  }

  // ---- 6. model-facing tools execute against the bus ----
  {
    const ctx = new CordisContext()
    const clock = fakeClock()
    const deliveries: CapturedDelivery[] = []
    const targets = new Map<string, FleetBusDeliveryTarget>()
    targets.set('agent-b', makeTarget(deliveries))
    const registered = new Map<string, ToolDefinition>()
    // Provide a stub tools registry so apply() can register the four tools
    // without composing the full ToolRuntime (which needs systemPrompt).
    ctx.reflect.provide('tools', {
      register(def: ToolDefinition): () => void {
        registered.set(def.name, def)
        return () => { registered.delete(def.name) }
      },
    } as never)

    applyBus(ctx, {
      storeDir: mkdtempSync(join(tmpdir(), 'fleet-bus-')),
      clock,
      resolveAgent: agentId => targets.get(agentId),
    } as never)

    assertPass('apply registers the four fleet-bus tools',
      ['fleet_publish', 'fleet_subscribe', 'fleet_unsubscribe', 'fleet_events'].every(n => registered.has(n)),
      JSON.stringify([...registered.keys()]))

    const exec = { agent: { id: 'agent-a', session: { id: 'agent-a' } } }
    const publish = registered.get('fleet_publish')!
    const pubResult = await publish.execute!({ type: 'build.status', payload: { ok: true }, scope: 'fleet' }, exec as never) as { id: string; seq: number }
    assertPass('fleet_publish publishes (actor defaults to caller)', pubResult.seq === 1 && pubResult.id === 'build.status-1')

    const subscribe = registered.get('fleet_subscribe')!
    const subResult = await subscribe.execute!({ type: 'build.status', mode: 'wake' }, exec as never) as { subscriptionId: string; agentId: string; mode: string }
    assertPass('fleet_subscribe creates a wake subscription for the caller', subResult.agentId === 'agent-a' && subResult.mode === 'wake')

    // Subscribe agent-b via the tool, then publish via the tool → delivery.
    await subscribe.execute!({ type: 'build.status', mode: 'inject', agentId: 'agent-b' }, exec as never)
    await publish.execute!({ type: 'build.status', payload: { ok: true } }, exec as never)
    assertPass('tool-published event reaches a tool-subscribed agent',
      deliveries.length === 1 && deliveries[0]!.mode === 'inject' && deliveries[0]!.text.includes('build.status'),
      JSON.stringify(deliveries))

    const events = registered.get('fleet_events')!
    const eventsResult = await events.execute!({ type: 'build.status' }, exec as never) as { count: number; events: FleetBusEvent[] }
    assertPass('fleet_events replays matching events', eventsResult.count === 2 && eventsResult.events.every(e => e.type === 'build.status'))

    const unsubscribe = registered.get('fleet_unsubscribe')!
    const unsubResult = await unsubscribe.execute!({ subscriptionId: subResult.subscriptionId }, exec as never) as { ok: boolean }
    assertPass('fleet_unsubscribe removes the subscription', unsubResult.ok === true)
  }

  // ---- 7. integration-style smoke: two fake agents, A → B ----
  {
    const { bus, deliveries, targets } = mountBus()
    targets.set('agent-a', makeTarget(deliveries))
    targets.set('agent-b', makeTarget(deliveries))

    // B subscribes for wake delivery on task events.
    bus.subscribe('agent-b', { type: 'task.done' }, 'wake')
    // A publishes a task-done event.
    const event = bus.publish({ type: 'task.done', scope: 'fleet', actor: 'agent-a', payload: { task: 'build' } })

    assertPass('integration: B received the event as a followup (wake)',
      deliveries.length === 1 && deliveries[0]!.mode === 'wake' && deliveries[0]!.text.includes('task.done'),
      JSON.stringify(deliveries))
    assertPass('integration: A (non-subscriber) received nothing', deliveries.length === 1)
    const replay = bus.replay({ type: 'task.done' })
    assertPass('integration: replay returns the published event',
      replay.length === 1 && replay[0]!.id === event.id && replay[0]!.actor === 'agent-a')
  }

  // ---- 8. originKind: every event carries it; subscribers can exclude it ----
  {
    const { bus, deliveries, targets } = mountBus()
    targets.set('agent-b', makeTarget(deliveries))

    const published = bus.publish({ type: 'build.status', scope: 'fleet', actor: 'agent-a', payload: {} })
    assertPass('originKind defaults to agent on every event', published.originKind === 'agent', `originKind=${published.originKind}`)
    const withKind = bus.publish({ type: 'build.status', scope: 'fleet', actor: 'sched-1', payload: {}, originKind: 'scheduler' })
    assertPass('originKind passes through the publisher value', withKind.originKind === 'scheduler')

    // A watchdog subscriber excludes its own mechanism so it can never trigger itself.
    bus.subscribe('agent-b', { type: 'watchdog.review', excludeOriginKinds: ['watchdog'] }, 'wake')
    bus.publish({ type: 'watchdog.review', scope: 'fleet', actor: 'watchdog-1', payload: {}, originKind: 'watchdog' })
    assertPass('originKind exclusion blocks self-triggered events', deliveries.length === 0, JSON.stringify(deliveries))
    bus.publish({ type: 'watchdog.review', scope: 'fleet', actor: 'agent-a', payload: {} }) // default originKind 'agent'
    assertPass('originKind exclusion still delivers other mechanisms', deliveries.length === 1 && deliveries[0]!.mode === 'wake')
  }

  // ---- 9. stop-fingerprint wake dedupe ----
  {
    const { bus, clock, deliveries, targets } = mountBus()
    targets.set('agent-b', makeTarget(deliveries))

    // Subscriber opts into a 1000 ms dedupe window for wake deliveries.
    bus.subscribe('agent-b', { type: 'watchdog.review' }, 'wake', { dedupeMs: 1000 })
    const trigger = { stoppedLeaves: ['a', 'b'], config: { retry: 3 } }

    bus.publish({ type: 'watchdog.review', scope: 'fleet', actor: 'sched-1', payload: trigger, originKind: 'scheduler', fingerprint: 'fp-stop-a' })
    assertPass('first wake with a fingerprint is delivered', deliveries.length === 1 && deliveries[0]!.mode === 'wake')
    bus.publish({ type: 'watchdog.review', scope: 'fleet', actor: 'sched-1', payload: trigger, originKind: 'scheduler', fingerprint: 'fp-stop-a' })
    assertPass('identical fingerprint within the window suppresses re-wake', deliveries.length === 1, JSON.stringify(deliveries))

    clock.advance(1100)
    bus.publish({ type: 'watchdog.review', scope: 'fleet', actor: 'sched-1', payload: trigger, originKind: 'scheduler', fingerprint: 'fp-stop-a' })
    assertPass('expired window allows the identical wake again', deliveries.length === 2, JSON.stringify(deliveries))

    bus.publish({ type: 'watchdog.review', scope: 'fleet', actor: 'sched-1', payload: trigger, originKind: 'scheduler', fingerprint: 'fp-stop-b' })
    assertPass('changed trigger state (new fingerprint) wakes', deliveries.length === 3, JSON.stringify(deliveries))

    // Without an explicit fingerprint the bus hashes the full payload.
    bus.subscribe('agent-b', { type: 'task.done' }, 'wake', { dedupeMs: 1000 })
    bus.publish({ type: 'task.done', scope: 'fleet', actor: 'agent-a', payload: { leaf: 1 } })
    bus.publish({ type: 'task.done', scope: 'fleet', actor: 'agent-a', payload: { leaf: 1 } })
    assertPass('identical payload (payload-hash fingerprint) suppresses re-wake', deliveries.length === 4, JSON.stringify(deliveries))
    bus.publish({ type: 'task.done', scope: 'fleet', actor: 'agent-a', payload: { leaf: 2 } })
    assertPass('changed payload produces a new wake', deliveries.length === 5, JSON.stringify(deliveries))
  }

  console.log('bus-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`bus-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
