/**
 * VERIFY: agent-to-agent (a2a) smoke test for the fleet.
 * End-to-end lifecycle: Lead creates → Dev claims → Dev completes → QA accepts
 * → Watchdog verifies. Validates bus events at each step, state transitions,
 * and cross-agent task flow through the shared queue. No live LLM.
 *
 * Run: npx tsx tests/a2a-smoke.ts
 * @module @hydra/dsh-fleet/tests/a2a-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { assertPass, fakeClock } from './harness.ts'
import {
  FleetTasksService,
  FLEET_TASK_EVENT_TYPES,
} from '../plugins/fleet-tasks/src/service.ts'
import type { FleetTaskEvidence } from '../plugins/fleet-tasks/src/types.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'
import { FleetWatchdogService } from '../plugins/fleet-watchdog/src/service.ts'

/** Mount fleet-tasks + fleet-bus + fleet-watchdog on one fresh Context. */
function mountFleet(): {
  ctx: Context
  clock: ReturnType<typeof fakeClock>
  tasks: FleetTasksService
  bus: FleetBusService
  watchdog: FleetWatchdogService
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-a2a-bus-')),
    clock,
    resolveAgent: () => undefined,
  })
  const tasks = new FleetTasksService(ctx, {
    dir: mkdtempSync(join(tmpdir(), 'fleet-a2a-tasks-')),
    clock,
  })
  const watchdog = new FleetWatchdogService(ctx, { clock })
  return { ctx, clock, tasks, bus, watchdog }
}

/** A contract whose pass range is exit-code == 0. */
function exitContract() {
  return { expectedResult: 'all tests pass, exit 0', metric: 'exit-code', passRange: '== 0' }
}

/** Evidence for a passing exit-code. */
function exitEvidence(result: string, by = 'dev-1'): FleetTaskEvidence {
  return { result, notes: 'ran the suite', artifacts: ['run-1'], submittedBy: by }
}

/** Bus events of one type. */
function eventsOf(bus: FleetBusService, type: string): FleetBusEvent[] {
  return bus.replay({ type })
}

