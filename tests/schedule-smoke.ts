/**
 * VERIFY (fleet-schedule system): schedule-service + schedule-store +
 * fleet-schedule plugin + fleet-agent heartbeat tools.
 *
 * Unit coverage: every/maxRuns/expiresAt cadences, tick execution + delivery
 * via ctx.fleet.sendMessage, run history (last 20) + runCount, auto-pause,
 * pause/resume/update/delete/runOnce, ownership enforcement, the simple
 * 5-field cron parser (wildcards/lists/ranges/steps/names/dom-dow OR rule/
 * timezone), JSON persistence reload, atomic store writes, bus events
 * (fleet/schedule-created / -executed / -deleted, originKind 'schedule'),
 * and the seven fleet_heartbeat_* tools injected by fleet-agent. No live LLM.
 *
 * Run: tsx tests/schedule-smoke.ts
 * @module @hydra/dsh-fleet/tests/schedule-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertPass, fakeClock } from './harness.ts'
import { apply as applySchedule, Config as SchedulePluginConfig } from '../plugins/fleet-schedule/src/index.ts'
import { apply as applyAgent, FLEET_AGENT_TOOL_NAMES } from '../plugins/fleet-agent/src/index.ts'
import { apply as applyHeartbeat } from '../plugins/fleet-heartbeat/src/index.ts'
import { ScheduleService, FLEET_SCHEDULE_EVENT_TYPES, SCHEDULER_AGENT_ID, nextCronAfter, scheduleToJson } from '../src/schedule-service.ts'
import { ScheduleStore } from '../src/schedule-store.ts'
import type { ScheduleCadence, ScheduleRecord } from '../src/types.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'

/** Mount the schedule SERVICE directly on a fresh Context (no timer plugin). */
function mountSchedule(overrides: { home?: string; clock?: ReturnType<typeof fakeClock> } = {}): {
  ctx: Context
  clock: ReturnType<typeof fakeClock>
  schedules: ScheduleService
} {
  const clock = overrides.clock ?? fakeClock()
  const ctx = new CordisContext()
  const schedules = new ScheduleService(ctx, {
    dir: overrides.home ?? mkdtempSync(join(tmpdir(), 'fleet-schedule-')),
    clock,
  })
  assertPass('ScheduleService registers ctx.fleetSchedule', ctx.fleetSchedule !== undefined)
  return { ctx, clock, schedules }
}

/** Mount schedule + fleet-heartbeat + fleet-bus together (delivery + events). */
function mountFleet(): {
  ctx: Context
  clock: ReturnType<typeof fakeClock>
  schedules: ScheduleService
  bus: FleetBusService
  received: string[]
} {
  const clock = fakeClock(66_000) // 66 s after epoch 0 → every 60s cadence lands at 120s
  const ctx = new CordisContext()
  applyHeartbeat(ctx, { stallThresholdMs: 10 * 60 * 1000, tickMs: 30_000, clock })
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-bus-')),
    clock,
    resolveAgent: () => undefined,
  })
  const schedules = new ScheduleService(ctx, { dir: mkdtempSync(join(tmpdir(), 'fleet-schedule-')), clock })
  const received: string[] = []
  ctx.fleet.ensureAgent('agent-a', 'dsh', {
    onMessage: (message) => { received.push(message.text) },
  })
  return { ctx, clock, schedules, bus, received }
}

/** A helper to build an 'every'-cadence heartbeat targeting agent-a. */
function everyBeat(prompt = 'check in', everyMs = 60_000, patch: Record<string, unknown> = {}): Parameters<ScheduleService['create']>[0] {
  return {
    prompt,
    target: { type: 'agent', agentId: 'agent-a' },
    cadence: { type: 'every', everyMs },
    ...patch,
  }
}

