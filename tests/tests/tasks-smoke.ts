/**
 * VERIFY (issue #26): fleet-tasks smoke test.
 * Unit coverage for the V3 flagship queue: full lifecycle, atomic claim,
 * severity escalation, sub-issue auto-close, false-done rejection, persistence
 * reload, the claimWake seam, the six model-facing tools, and the
 * bus/identity event contract (originKind 'task' + signed events). No live LLM.
 *
 * Run: pnpm test:tasks  (or)  tsx tests/tasks-smoke.ts
 * @module @hydra/dsh-fleet/tests/tasks-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertPass, fakeClock } from './harness.ts'
import { apply as applyTasks, type Config as TasksConfig } from '../plugins/fleet-tasks/src/index.ts'
import {
  FleetTasksService,
  FLEET_TASK_EVENT_TYPES,
  type FleetTasksConfig,
} from '../plugins/fleet-tasks/src/service.ts'
import { FleetTaskStore } from '../plugins/fleet-tasks/src/store.ts'
import type { FleetTask, FleetTaskEvidence } from '../plugins/fleet-tasks/src/types.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'
import { FleetAgentService, type FleetSignedEvent } from '../plugins/fleet-agent/src/service.ts'

/** Mount fleet-tasks on a fresh Context with a temp SQLite store + fake clock. */
function mountTasks(overrides: Partial<FleetTasksConfig> = {}): {
  ctx: Context
  clock: ReturnType<typeof fakeClock>
  tasks: FleetTasksService
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const tasks = new FleetTasksService(ctx, {
    dir: mkdtempSync(join(tmpdir(), 'fleet-tasks-')),
    clock,
    ...overrides,
  })
  assertPass('ctx.fleetTasks is registered', ctx.fleetTasks !== undefined)
  return { ctx, clock, tasks }
}

/** Mount fleet-tasks + a REAL fleet-bus on the same Context (event integration). */
function mountTasksWithBus(): {
  ctx: Context
  clock: ReturnType<typeof fakeClock>
  tasks: FleetTasksService
  bus: FleetBusService
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-bus-')),
    clock,
    resolveAgent: () => undefined,
  })
  const tasks = new FleetTasksService(ctx, {
    dir: mkdtempSync(join(tmpdir(), 'fleet-tasks-')),
    clock,
  })
  return { ctx, clock, tasks, bus }
}

/** A contract whose pass range is exit-code == 0. */
function exitContract() {
  return { expectedResult: 'all tests pass, exit 0', metric: 'exit-code', passRange: '== 0' }
}

/** Evidence for a passing exit-code. */
function exitEvidence(result: string, by = 'agent-a'): FleetTaskEvidence {
  return { result, notes: 'ran the suite', artifacts: ['run-1'], submittedBy: by }
}