async function main(): Promise<void> {
  console.log('a2a-smoke: agent-to-agent task lifecycle — lead→dev→qa→watchdog full flow')

  // ---- 1. full lifecycle: lead creates → dev-1 claims → dev-1 completes → qa accepts → watchdog verifies ----
  {
    const { ctx, clock, tasks, bus, watchdog } = mountFleet()

    // Step 1: Lead creates a task
    const created = tasks.create(
      { title: 'build the rig', severity: 'P1', artifactContract: exitContract() },
      'lead-1',
    )
    assertPass('lead creates task in Triage', created.state === 'Triage' && created.id.startsWith('task-'))
    assertPass('task carries the artifact contract', created.artifactContract?.passRange === '== 0')
    assertPass('fleet/task-created published', eventsOf(bus, FLEET_TASK_EVENT_TYPES.created).length === 1)
    assertPass('created event has originKind "task"',
      eventsOf(bus, FLEET_TASK_EVENT_TYPES.created)[0]!.originKind === 'task')
    assertPass('created event payload has task title',
      (eventsOf(bus, FLEET_TASK_EVENT_TYPES.created)[0]!.payload as { title?: string }).title === 'build the rig')

    // Step 2: Dev-1 claims the task
    const claim = tasks.claim(created.id, 'dev-1')
    assertPass('dev-1 claims the task', claim.ok === true && claim.token !== undefined)
    assertPass('task transitions to Started', claim.task?.state === 'Started')
    assertPass('task assigned to dev-1', claim.task?.assignee === 'dev-1')
    assertPass('execution lock held by dev-1',
      claim.task?.locks.length === 1 && claim.task!.locks[0]!.holder === 'dev-1')
    assertPass('fleet/task-claimed published', eventsOf(bus, FLEET_TASK_EVENT_TYPES.claimed).length === 1)
    assertPass('claimed event has originKind "task"',
      eventsOf(bus, FLEET_TASK_EVENT_TYPES.claimed)[0]!.originKind === 'task')

    // Step 3: Dev-1 completes the task
    clock.advance(1_000)
    const completed = tasks.complete(created.id, claim.token!, exitEvidence('0'), 'dev-1')
    assertPass('dev-1 completes with evidence', completed.state === 'Completed')
    assertPass('evidence stored with result 0', completed.evidence?.result === '0')
    assertPass('acceptance pending', completed.acceptance?.status === 'pending')
    assertPass('fleet/task-completed published', eventsOf(bus, FLEET_TASK_EVENT_TYPES.completed).length === 1)
    assertPass('completed event has originKind "task"',
      eventsOf(bus, FLEET_TASK_EVENT_TYPES.completed)[0]!.originKind === 'task')

    // Step 4: QA accepts the task
    clock.advance(1_000)
    const accepted = tasks.accept(created.id, {}, 'qa-1')
    assertPass('qa-1 accepts the task', accepted.accepted === true)
    assertPass('task stays Completed with acceptance accepted',
      accepted.task.state === 'Completed' && accepted.task.acceptance?.status === 'accepted')
    assertPass('fleet/task-accepted published', eventsOf(bus, FLEET_TASK_EVENT_TYPES.accepted).length === 1)
    assertPass('accepted event has originKind "task"',
      eventsOf(bus, FLEET_TASK_EVENT_TYPES.accepted)[0]!.originKind === 'task')

    // Step 5: Watchdog verifies the accepted task
    const taskAfterAccept = tasks.get(created.id)!
    assertPass('final task state is Completed', taskAfterAccept.state === 'Completed')
    assertPass('final acceptance is accepted', taskAfterAccept.acceptance?.status === 'accepted')

    // Bus event count: created + claimed + completed + accepted = 4
    const totalTaskEvents = bus.replay().filter(e =>
      e.type.startsWith('fleet/task-')).length
    assertPass('four fleet/task-* events published across the lifecycle', totalTaskEvents === 4,
      `totalTaskEvents=${totalTaskEvents}`)
  }

  // ---- 2. state transitions: verify each step's state is correct ----
  {
    const { clock, tasks } = mountFleet()

    const t = tasks.create({ title: 'state check', severity: 'P1', artifactContract: exitContract() }, 'lead-1')
    const states: string[] = [t.state]

    const c1 = tasks.claim(t.id, 'dev-1')
    states.push(c1.task!.state)

    clock.advance(500)
    const c2 = tasks.complete(t.id, c1.token!, exitEvidence('0'), 'dev-1')
    states.push(c2.state)

    const c3 = tasks.accept(t.id, {}, 'qa-1')
    states.push(c3.task.state)

    assertPass('state path: Triage → Started → Completed → Completed',
      states.join(' → ') === 'Triage → Started → Completed → Completed')
  }

  // ---- 3. atomic claim: two dev agents race, one wins ----
  {
    const { clock, tasks } = mountFleet()

    const created = tasks.create({ title: 'race condition', severity: 'P1', artifactContract: exitContract() }, 'lead-1')
    const first = tasks.claim(created.id, 'dev-1')
    const second = tasks.claim(created.id, 'dev-2')
    assertPass('dev-1 wins the race', first.ok === true && first.token !== undefined)
    assertPass('dev-2 is rejected (no double-claim)', second.ok === false && second.reason !== undefined)

    clock.advance(500)
    const completed = tasks.complete(created.id, first.token!, exitEvidence('0'), 'dev-1')
    assertPass('winner completes the task', completed.state === 'Completed')
    assertPass('task assigned to the winner', completed.assignee === 'dev-1')
  }

  // ---- 4. claimWake: dev-1 polls and picks up the task ----
  {
    const { tasks } = mountFleet({ resolveRole: (agentId) => agentId === 'dev-1' ? 'worker' : undefined })

    const empty = tasks.claimWake('dev-1', { kind: 'task-claim', agentId: 'dev-1' })
    assertPass('claimWake on empty queue returns ok:false',
      empty.ok === false && empty.reason === 'no claimable task')

    tasks.create({ title: 'wake test', severity: 'P1', claimRole: 'worker', artifactContract: exitContract() }, 'lead-1')
    const wake = tasks.claimWake('dev-1', { kind: 'task-claim', agentId: 'dev-1' })
    assertPass('claimWake picks up the worker-routed task',
      wake.ok === true && wake.task?.title === 'wake test')
    assertPass('claimWake assigns to the waking agent', wake.task?.assignee === 'dev-1')
  }

  // ---- 5. cordis events: each mutation emits fleet-tasks/event ----
  {
    const { ctx, clock, tasks } = mountFleet()
    const seen: { type: string; actor: string }[] = []
    ctx.on('fleet-tasks/event', (info) => { seen.push({ type: info.type, actor: info.actor }) })

    const created = tasks.create({ title: 'observable', severity: 'P1', artifactContract: exitContract() }, 'lead-1')
    tasks.claim(created.id, 'dev-1')
    clock.advance(100)
    tasks.complete(created.id, tasks.get(created.id)!.locks[0]!.token, exitEvidence('0'), 'dev-1')
    tasks.accept(created.id, {}, 'qa-1')

    assertPass('4 cordis events: created/claimed/completed/accepted',
      seen.length === 4
        && seen[0]!.type === FLEET_TASK_EVENT_TYPES.created
        && seen[1]!.type === FLEET_TASK_EVENT_TYPES.claimed
        && seen[2]!.type === FLEET_TASK_EVENT_TYPES.completed
        && seen[3]!.type === FLEET_TASK_EVENT_TYPES.accepted)
    assertPass('events carry correct actors',
      seen[0]!.actor === 'lead-1'
        && seen[1]!.actor === 'dev-1'
        && seen[2]!.actor === 'dev-1'
        && seen[3]!.actor === 'qa-1')
  }

  // ---- 6. bus replay: full lifecycle produces the expected event sequence ----
  {
    const { clock, tasks, bus } = mountFleet()

    const created = tasks.create({ title: 'sequence check', severity: 'P1', artifactContract: exitContract() }, 'lead-1')
    const claim = tasks.claim(created.id, 'dev-1')
    clock.advance(100)
    tasks.complete(created.id, claim.token!, exitEvidence('0'), 'dev-1')
    tasks.accept(created.id, {}, 'qa-1')

    const all = bus.replay()
    const taskEvents = all.filter(e => e.type.startsWith('fleet/task-'))
    const types = taskEvents.map(e => e.type)

    assertPass('event sequence: created → claimed → completed → accepted',
      types.join(', ') === [
        FLEET_TASK_EVENT_TYPES.created,
        FLEET_TASK_EVENT_TYPES.claimed,
        FLEET_TASK_EVENT_TYPES.completed,
        FLEET_TASK_EVENT_TYPES.accepted,
      ].join(', '))
    assertPass('all events carry originKind "task"',
      taskEvents.every(e => e.originKind === 'task'))
    assertPass('event seq is monotonically increasing',
      taskEvents.every((e, i) => e.seq === i + 1))
    assertPass('event timestamps are ordered',
      taskEvents.every((e, i) => i === 0 || e.ts >= taskEvents[i - 1]!.ts))
  }

  // ---- 7. watchdog verify: accepted task passes verification ----
  {
    const { ctx, clock, tasks, bus, watchdog } = mountFleet()

    const root = tasks.create({ title: 'verify goal', severity: 'P1' }, 'lead-1')
    const leaf = tasks.create({
      title: 'verify leaf',
      parentId: root.id,
      artifactContract: exitContract(),
    }, 'lead-1')
    watchdog.watch(root.id)

    const claim = tasks.claim(leaf.id, 'dev-1')
    clock.advance(500)
    tasks.complete(leaf.id, claim.token!, exitEvidence('0'), 'dev-1')

    const status = watchdog.status(root.id)!
    assertPass('watchdog verifies the tree after dev-1 completes',
      status.status === 'verified' && status.lastVerdict === 'PASS')
    assertPass('fleet/watchdog-stopped + fleet/watchdog-pass published',
      eventsOf(bus, 'fleet/watchdog-stopped').length === 1
        && eventsOf(bus, 'fleet/watchdog-pass').length === 1)
    assertPass('leaf stays Completed after verification',
      tasks.get(leaf.id)!.state === 'Completed')
  }

  console.log('a2a-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`a2a-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