async function main(): Promise<void> {
  console.log('schedule-smoke: fleet schedule system — service verbs, tick delivery, cron parser, persistence, events, tools')

  // ---- 1. create: every cadence, initial scheduling, validation ----
  {
    const { schedules, clock } = mountSchedule()
    const created = schedules.create(everyBeat(), 'agent-a')
    assertPass('create returns an active schedule with a generated id', created.status === 'active' && created.id.startsWith('schedule-'))
    assertPass('create schedules the first run at now + everyMs', created.nextRunAt === clock.current() + 60_000, String(created.nextRunAt))
    assertPass('create seeds empty run history', created.runCount === 0 && created.runs.length === 0)
    assertPass('create records the target agent', created.target.agentId === 'agent-a')
    assertPass('create names the schedule or null', created.name === null)

    let threw = captureThrow(() => schedules.create(everyBeat(''), 'agent-a'))
    assertPass('create rejects an empty prompt', threw !== null)
    threw = captureThrow(() => schedules.create({ ...everyBeat(), cadence: { type: 'every', everyMs: 0 } }, 'agent-a'))
    assertPass('create rejects non-positive everyMs', threw !== null)
    threw = captureThrow(() => schedules.create({ ...everyBeat(), cadence: { type: 'cron', expression: 'not-cron' } }, 'agent-a'))
    assertPass('create rejects an invalid cron expression', threw !== null && String(threw).includes('cron'))
    threw = captureThrow(() => schedules.create(everyBeat('x', 60_000, { maxRuns: 0 }), 'agent-a'))
    assertPass('create rejects non-positive maxRuns', threw !== null)
    threw = captureThrow(() => schedules.create(everyBeat('x', 60_000, { expiresInMs: -500 }), 'agent-a')) // negative → expires in the past
    assertPass('create rejects an already-past relative expiry', threw !== null)
    threw = captureThrow(() => schedules.create(everyBeat('x', 60_000, { expiresAt: 1_000_000, expiresInMs: 1_000 }), 'agent-a'))
    assertPass('create rejects ambiguous expiresAt+expiresInMs', threw !== null)
  }

  // ---- 2. tick execution: due → run recorded + prompt delivered via ctx.fleet ----
  {
    const { schedules, clock, received } = mountFleet()
    const created = schedules.create(everyBeat('pay attention', 60_000), 'agent-a')
    const before = clock.current()

    clock.advance(59_000)
    const early = schedules.runTick()
    assertPass('tick before the due time executes nothing', early.executed.length === 0 && received.length === 0)

    clock.advance(1_000) // exactly due (before = 66_000 → due at 126_000)
    const due = schedules.runTick()
    assertPass('tick at the due time executes the schedule', due.executed.length === 1 && due.executed[0]!.id === created.id)
    assertPass('the prompt was delivered via ctx.fleet.sendMessage', received.length === 1 && received[0] === 'pay attention', JSON.stringify(received))

    const after = schedules.inspect(created.id)!
    assertPass('execution records a succeeded run', after.runs.length === 1 && after.runs[0]!.status === 'succeeded')
    assertPass('runCount accumulates', after.runCount === 1)
    assertPass('lastRunAt is stamped', after.lastRunAt === due.executed[0]!.lastRunAt)
    assertPass('nextRunAt advances past the run', after.nextRunAt !== null && after.nextRunAt > due.executed[0]!.lastRunAt!, String(after.nextRunAt))

    clock.advance(60_000)
    schedules.runTick()
    const second = schedules.inspect(created.id)!
    assertPass('a second due run is recorded', second.runCount === 2 && second.runs.length === 2)
  }

  // ---- 3. target not registered → failed run logged and skipped ----
  {
    // Fleet composed, target absent: requirement "target must exist in the
    // fleet registry; if not, log warning and skip".
    const { schedules, clock } = mountFleet()
    const created = schedules.create(everyBeat('ghost target', 60_000, { target: { type: 'agent', agentId: 'ghost-agent' } }), 'ghost-agent')
    clock.advance(60_000)
    const tick = schedules.runTick()
    const after = schedules.inspect(created.id)!
    assertPass('missing fleet target does not throw; tick reports the run', tick.executed.length === 1)
    assertPass('missing fleet target records a failed run with reason', after.runs[0]!.status === 'failed' && String(after.runs[0]!.error).includes('not registered'), String(after.runs[0]!.error))

    // No fleet composed at all: same skip, different reason.
    const { schedules: bare, clock: bareClock } = mountSchedule()
    const lonely = bare.create(everyBeat('no fleet', 60_000, { target: { type: 'agent', agentId: 'nobody' } }), 'nobody')
    bareClock.advance(60_000)
    bare.runTick()
    assertPass('absent fleet service records a failed run (cannot deliver)',
      bare.inspect(lonely.id)!.runs[0]!.status === 'failed' && String(bare.inspect(lonely.id)!.runs[0]!.error).includes('fleet service not composed'))
  }

  // ---- 4. maxRuns auto-pause ----
  {
    const { schedules, clock } = mountFleet()
    schedules.create(everyBeat('limited', 60_000, { maxRuns: 2 }), 'agent-a')
    for (const step of [1, 2]) {
      clock.advance(60_000)
      schedules.runTick()
      const record = schedules.getByAgent('agent-a')[0]!
      assertPass(`run ${step} executes`, record.runCount === step, JSON.stringify({ step, runCount: record.runCount }))
    }
    const afterFirstTwo = schedules.getByAgent('agent-a')[0]!
    assertPass('the run that reaches maxRuns auto-pauses the schedule immediately',
      afterFirstTwo.status === 'paused' && afterFirstTwo.nextRunAt === null, JSON.stringify({ status: afterFirstTwo.status, runCount: afterFirstTwo.runCount }))
    clock.advance(60_000)
    schedules.runTick()
    const afterMore = schedules.getByAgent('agent-a')[0]!
    assertPass('a paused schedule never runs again', afterMore.runCount === 2 && afterMore.status === 'paused')
  }

  // ---- 5. expiresAt auto-pause ----
  {
    const { schedules, clock } = mountFleet()
    const created = schedules.create(everyBeat('short lived', 60_000, { expiresInMs: 90_000 }), 'agent-a')
    assertPass('create computes expiresAt from expiresInMs', created.expiresAt === clock.current() + 90_000)
    clock.advance(60_000)
    schedules.runTick()
    assertPass('one run happens before expiry', schedules.inspect(created.id)!.runCount === 1)
    clock.advance(60_000) // now beyond expiresAt
    const tick = schedules.runTick()
    assertPass('expired schedule auto-pauses without running', tick.paused.length === 1 && tick.executed.length === 0)
    const paused = schedules.inspect(created.id)!
    assertPass('auto-paused by expiry keeps its run history', paused.status === 'paused' && paused.runCount === 1 && paused.nextRunAt === null)
  }

  // ---- 6. pause / resume ----
  {
    const { schedules, clock } = mountFleet()
    const created = schedules.create(everyBeat('toggle me'), 'agent-a')
    const paused = schedules.pause(created.id, 'agent-a')
    assertPass('pause sets status + pausedAt + clears nextRunAt', paused.status === 'paused' && paused.pausedAt !== null && paused.nextRunAt === null)
    clock.advance(60_000)
    const tick = schedules.runTick()
    assertPass('a paused schedule never fires', tick.executed.length === 0 && schedules.inspect(created.id)!.runCount === 0)
    let threw = captureThrow(() => schedules.pause(created.id, 'agent-a'))
    assertPass('pausing an already-paused schedule throws', threw !== null)
    const resumed = schedules.resume(created.id, 'agent-a')
    assertPass('resume restores active + recomputes nextRunAt from now', resumed.status === 'active' && resumed.nextRunAt === clock.current() + 60_000)
    clock.advance(60_000)
    schedules.runTick()
    assertPass('resumed schedule fires again', schedules.inspect(created.id)!.runCount === 1)
    threw = captureThrow(() => schedules.resume(created.id, 'agent-a'))
    assertPass('resuming an active schedule throws', threw !== null)
  }

  // ---- 7. update: prompt / name / cadence ----
  {
    const { schedules, clock } = mountFleet()
    const created = schedules.create(everyBeat('old prompt', 60_000), 'agent-a')
    clock.advance(10_000)
    const updated = schedules.update(created.id, 'agent-a', { prompt: 'new prompt', name: 'reports' })
    assertPass('update changes prompt + adds name', updated.prompt === 'new prompt' && updated.name === 'reports')
    assertPass('update keeps the cadence-derived nextRunAt when cadence unchanged', updated.nextRunAt === created.nextRunAt)

    const reCadenced = schedules.update(created.id, 'agent-a', { cadence: { type: 'every', everyMs: 30_000 } })
    assertPass('cadence change recomputes nextRunAt from now', reCadenced.nextRunAt === clock.current() + 30_000, String(reCadenced.nextRunAt))
    const renamed = schedules.update(created.id, 'agent-a', { name: null })
    assertPass('update can clear the name', renamed.name === null)
    let threw = captureThrow(() => schedules.update(created.id, 'agent-b', { prompt: 'steal' }))
    assertPass('update enforces ownership', threw !== null && String(threw).includes('belongs to'))
  }

  // ---- 8. runOnce: immediate execution without shifting the cadence ----
  {
    const { schedules, clock, received } = mountFleet()
    const created = schedules.create(everyBeat('manual ping', 60_000), 'agent-a')
    clock.advance(5_000)
    const ran = schedules.runOnce(created.id, 'agent-a')
    assertPass('runOnce executes immediately', received.length === 1 && received[0] === 'manual ping')
    assertPass('runOnce records the run', ran.runCount === 1 && ran.runs[0]!.status === 'succeeded')
    assertPass('runOnce leaves the normal cadence untouched', ran.nextRunAt === created.nextRunAt, String(ran.nextRunAt))
    const final = schedules.create(everyBeat('final', 60_000, { maxRuns: 1 }), 'agent-a')
    const firstRun = schedules.runOnce(final.id, 'agent-a')
    assertPass('runOnce honors maxRuns=1 with its single run and auto-pauses', firstRun.runCount === 1 && firstRun.status === 'paused', JSON.stringify({ runCount: firstRun.runCount, status: firstRun.status }))
    let threw = captureThrow(() => schedules.runOnce(final.id, 'agent-a')) // paused → refuse
    assertPass('runOnce refuses once maxRuns is reached (auto-paused)', threw !== null && String(threw).includes('paused'), String(threw))
  }

  // ---- 9. delete + ownership ----
  {
    const { schedules } = mountSchedule()
    const created = schedules.create(everyBeat('bye'), 'agent-a')
    let threw = captureThrow(() => schedules.delete(created.id, 'agent-b'))
    assertPass('delete enforces ownership (must own)', threw !== null)
    const removed = schedules.delete(created.id, 'agent-a')
    assertPass('delete returns the removed id', removed.id === created.id)
    assertPass('delete removes the record', schedules.inspect(created.id) === undefined && schedules.list().length === 0)
    threw = captureThrow(() => schedules.delete(created.id, 'agent-a'))
    assertPass('delete of an unknown id throws', threw !== null)
  }

  // ---- 10. list / inspect / getByAgent ----
  {
    const { schedules } = mountSchedule()
    schedules.create(everyBeat('a1'), 'agent-a')
    schedules.create(everyBeat('a2'), 'agent-a')
    schedules.create(everyBeat('b1', 60_000, { target: { type: 'agent', agentId: 'agent-b' } }), 'agent-b')
    assertPass('list() returns every schedule', schedules.list().length === 3)
    assertPass('list(agentId) filters by target', schedules.list('agent-a').length === 2)
    assertPass('getByAgent returns the agent heartbeats', schedules.getByAgent('agent-b').length === 1)
    assertPass('inspect returns the full record', schedules.inspect(schedules.getByAgent('agent-a')[0]!.id)?.prompt === 'a1')
    assertPass('inspect of an unknown id is undefined', schedules.inspect('schedule-missing') === undefined)
    assertPass('scheduleToJson is JSON-serializable', JSON.parse(JSON.stringify(scheduleToJson(schedules.getByAgent('agent-a')[0]!))).id === schedules.getByAgent('agent-a')[0]!.id)
  }

  // ---- 11. run-history cap: keep the last 20 runs ----
  {
    const { schedules, clock } = mountFleet()
    schedules.create(everyBeat('long tail', 1_000), 'agent-a')
    for (let i = 0; i < 25; i++) {
      clock.advance(1_000)
      schedules.runTick()
    }
    const record = schedules.getByAgent('agent-a')[0]!
    assertPass('run history is capped at the last 20 runs', record.runs.length === 20 && record.runs[0]!.id !== record.runs[19]!.id && record.runs[19]!.scheduledFor === clock.current(), JSON.stringify({ len: record.runs.length, first: record.runs[0]!.scheduledFor, last: record.runs[19]!.scheduledFor, now: clock.current() }))
    assertPass('runCount keeps the full cumulative count', record.runCount === 25)
  }

  // ---- 12. cron parser: next-occurrence arithmetic ----
  {
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
    assertPass('every-minute cron nexts to the next whole minute', nextCronAfter('* * * * *', undefined, t0) === t0 + 60_000)
    assertPass('step minutes align to the step grid', nextCronAfter('*/15 * * * *', undefined, t0 + 5 * 60_000) === t0 + 15 * 60_000)
    assertPass('list field: next matching minute in the set', nextCronAfter('15,45 0 * * *', undefined, t0 + 20 * 60_000) === t0 + 45 * 60_000)
    assertPass('range field', nextCronAfter('0-2 0 * * *', undefined, t0) === t0 + 60_000) // strictly after 00:00
    assertPass('named month + year rollover', nextCronAfter('0 0 1 JAN *', undefined, Date.UTC(2026, 5, 15)) === Date.UTC(2027, 0, 1))
    assertPass('day-of-week restriction', nextCronAfter('0 12 * * MON', undefined, Date.UTC(2026, 0, 1, 13)) === Date.UTC(2026, 0, 5, 12)) // Jan 5 2026 IS a Monday
    assertPass('dom/dow OR rule (both restricted)', nextCronAfter('0 0 15 * WED', undefined, Date.UTC(2026, 0, 1)) === Date.UTC(2026, 0, 7)) // the first Wednesday (Jan 7) precedes the 15th → OR rule wins
    assertPass('strictly-after semantics', nextCronAfter('* * * * *', undefined, t0) > t0)
    assertPass('invalid cron throws', captureThrow(() => nextCronAfter('0 0 * *', undefined, t0)) !== null)
    assertPass('out-of-range field throws', captureThrow(() => nextCronAfter('61 * * * *', undefined, t0)) !== null)
    assertPass('unknown month name throws', captureThrow(() => nextCronAfter('0 0 1 FOOBAR *', undefined, t0)) !== null)
    assertPass('timezone-aware cron (EST winter = UTC-5)', nextCronAfter('0 12 * * *', 'America/New_York', Date.UTC(2026, 0, 1, 0, 0, 0)) === Date.UTC(2026, 0, 1, 17, 0, 0))
    assertPass('unknown timezone throws', captureThrow(() => nextCronAfter('0 12 * * *', 'Nowhere/Zone', t0)) !== null)
  }

  // ---- 13. cron execution through the tick ----
  {
    const clock = fakeClock(Date.UTC(2026, 0, 1, 0, 0, 0))
    const { schedules } = mountSchedule({ clock })
    const created = schedules.create({ prompt: 'hourly', target: { type: 'agent', agentId: 'agent-x' }, cadence: { type: 'cron', expression: '*/1 * * * *' } }, 'agent-x')
    assertPass('cron create schedules the next whole minute', created.nextRunAt === Date.UTC(2026, 0, 1, 0, 1, 0), String(created.nextRunAt))
    clock.advance(60_000)
    const tick = schedules.runTick()
    assertPass('cron schedule fires at its due minute', tick.executed.length === 1)
    const after = schedules.inspect(created.id)!
    assertPass('cron schedule records a failed run (target unregistered) and advances', after.runs.length === 1 && after.nextRunAt === Date.UTC(2026, 0, 1, 0, 2, 0))
  }

  // ---- 14. persistence: JSON store survives a reload ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-schedule-store-'))
    const clock = fakeClock()
    const svc1 = new ScheduleService(new CordisContext(), { dir, clock })
    const created = svc1.create(everyBeat('durable'), 'agent-a')
    clock.advance(60_000)
    const ranOnce = svc1.runOnce(created.id, 'agent-a')
    assertPass('the store file exists after a mutation', new ScheduleStore({ dir }).path.length > 0)

    const svc2 = new ScheduleService(new CordisContext(), { dir, clock })
    const reloaded = svc2.getByAgent('agent-a')
    assertPass('reload reads the persisted schedule back', reloaded.length === 1 && reloaded[0]!.id === created.id)
    assertPass('reload preserves prompt + cadence + run history',
      reloaded[0]!.prompt === 'durable' && reloaded[0]!.cadence.type === 'every' && reloaded[0]!.runs.length === 1 && reloaded[0]!.runCount === 1)
    assertPass('reload preserves run status', reloaded[0]!.runs[0]!.status === ranOnce.runs[0]!.status)
  }

  // ---- 15. bus + cordis events ----
  {
    const { ctx, schedules, clock, bus } = mountFleet()
    const seen: { type: string; schedule: ScheduleRecord; actor: string }[] = []
    ctx.on('fleet-schedule/event', (info) => { seen.push(info) })

    const created = schedules.create(everyBeat('eventful'), 'agent-a')
    clock.advance(60_000)
    schedules.runTick()
    schedules.delete(created.id, 'agent-a')

    const byType = (type: string): FleetBusEvent[] => bus.replay({ type })
    assertPass('fleet/schedule-created published', byType(FLEET_SCHEDULE_EVENT_TYPES.created).length === 1)
    assertPass('fleet/schedule-executed published', byType(FLEET_SCHEDULE_EVENT_TYPES.executed).length === 1)
    assertPass('fleet/schedule-deleted published', byType(FLEET_SCHEDULE_EVENT_TYPES.deleted).length === 1)
    assertPass('events carry originKind "schedule" (mechanism separation)', byType(FLEET_SCHEDULE_EVENT_TYPES.created)[0]!.originKind === 'schedule')
    assertPass('executed event carries the run result',
      (byType(FLEET_SCHEDULE_EVENT_TYPES.executed)[0]!.payload as { run?: { status?: string } }).run?.status === 'succeeded')
    assertPass('executed event actor is the scheduler identity', byType(FLEET_SCHEDULE_EVENT_TYPES.executed)[0]!.actor === SCHEDULER_AGENT_ID)
    assertPass('created/deleted actors are the owning agent', byType(FLEET_SCHEDULE_EVENT_TYPES.created)[0]!.actor === 'agent-a')
    assertPass('cordis event emitted per mutation', seen.length === 3 && seen[0]!.type === FLEET_SCHEDULE_EVENT_TYPES.created && seen[1]!.type === FLEET_SCHEDULE_EVENT_TYPES.executed && seen[2]!.type === FLEET_SCHEDULE_EVENT_TYPES.deleted)
  }

  // ---- 16. plugin apply: config defaults + registration ----
  {
    const ctx = new CordisContext()
    applySchedule(ctx, { home: mkdtempSync(join(tmpdir(), 'fleet-schedule-plugin-')), clock: fakeClock() } as never)
    assertPass('plugin apply registers ctx.fleetSchedule', ctx.fleetSchedule !== undefined)
    assertPass('plugin Config schema defaults tickMs to 1000', SchedulePluginConfig !== undefined)
    assertPass('schedule event vocabulary uses the required names', [
      FLEET_SCHEDULE_EVENT_TYPES.created,
      FLEET_SCHEDULE_EVENT_TYPES.executed,
      FLEET_SCHEDULE_EVENT_TYPES.deleted,
    ].every(type => type.startsWith('fleet/schedule-')))
  }

  // ---- 17. fleet-agent heartbeat tools ----
  {
    const scheduleNames = [
      'fleet_heartbeat_create', 'fleet_heartbeat_update', 'fleet_heartbeat_delete',
      'fleet_heartbeat_list', 'fleet_heartbeat_pause', 'fleet_heartbeat_resume',
      'fleet_heartbeat_run_once',
    ]
    assertPass('FLEET_AGENT_TOOL_NAMES carries the seven heartbeat tools',
      scheduleNames.every(n => (FLEET_AGENT_TOOL_NAMES as readonly string[]).includes(n)),
      FLEET_AGENT_TOOL_NAMES.join(','))

    const clock = fakeClock()
    const ctx = new CordisContext()
    applySchedule(ctx, { home: mkdtempSync(join(tmpdir(), 'fleet-schedule-tool-')), clock } as never)
    applyAgent(ctx, {
      home: mkdtempSync(join(tmpdir(), 'fleet-agent-tool-')),
      tools: [...FLEET_AGENT_TOOL_NAMES],
      autoRegisterAgents: true,
      injectTools: true,
    } as never)

    const registered = new Map<string, ToolDefinition>()
    const fakeAgentCtx = {
      tools: {
        register(def: ToolDefinition): () => void {
          registered.set(def.name, def)
          return () => { registered.delete(def.name) }
        },
      },
      get: () => undefined,
    }
    const fakeAgent = { id: 'agent-a', session: { id: 'agent-a', header: {} }, ctx: fakeAgentCtx }
    ctx.emit('agent/created', { agent: fakeAgent } as never)

    assertPass('agent/created injects the seven heartbeat tools onto the agent scope',
      scheduleNames.every(n => registered.has(n)),
      JSON.stringify([...registered.keys()]))

    const execA = { agent: { id: 'agent-a', session: { id: 'agent-a', header: {} } } }
    const create = registered.get('fleet_heartbeat_create')!
    const createdRes = await create.execute!({
      name: 'standup',
      prompt: 'daily standup',
      cadence: { type: 'every', everyMs: 86_400_000 },
    }, execA as never) as { schedule: ScheduleRecord }
    const id = createdRes.schedule.id
    assertPass('fleet_heartbeat_create creates a heartbeat for the caller',
      createdRes.schedule.target.agentId === 'agent-a' && createdRes.schedule.status === 'active')

    const list = registered.get('fleet_heartbeat_list')!
    const listRes = await list.execute!({}, execA as never) as { schedules: ScheduleRecord[] }
    assertPass('fleet_heartbeat_list returns only the caller heartbeats', listRes.schedules.length === 1 && listRes.schedules[0]!.id === id)

    const runOnce = registered.get('fleet_heartbeat_run_once')!
    const runRes = await runOnce.execute!({ id }, execA as never) as { schedule: ScheduleRecord }
    assertPass('fleet_heartbeat_run_once executes immediately (failed run: no fleet mounted)', runRes.schedule.runCount === 1 && runRes.schedule.runs[0]!.status === 'failed')

    const update = registered.get('fleet_heartbeat_update')!
    const updateRes = await update.execute!({ id, prompt: 'updated standup' }, execA as never) as { schedule: ScheduleRecord }
    assertPass('fleet_heartbeat_update patches the prompt', updateRes.schedule.prompt === 'updated standup')

    const pause = registered.get('fleet_heartbeat_pause')!
    const pauseRes = await pause.execute!({ id }, execA as never) as { schedule: ScheduleRecord }
    assertPass('fleet_heartbeat_pause pauses the caller heartbeat', pauseRes.schedule.status === 'paused')

    const resume = registered.get('fleet_heartbeat_resume')!
    const resumeRes = await resume.execute!({ id }, execA as never) as { schedule: ScheduleRecord }
    assertPass('fleet_heartbeat_resume re-activates the heartbeat', resumeRes.schedule.status === 'active')

    // Ownership: a second agent cannot delete the first's heartbeat.
    const registeredB = new Map<string, ToolDefinition>()
    const fakeAgentB = { id: 'agent-b', session: { id: 'agent-b', header: {} }, ctx: {
      tools: { register(def: ToolDefinition): () => void { registeredB.set(def.name, def); return () => {} } },
      get: () => undefined,
    } }
    ctx.emit('agent/created', { agent: fakeAgentB } as never)
    const deleteB = registeredB.get('fleet_heartbeat_delete')!
    const stole = await deleteB.execute!({ id }, { agent: { id: 'agent-b', session: { id: 'agent-b', header: {} } } } as never)
      .then(() => false, () => true)
    assertPass('fleet_heartbeat_delete rejects another agent (must own)', stole === true)

    const del = registered.get('fleet_heartbeat_delete')!
    const delRes = await del.execute!({ id }, execA as never) as { id: string }
    assertPass('fleet_heartbeat_delete removes the owner heartbeat', delRes.id === id && ctx.fleetSchedule.getByAgent('agent-a').length === 0)

    // Tools without the schedule plugin → descriptive error.
    const alone = new CordisContext()
    applyAgent(alone, {
      home: mkdtempSync(join(tmpdir(), 'fleet-agent-alone-')),
      tools: [...FLEET_AGENT_TOOL_NAMES],
      autoRegisterAgents: true,
      injectTools: true,
    } as never)
    const registeredAlone = new Map<string, ToolDefinition>()
    alone.emit('agent/created', { agent: { id: 'solo', session: { id: 'solo', header: {} }, ctx: {
      tools: { register(def: ToolDefinition): () => void { registeredAlone.set(def.name, def); return () => {} } },
      get: () => undefined,
    } } } as never)
    const noSvc = await registeredAlone.get('fleet_heartbeat_create')!.execute!(
      { prompt: 'x', cadence: { type: 'every', everyMs: 1000 } },
      { agent: { id: 'solo', session: { id: 'solo', header: {} } } } as never,
    ).then(() => false, (error: unknown) => String(error).includes('fleet-schedule'))
    assertPass('heartbeat tools fail with a clear message when the schedule plugin is absent', noSvc === true)
  }

  console.log('schedule-smoke: ALL PASS')
}

function captureThrow(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

void main().catch((error: unknown) => {
  console.error(`schedule-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