async function main(): Promise<void> {
  console.log('tasks-smoke: fleet-tasks shared queue — lifecycle, atomic claim, escalation, auto-close, false-done, persistence, claimWake, tools, events')

  // ---- 1. lifecycle: create → claim → complete → accept ----
  {
    const { tasks, clock } = mountTasks()
    const created = tasks.create({ title: 'build the rig', severity: 'P1', artifactContract: exitContract() }, 'lead-1')
    assertPass('create returns a task in the claimable pool', created.state === 'Triage' && created.id.startsWith('task-'))
    assertPass('create stores the artifact contract', created.artifactContract?.passRange === '== 0')
    assertPass('create assigns default severity P1', created.severity === 'P1')
    assertPass('create with no parent has empty goal ancestry', created.goalAncestry.length === 0)

    const claim = tasks.claim(created.id, 'agent-a')
    assertPass('claim wins and returns a token', claim.ok === true && claim.token !== undefined)
    assertPass('claim sets the single assignee', claim.task?.assignee === 'agent-a')
    assertPass('claim transitions to Started', claim.task?.state === 'Started')
    assertPass('claim acquires an execution lock', claim.task?.locks.length === 1 && claim.task.locks[0]!.holder === 'agent-a')

    clock.advance(1_000)
    const completed = tasks.complete(created.id, claim.token!, exitEvidence('0'), 'agent-a')
    assertPass('complete requires evidence and marks Completed', completed.state === 'Completed')
    assertPass('complete stores the evidence', completed.evidence?.result === '0')
    assertPass('complete leaves acceptance pending', completed.acceptance?.status === 'pending')

    clock.advance(1_000)
    const accepted = tasks.accept(created.id, {}, 'watchdog-1')
    assertPass('accept PASSes when evidence satisfies the contract', accepted.accepted === true)
    assertPass('accepted task stays Completed with acceptance accepted', accepted.task.state === 'Completed' && accepted.task.acceptance?.status === 'accepted')
  }

  // ---- 2. atomic claim: two claimants, one wins ----
  {
    const { tasks } = mountTasks()
    const created = tasks.create({ title: 'single winner' }, 'lead-1')
    const first = tasks.claim(created.id, 'agent-a')
    const second = tasks.claim(created.id, 'agent-b')
    assertPass('first claimant wins', first.ok === true && first.token !== undefined)
    assertPass('second claimant is rejected (no double-claim)', second.ok === false && second.reason !== undefined, JSON.stringify(second))
    const after = tasks.get(created.id)!
    assertPass('task has exactly one assignee', after.assignee === 'agent-a')
    assertPass('task has exactly one execution lock', after.locks.length === 1)
  }

  // ---- 3. escalation severity routing (#28, gastown) ----
  {
    const { tasks, clock } = mountTasks()
    const created = tasks.create({ title: 'flaky build', severity: 'P2' }, 'lead-1')
    clock.advance(500)
    const escalated = tasks.escalate(created.id, {
      severity: 'P0',
      owner: 'lead-vortex',
      nextAction: 're-run the merge gate with the pinned image',
    }, 'watchdog-1')
    assertPass('escalate raises the task severity', escalated.severity === 'P0')
    assertPass('escalate records the escalation owner/action', escalated.escalation?.owner === 'lead-vortex' && escalated.escalation?.nextAction.includes('merge gate'))
    assertPass('escalate stamps the raise time', typeof escalated.escalation?.raisedAt === 'number')
    assertPass('escalate does not require an execution lock (intervention)', escalated.state === 'Triage')
  }

  // ---- 4. sub-issue auto-close: completing a parent auto-completes children ----
  {
    const { tasks, clock } = mountTasks()
    const goal = tasks.create({ title: 'top-level goal' }, 'lead-1')
    const child = tasks.create({ title: 'child', parentId: goal.id }, 'lead-1')
    const grandchild = tasks.create({ title: 'grandchild', parentId: child.id }, 'lead-1')
    assertPass('child derives goal ancestry from parent chain',
      child.goalAncestry.length === 1 && child.goalAncestry[0] === goal.id, JSON.stringify(child.goalAncestry))
    assertPass('grandchild ancestry reaches the top-level goal',
      grandchild.goalAncestry.length === 2 && grandchild.goalAncestry[1] === goal.id, JSON.stringify(grandchild.goalAncestry))

    const claim = tasks.claim(goal.id, 'agent-a')
    clock.advance(1_000)
    tasks.complete(goal.id, claim.token!, exitEvidence('0'), 'agent-a')

    const childAfter = tasks.get(child.id)!
    const grandAfter = tasks.get(grandchild.id)!
    assertPass('child auto-completes when the parent completes', childAfter.state === 'Completed', JSON.stringify(childAfter.state))
    assertPass('grandchild auto-completes recursively', grandAfter.state === 'Completed', JSON.stringify(grandAfter.state))
    assertPass('auto-close marks the closing parent', childAfter.autoClosedBy === goal.id && grandAfter.autoClosedBy === child.id)
    assertPass('auto-close releases the child lock', childAfter.locks.length === 0 && childAfter.assignee === undefined)
  }

  // ---- 5. false-done rejection: artifact contract mismatch → rejected + reopened ----
  {
    const { tasks, clock } = mountTasks()
    const created = tasks.create({ title: 'must exit zero', artifactContract: exitContract() }, 'lead-1')
    const claim = tasks.claim(created.id, 'agent-a')
    clock.advance(1_000)
    tasks.complete(created.id, claim.token!, exitEvidence('1'), 'agent-a')

    clock.advance(1_000)
    const rejected = tasks.accept(created.id, {}, 'watchdog-1')
    assertPass('accept REJECTS false-done evidence', rejected.accepted === false, JSON.stringify(rejected))
    assertPass('rejection records the reason', typeof rejected.reason === 'string' && rejected.reason.includes('exit-code'), rejected.reason ?? '')
    assertPass('rejected task reopens to Unstarted', rejected.task.state === 'Unstarted', JSON.stringify(rejected.task.state))
    assertPass('rejection releases assignee + lock for re-claim', rejected.task.assignee === undefined && rejected.task.locks.length === 0)
    assertPass('rejection records the acceptance disposition', rejected.task.acceptance?.status === 'rejected')

    const reClaim = tasks.claim(created.id, 'agent-b')
    assertPass('reopened task can be re-claimed by a new agent', reClaim.ok === true && reClaim.task?.assignee === 'agent-b')
  }

  // ---- 6. persistence reload: the SQLite store survives a restart ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-tasks-store-'))
    const clock = fakeClock()
    const store1 = new FleetTaskStore({ dir })
    const service1 = new FleetTasksService(new CordisContext(), { dir, clock })
    const created = service1.create({ title: 'durable task', severity: 'P0', claimRole: 'worker' }, 'lead-1')
    const claim = service1.claim(created.id, 'agent-a')
    service1.complete(created.id, claim.token!, exitEvidence('0'), 'agent-a')
    store1.close()

    const store2 = new FleetTaskStore({ dir })
    const service2 = new FleetTasksService(new CordisContext(), { dir, clock })
    const reloaded = service2.list()
    assertPass('reload reads the persisted task back', reloaded.length === 1 && reloaded[0]!.id === created.id)
    assertPass('reload preserves the completed state + evidence',
      reloaded[0]!.state === 'Completed' && reloaded[0]!.evidence?.result === '0')
    assertPass('reload preserves goal ancestry + claim role',
      reloaded[0]!.goalAncestry.length === 0 && reloaded[0]!.claimRole === 'worker')
    store2.close()
  }

  // ---- 7. claimWake seam: empty queue, role routing, targeted wake ----
  {
    const { tasks } = mountTasks({ resolveRole: (agentId) => agentId === 'worker-w' ? 'worker' : undefined })
    const empty = tasks.claimWake('worker-w', { kind: 'task-claim', agentId: 'worker-w' })
    assertPass('claimWake on an empty queue returns ok:false', empty.ok === false && empty.reason === 'no claimable task', JSON.stringify(empty))

    tasks.create({ title: 'worker routed', claimRole: 'worker', severity: 'P2' }, 'lead-1')
    const otherTask = tasks.create({ title: 'other-role routed', claimRole: 'qa', severity: 'P0' }, 'lead-1')
    tasks.create({ title: 'unrouted pool', severity: 'P1' }, 'lead-1')

    const first = tasks.claimWake('worker-w', { kind: 'task-claim', agentId: 'worker-w' })
    assertPass('claimWake claims the role-routed task first', first.ok === true && first.task?.title === 'worker routed', JSON.stringify(first))

    const second = tasks.claimWake('worker-w', { kind: 'task-claim', agentId: 'worker-w' })
    assertPass('claimWake falls back to the un-routed pool', second.ok === true && second.task?.title === 'unrouted pool', JSON.stringify(second))

    const third = tasks.claimWake('worker-w', { kind: 'task-claim', agentId: 'worker-w' })
    assertPass('claimWake skips tasks routed to a different role', third.ok === false, JSON.stringify(third))

    const otherRole = tasks.claim(otherTask.id, 'qa-a')
    assertPass('a task routed to another role is still claimable directly by that role', otherRole.ok === true)
  }

  // ---- 8. claimWake targeted wake (wakeEntry.taskId) ----
  {
    const { tasks } = mountTasks()
    const created = tasks.create({ title: 'targeted' }, 'lead-1')
    const targeted = tasks.claimWake('agent-x', { kind: 'task-claim', agentId: 'agent-x', taskId: created.id })
    assertPass('targeted claimWake claims the named task', targeted.ok === true && targeted.task?.id === created.id && targeted.task?.assignee === 'agent-x')
    const again = tasks.claimWake('agent-y', { kind: 'task-claim', agentId: 'agent-y', taskId: created.id })
    assertPass('targeted claimWake cannot double-claim', again.ok === false)
  }

  // ---- 9. bus events: every mutation publishes with originKind "task" ----
  {
    const { tasks, bus, clock } = mountTasksWithBus()
    const created = tasks.create({ title: 'eventful', artifactContract: exitContract() }, 'lead-1')
    const claim = tasks.claim(created.id, 'agent-a')
    clock.advance(100)
    tasks.escalate(created.id, { severity: 'P1', owner: 'lead-1', nextAction: 'watch it' }, 'watchdog-1')
    clock.advance(100)
    tasks.complete(created.id, claim.token!, exitEvidence('0'), 'agent-a')
    clock.advance(100)
    tasks.accept(created.id, {}, 'watchdog-1')

    const byType = (type: string): FleetBusEvent[] => bus.replay({ type })
    const createdEvents = byType(FLEET_TASK_EVENT_TYPES.created)
    assertPass('fleet/task-created published', createdEvents.length === 1)
    assertPass('events carry originKind "task" (mechanism separation)',
      createdEvents[0]!.originKind === 'task' && byType(FLEET_TASK_EVENT_TYPES.claimed)[0]!.originKind === 'task')
    assertPass('fleet/task-escalated published with the escalation payload',
      (byType(FLEET_TASK_EVENT_TYPES.escalated)[0]!.payload as { escalation?: { owner?: string } }).escalation?.owner === 'lead-1')
    assertPass('fleet/task-completed published', byType(FLEET_TASK_EVENT_TYPES.completed).length === 1)
    assertPass('fleet/task-accepted published', byType(FLEET_TASK_EVENT_TYPES.accepted).length === 1)
    assertPass('all five required event types exist in the vocabulary', [
      FLEET_TASK_EVENT_TYPES.created,
      FLEET_TASK_EVENT_TYPES.claimed,
      FLEET_TASK_EVENT_TYPES.completed,
      FLEET_TASK_EVENT_TYPES.escalated,
      FLEET_TASK_EVENT_TYPES.rejected,
    ].every(type => type.startsWith('fleet/task-')))
  }

  // ---- 10. signed events: identity signs task events when available ----
  {
    const clock = fakeClock()
    const ctx = new CordisContext()
    const identity = new FleetAgentService(ctx, { home: mkdtempSync(join(tmpdir(), 'fleet-agent-')) })
    identity.register({ agentId: 'agent-a' })
    const bus = new FleetBusService(ctx, { storeDir: mkdtempSync(join(tmpdir(), 'fleet-bus-')), clock, resolveAgent: () => undefined })
    const tasks = new FleetTasksService(ctx, { dir: mkdtempSync(join(tmpdir(), 'fleet-tasks-')), clock })

    const created = tasks.create({ title: 'signed' }, 'agent-a')
    const events = bus.replay({ type: FLEET_TASK_EVENT_TYPES.created })
    const payload = events[0]!.payload as { signed?: FleetSignedEvent }
    assertPass('task event embeds a signed envelope when identity is available', payload.signed !== undefined)
    assertPass('the embedded signature verifies against the actor profile', identity.verify(payload.signed!).ok === true)

    const unsigned = tasks.create({ title: 'unsigned actor' }, 'unregistered-1')
    const unsignedEvents = bus.replay({ type: FLEET_TASK_EVENT_TYPES.created })
    const unsignedPayload = unsignedEvents[unsignedEvents.length - 1]!.payload as { signed?: FleetSignedEvent }
    assertPass('event without a profile is published unsigned (safe fallback)',
      unsignedPayload.signed === undefined && unsigned.title === 'unsigned actor')
  }

  // ---- 11. cordis event emission per mutation ----
  {
    const { ctx, tasks } = mountTasks()
    const seen: { type: string; task: FleetTask; actor: string }[] = []
    ctx.on('fleet-tasks/event', (info) => { seen.push(info) })
    const created = tasks.create({ title: 'observable' }, 'lead-1')
    tasks.claim(created.id, 'agent-a')
    assertPass('fleet-tasks/event emitted per mutation', seen.length === 2 && seen[0]!.type === FLEET_TASK_EVENT_TYPES.created && seen[1]!.type === FLEET_TASK_EVENT_TYPES.claimed)
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

    applyTasks(ctx, {
      dir: mkdtempSync(join(tmpdir(), 'fleet-tasks-')),
      clock,
    } as never)

    assertPass('apply registers the six task tools',
      ['task_create', 'task_list', 'task_claim', 'task_complete', 'task_escalate', 'task_accept'].every(n => registered.has(n)),
      JSON.stringify([...registered.keys()]))

    const exec = { agent: { id: 'agent-a', session: { id: 'agent-a' } } }
    const create = registered.get('task_create')!
    const createdResult = await create.execute!({
      title: 'tool task',
      severity: 'P2',
      artifactContract: { expectedResult: 'all tests pass', metric: 'exit-code', passRange: '== 0' },
    }, exec as never) as { task: FleetTask }
    assertPass('task_create executes', createdResult.task.title === 'tool task' && createdResult.task.severity === 'P2')

    const list = registered.get('task_list')!
    const listResult = await list.execute!({ severity: 'P2' }, exec as never) as { tasks: FleetTask[] }
    assertPass('task_list filters by severity', listResult.tasks.length === 1 && listResult.tasks[0]!.id === createdResult.task.id)

    const claim = registered.get('task_claim')!
    const claimResult = await claim.execute!({ taskId: createdResult.task.id }, exec as never) as { ok: boolean; token?: string }
    assertPass('task_claim executes (defaults to caller)', claimResult.ok === true && claimResult.token !== undefined)

    const complete = registered.get('task_complete')!
    const completedResult = await complete.execute!({ taskId: createdResult.task.id, token: claimResult.token!, evidence: { result: '0', notes: 'ran' } }, exec as never) as { task: FleetTask }
    assertPass('task_complete executes with evidence', completedResult.task.state === 'Completed')

    const escalate = registered.get('task_escalate')!
    const escalatedResult = await escalate.execute!({ taskId: createdResult.task.id, severity: 'P0', owner: 'lead-1', nextAction: 're-run' }, exec as never) as { task: FleetTask }
    assertPass('task_escalate executes and routes severity', escalatedResult.task.severity === 'P0' && escalatedResult.task.escalation?.owner === 'lead-1')

    const accept = registered.get('task_accept')!
    const acceptResult = await accept.execute!({ taskId: createdResult.task.id }, exec as never) as { accepted: boolean; reason?: string }
    assertPass('task_accept executes (evidence satisfies contract)', acceptResult.accepted === true)

    const noAgent = await claim.execute!({ taskId: createdResult.task.id }, {} as never)
      .then(() => false, () => true)
    assertPass('task tools require an owning agent session', noAgent === true)
  }

  console.log('tasks-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`tasks-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
