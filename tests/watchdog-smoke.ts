/**
 * VERIFY (issue #26 + #28): fleet-watchdog smoke test.
 * Unit coverage for the P2.4 verification gate on stopped work: a watched task
 * tree that rests → structural verification runs; a false-done leaf (missing
 * evidence / metric out of range) → REJECT + reopen + marked review task +
 * reassign (org-chart role routing); a genuine done → PASS; an identical
 * stopped state → single verification (stop-fingerprint, #28); the watchdog
 * review task is excluded from its own watched subtree (self-trigger guard);
 * events carry originKind 'watchdog' (signed when identity present); and the
 * three model-facing tools execute. No live LLM — fake clock + real
 * fleet-tasks + real fleet-bus (the family harness pattern).
 *
 * Run: pnpm test:watchdog  (or)  tsx tests/watchdog-smoke.ts
 * @module @hydra/dsh-fleet/tests/watchdog-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertPass, fakeClock } from './harness.ts'
import { apply as applyWatchdog } from '../plugins/fleet-watchdog/src/index.ts'
import {
  FleetWatchdogService,
  WATCHDOG_ACTOR,
  WATCHDOG_ORIGIN_KIND,
  WATCHDOG_REVIEW_ROLE,
} from '../plugins/fleet-watchdog/src/service.ts'
import { FleetTasksService } from '../plugins/fleet-tasks/src/service.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'
import { FleetAgentService, type FleetSignedEvent } from '../plugins/fleet-agent/src/service.ts'
import type { FleetTaskEvidence } from '../plugins/fleet-tasks/src/types.ts'

/** Mount fleet-tasks + fleet-bus + fleet-watchdog on one fresh Context. */
function mountWatchdog(overrides: Record<string, unknown> = {}): {
  ctx: CordisContext
  clock: ReturnType<typeof fakeClock>
  bus: FleetBusService
  tasks: FleetTasksService
  watchdog: FleetWatchdogService
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-watchdog-bus-')),
    clock,
    resolveAgent: () => undefined,
  })
  const tasks = new FleetTasksService(ctx, { dir: mkdtempSync(join(tmpdir(), 'fleet-watchdog-tasks-')), clock })
  const watchdog = new FleetWatchdogService(ctx, { clock, ...overrides })
  assertPass('ctx.fleetWatchdog is registered', ctx.fleetWatchdog !== undefined)
  return { ctx, clock, bus, tasks, watchdog }
}

/** A contract whose pass range is exit-code == 0. */
function exitContract() {
  return { expectedResult: 'all tests pass, exit 0', metric: 'exit-code', passRange: '== 0' }
}

/** Evidence for a passing exit-code. */
function exitEvidence(result: string, by = 'agent-a'): FleetTaskEvidence {
  return { result, notes: 'ran the suite', artifacts: ['run-1'], submittedBy: by }
}

/** A goal with one leaf child that carries the exit-code contract. */
function buildTree(tasks: FleetTasksService, title = 'goal', claimRole?: string): { rootId: string; leafId: string } {
  const root = tasks.create({ title, severity: 'P1' }, 'lead-1')
  const leaf = tasks.create({
    title: `${title} leaf`,
    parentId: root.id,
    artifactContract: exitContract(),
    ...(claimRole !== undefined ? { claimRole } : {}),
  }, 'lead-1')
  return { rootId: root.id, leafId: leaf.id }
}

/** Claim + complete one task with evidence. */
function claimAndComplete(tasks: FleetTasksService, taskId: string, evidence: FleetTaskEvidence, by = 'agent-a'): void {
  const claim = tasks.claim(taskId, by)
  if (!claim.ok) throw new Error(`claim of "${taskId}" failed: ${claim.reason ?? '?'}`)
  tasks.complete(taskId, claim.token!, evidence, by)
}

/** Bus events of one type, newest-last. */
function eventsOf(bus: FleetBusService, type: string): FleetBusEvent[] {
  return bus.replay({ type })
}

async function main(): Promise<void> {
  console.log('watchdog-smoke: verification gate on stopped work — rest → verify, false-done reject, fingerprint, self-trigger guard, tools')

  // ---- 1. tree rests → verification runs (auto-trigger on fleet-tasks/event) ----
  {
    const { ctx, tasks, watchdog } = mountWatchdog()
    const { rootId, leafId } = buildTree(tasks)
    watchdog.watch(rootId)
    assertPass('watch starts in the watching state', watchdog.status(rootId)!.status === 'watching', JSON.stringify(watchdog.status(rootId)))

    claimAndComplete(tasks, leafId, exitEvidence('0'))
    // The fleet-tasks/event hook recomputed on completion; the tree rested → verification ran.
    const watch = watchdog.status(rootId)!
    assertPass('leaf completion → tree rests → verification runs',
      watch.status === 'verified' && watch.lastVerdict === 'PASS', JSON.stringify(watch))
    assertPass('PASS leaf stays Completed with acceptance accepted',
      tasks.get(leafId)!.state === 'Completed' && tasks.get(leafId)!.acceptance?.status === 'accepted')
    assertPass('fleet/watchdog-stopped + fleet/watchdog-pass published',
      eventsOf(ctx.fleetBus, 'fleet/watchdog-stopped').length === 1
        && eventsOf(ctx.fleetBus, 'fleet/watchdog-pass').length === 1)
  }

  // ---- 2. false-done (metric out of range) → REJECT + reopen + review task + reassign ----
  {
    const { ctx, tasks, watchdog } = mountWatchdog({ reassignAgents: { worker: 'agent-w' } })
    const { rootId, leafId } = buildTree(tasks, 'must-exit-zero', 'worker')
    watchdog.watch(rootId)

    claimAndComplete(tasks, leafId, exitEvidence('1'), 'agent-a') // out of range: 1 !== 0
    const watch = watchdog.status(rootId)!
    assertPass('out-of-range metric → REJECT verdict',
      watch.status === 'rejected' && watch.lastVerdict === 'REJECT', JSON.stringify(watch))

    const leaf = tasks.get(leafId)!
    assertPass('rejected leaf records the false-done rejection',
      leaf.acceptance?.status === 'rejected', JSON.stringify(leaf.acceptance))
    assertPass('the original assignee + execution lock were released (leaf was re-claimable)',
      leaf.assignee === 'agent-w' && leaf.locks.length === 1 && leaf.locks[0]!.holder === 'agent-w',
      JSON.stringify({ assignee: leaf.assignee, locks: leaf.locks }))
    assertPass('rejected leaf records the acceptance disposition', leaf.acceptance?.status === 'rejected')

    const rejectEvents = eventsOf(ctx.fleetBus, 'fleet/watchdog-reject')
    assertPass('fleet/watchdog-reject published with an evidence summary',
      rejectEvents.length === 1
        && (rejectEvents[0]!.payload as { reason: string }).reason.includes('exit-code')
        && (rejectEvents[0]!.payload as { evidence: { metric?: string; actual?: string } }).evidence?.metric === 'exit-code',
      JSON.stringify(rejectEvents))

    // Review task: a marked child of the rejected leaf (self-trigger guard).
    const reviewTask = tasks.list().find(task => task.parentId === leafId)
    assertPass('a marked review task is created under the reopened leaf',
      reviewTask !== undefined && reviewTask.claimRole === WATCHDOG_REVIEW_ROLE
        && reviewTask.title.startsWith('[watchdog]'),
      JSON.stringify(reviewTask))

    // Reassignment via org-chart role routing: claimWake hands it to the role agent.
    assertPass('reopened leaf is reassigned to the role-matched agent',
      leaf.assignee === 'agent-w' && leaf.state === 'Started',
      JSON.stringify({ assignee: leaf.assignee, state: leaf.state }))
  }

  // ---- 3. false-done (contract present, NO evidence) → REJECT ----
  {
    const { ctx, tasks, watchdog } = mountWatchdog()
    const root = tasks.create({ title: 'parent goal' }, 'lead-1')
    const leaf = tasks.create({ title: 'leaf under parent', parentId: root.id, artifactContract: exitContract() }, 'lead-1')
    watchdog.watch(root.id)

    // fleet-tasks complete() itself requires non-empty evidence, so a leaf
    // cannot reach Completed through the normal verb without it. The structural
    // "evidence present?" check fires on the AUTO-CLOSE path: completing the
    // parent marks the leaf Completed with no evidence (a false "done").
    const rootClaim = tasks.claim(root.id, 'agent-a')
    tasks.complete(root.id, rootClaim.token!, exitEvidence('0'), 'agent-a')

    const watch = watchdog.status(root.id)!
    assertPass('evidence-less auto-closed leaf → REJECT',
      watch.status === 'rejected' && watch.lastVerdict === 'REJECT', JSON.stringify(watch))
    assertPass('the reopened leaf is released for re-claim',
      tasks.get(leaf.id)!.state === 'Unstarted' && tasks.get(leaf.id)!.assignee === undefined)
    assertPass('fleet/task-rejected was published by the accept hook (single source of truth)',
      eventsOf(ctx.fleetBus, 'fleet/task-rejected').length === 1)
  }

  // ---- 4. genuine done → PASS (evidence + metric in range), single verification ----
  {
    const { ctx, clock, tasks, watchdog } = mountWatchdog()
    const { rootId, leafId } = buildTree(tasks)
    watchdog.watch(rootId)
    claimAndComplete(tasks, leafId, exitEvidence('0'))
    const pass1 = eventsOf(ctx.fleetBus, 'fleet/watchdog-pass')
    assertPass('genuine done (metric in range) → PASS',
      pass1.length === 1 && watchdog.status(rootId)!.status === 'verified')

    // Identical stopped state immediately → suppressed by the stop-fingerprint.
    const again = watchdog.verify(rootId)
    assertPass('identical stopped state within the window → suppressed (single verification)',
      again.suppressed === true
        && again.stoppedFingerprint !== undefined
        && eventsOf(ctx.fleetBus, 'fleet/watchdog-pass').length === 1,
      JSON.stringify(again))
    assertPass('stopped-fingerprint covers the leaf set + contracts',
      typeof again.stoppedFingerprint === 'string' && again.stoppedFingerprint.length === 64)

    // After the window, the identical state re-verifies (fingerprint same, no storm guard needed for manual).
    clock.advance(61_000)
    const later = watchdog.verify(rootId)
    assertPass('after the window the identical stop re-verifies',
      later.suppressed === undefined && eventsOf(ctx.fleetBus, 'fleet/watchdog-pass').length === 2,
      JSON.stringify(later))
  }

  // ---- 5. self-trigger guard: review task (and its subtree) excluded from the watched tree ----
  {
    const { tasks, watchdog } = mountWatchdog({ reassignAgents: { worker: 'agent-w' } })
    const { rootId, leafId } = buildTree(tasks, 'guard', 'worker')
    watchdog.watch(rootId)
    claimAndComplete(tasks, leafId, exitEvidence('1'), 'agent-a')
    assertPass('false-done triggered a review task', watchdog.status(rootId)!.status === 'rejected')

    const leaves = watchdog.computeLeaves(rootId)
    const reviewTask = tasks.list().find(task => task.claimRole === WATCHDOG_REVIEW_ROLE)!
    assertPass('the watchdog review task is NOT in its own watched subtree',
      leaves.every(leaf => leaf.id !== reviewTask.id),
      JSON.stringify(leaves.map(leaf => leaf.id)))

    // A sub-task under the review task inherits the marker through ancestry.
    const sub = tasks.create({ title: 'review child', parentId: reviewTask.id }, 'lead-1')
    const leavesAfter = watchdog.computeLeaves(rootId)
    assertPass('descendants of a review task are also excluded (marker flows through ancestry)',
      leavesAfter.every(leaf => leaf.id !== sub.id && leaf.id !== reviewTask.id),
      JSON.stringify(leavesAfter.map(leaf => leaf.id)))
  }

  // ---- 6. events: originKind 'watchdog' + signed when identity present ----
  {
    const clock = fakeClock()
    const ctx = new CordisContext()
    const identity = new FleetAgentService(ctx, { home: mkdtempSync(join(tmpdir(), 'fleet-watchdog-identity-')) })
    identity.register({ agentId: WATCHDOG_ACTOR })
    const bus = new FleetBusService(ctx, { storeDir: mkdtempSync(join(tmpdir(), 'fleet-watchdog-bus-')), clock, resolveAgent: () => undefined })
    const tasks = new FleetTasksService(ctx, { dir: mkdtempSync(join(tmpdir(), 'fleet-watchdog-tasks-')), clock })
    const watchdog = new FleetWatchdogService(ctx, { clock })

    const { rootId, leafId } = buildTree(tasks)
    watchdog.watch(rootId)
    claimAndComplete(tasks, leafId, exitEvidence('0'))

    const stopped = eventsOf(bus, 'fleet/watchdog-stopped')
    assertPass('watchdog events carry originKind "watchdog" + actor "watchdog"',
      stopped.length === 1 && stopped[0]!.originKind === WATCHDOG_ORIGIN_KIND && stopped[0]!.actor === WATCHDOG_ACTOR,
      JSON.stringify(stopped))
    const stoppedPayload = stopped[0]!.payload as { signed?: FleetSignedEvent }
    assertPass('watchdog events embed a signed envelope when identity is available',
      stoppedPayload.signed !== undefined && identity.verify(stoppedPayload.signed!).ok === true)
    assertPass('the stopped event carries the stop-fingerprint (bus dedupe reuse)',
      typeof stopped[0]!.fingerprint === 'string' && stopped[0]!.fingerprint!.length === 64)
    assertPass('fleet/watchdog-pass carries originKind "watchdog" too',
      eventsOf(bus, 'fleet/watchdog-pass').every(event => event.originKind === WATCHDOG_ORIGIN_KIND))
  }

  // ---- 7. cordis event emission per decision ----
  {
    const { ctx, tasks, watchdog } = mountWatchdog()
    const seen: Array<{ type: string; treeRootId: string }> = []
    ctx.on('fleet-watchdog/event', (info) => { seen.push(info) })
    const { rootId, leafId } = buildTree(tasks)
    watchdog.watch(rootId)
    claimAndComplete(tasks, leafId, exitEvidence('0'))
    assertPass('fleet-watchdog/event emitted per decision (stopped + pass)',
      seen.some(entry => entry.type === 'fleet/watchdog-stopped' && entry.treeRootId === rootId)
        && seen.some(entry => entry.type === 'fleet/watchdog-pass' && entry.treeRootId === rootId),
      JSON.stringify(seen))
  }

  // ---- 8. tools: three watchdog tools registered + execute ----
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

    applyWatchdog(ctx, { clock, reverifyWindowMs: 60_000 } as never)
    assertPass('apply registers the three watchdog tools',
      ['watchdog_watch', 'watchdog_verify', 'watchdog_status'].every(name => registered.has(name)),
      JSON.stringify([...registered.keys()]))

    // Watch must be able to see fleet-tasks: mount the real service on the same ctx.
    new FleetTasksService(ctx, { dir: mkdtempSync(join(tmpdir(), 'fleet-watchdog-tools-tasks-')), clock })
    const exec = { agent: { id: 'agent-a', session: { id: 'agent-a' } } }
    const { rootId, leafId } = buildTree(ctx.fleetTasks, 'tool goal')

    const watchTool = registered.get('watchdog_watch')!
    const watchResult = await watchTool.execute!({ treeRootId: rootId }, exec as never) as { status: string; treeRootId: string }
    assertPass('watchdog_watch executes (assigns the tree)', watchResult.status === 'watching' && watchResult.treeRootId === rootId)

    const verifyTool = registered.get('watchdog_verify')!
    const notRested = await verifyTool.execute!({ treeRootId: rootId }, exec as never) as { rested: boolean }
    assertPass('watchdog_verify reports a not-rested tree', notRested.rested === false)

    const statusTool = registered.get('watchdog_status')!
    const statusResult = await statusTool.execute!({}, exec as never) as { watches: Array<{ treeRootId: string }> }
    assertPass('watchdog_status lists the watched tree',
      statusResult.watches.length === 1 && statusResult.watches[0]!.treeRootId === rootId)

    const noAgent = await watchTool.execute!({ treeRootId: leafId }, {} as never)
      .then(() => false, () => true)
    assertPass('watchdog tools require an owning agent session', noAgent === true)
  }

  // ---- 9. LIVE scripted: a mixed tree (one false-done + one genuine) — full flow ----
  {
    const { ctx, tasks, watchdog } = mountWatchdog({ reassignAgents: { worker: 'agent-w' } })
    const root = tasks.create({ title: 'live goal' }, 'lead-1')
    const genuine = tasks.create({ title: 'genuine leaf', parentId: root.id, artifactContract: exitContract() }, 'lead-1')
    const falseDone = tasks.create({ title: 'false-done leaf', parentId: root.id, artifactContract: exitContract(), claimRole: 'worker' }, 'lead-1')
    watchdog.watch(root.id)

    claimAndComplete(tasks, genuine.id, exitEvidence('0'), 'agent-a')
    claimAndComplete(tasks, falseDone.id, exitEvidence('1'), 'agent-a')

    const watch = watchdog.status(root.id)!
    assertPass('mixed tree → REJECT (one leaf false-done)',
      watch.status === 'rejected' && watch.lastVerdict === 'REJECT', JSON.stringify(watch))

    const genuineAfter = tasks.get(genuine.id)!
    const falseAfter = tasks.get(falseDone.id)!
    assertPass('the genuine leaf passes (stays Completed, accepted)',
      genuineAfter.state === 'Completed' && genuineAfter.acceptance?.status === 'accepted',
      JSON.stringify(genuineAfter.acceptance))
    assertPass('the false-done leaf is reopened + reassigned to the role agent',
      falseAfter.state === 'Started' && falseAfter.assignee === 'agent-w' && falseAfter.acceptance?.status === 'rejected',
      JSON.stringify({ state: falseAfter.state, assignee: falseAfter.assignee }))
    assertPass('fleet/watchdog-reject names the false-done leaf',
      eventsOf(ctx.fleetBus, 'fleet/watchdog-reject').some(event =>
        (event.payload as { taskId: string; reassignedAgentId: string }).taskId === falseDone.id
          && (event.payload as { reassignedAgentId: string }).reassignedAgentId === 'agent-w'))

    // Genuine case passes cleanly in isolation (single leaf, valid evidence).
    const solo = mountWatchdog()
    const soloRoot = solo.tasks.create({ title: 'solo goal' }, 'lead-1')
    const soloLeaf = solo.tasks.create({ title: 'solo leaf', parentId: soloRoot.id, artifactContract: exitContract() }, 'lead-1')
    solo.watchdog.watch(soloRoot.id)
    claimAndComplete(solo.tasks, soloLeaf.id, exitEvidence('0'), 'agent-a')
    assertPass('genuine solo tree → PASS (verified)',
      solo.watchdog.status(soloRoot.id)!.status === 'verified'
        && eventsOf(solo.ctx.fleetBus, 'fleet/watchdog-pass').length === 1)
  }

  console.log('watchdog-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`watchdog-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
