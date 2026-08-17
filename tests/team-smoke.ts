/**
 * VERIFY (issue #30): V3 team smoke test.
 * Coverage for the fleet team: (a) the roster registers six fleet-agent
 * profiles (no owner — the human operator is not a fleet identity), (b) the
 * org chart resolves roles for claimWake routing, and (c) the END-TO-END job
 * flow — lead task_create (artifact contract) → dev-1 claimWake (Started) →
 * complete with evidence → qa task_accept PASS → watchdog-style verify PASS;
 * plus a false-done path → qa REJECT (artifact mismatch) and a
 * supervisor-wake → claimWake seam claim. Reuses the REAL fleet plugin
 * services via the team bootstrap (the family harness pattern).
 *
 * Run: pnpm test:team  (or)  tsx tests/team-smoke.ts
 * @module @hydra/dsh-fleet/tests/team-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPass, fakeClock } from './harness.ts'
import { mountTeam, type MountedTeam } from '../team/bootstrap.ts'
import { ROSTER, ROSTER_AGENT_IDS } from '../team/roster.ts'
import {
  ORG_CHART,
  ROLE_TO_AGENT,
  QA_AGENT_ID,
  QA_ROLE,
  resolveAgentForRole,
  resolveRole,
  fleetTasksOrgChartConfig,
} from '../team/org-chart.ts'
import { FLEET_TASK_EVENT_TYPES } from '../plugins/fleet-tasks/src/service.ts'
import type { FleetTaskEvidence } from '../plugins/fleet-tasks/src/types.ts'
import { WATCHDOG_REVIEW_ROLE } from '../plugins/fleet-watchdog/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'

/** A contract whose pass range is exit-code == 0. */
function exitContract() {
  return { expectedResult: 'all tests pass, exit 0', metric: 'exit-code', passRange: '== 0' }
}

/** Evidence for a passing exit-code. */
function exitEvidence(result: string, by = 'dev-1'): FleetTaskEvidence {
  return { result, notes: 'ran the suite', artifacts: ['run-1'], submittedBy: by }
}

/** Mount a fresh team on a temp fleet data root (never touches real $DSH_HOME). */
function mountTeamForTest(overrides: Partial<Parameters<typeof mountTeam>[0]> = {}): MountedTeam & {
  clock: ReturnType<typeof fakeClock>
} {
  const clock = fakeClock()
  const team = mountTeam({ home: mkdtempSync(join(tmpdir(), 'fleet-team-')), clock, ...overrides })
  return { ...team, clock }
}

/** Bus events of one type (newest-last). */
function eventsOf(team: MountedTeam, type: string): FleetBusEvent[] {
  return team.bus.replay({ type })
}

async function main(): Promise<void> {
  console.log('team-smoke: V3 team — roster, org chart, E2E job flow (lead → claimWake → complete → qa gate → watchdog), false-done')

  // ---- (a) roster registers: 6 profiles, roles set, keys minted, no owner ----
  {
    const team = mountTeamForTest()
    assertPass('roster holds the six agent profiles (no owner)',
      ROSTER.length === 6 && ROSTER_AGENT_IDS.length === 6 && !ROSTER_AGENT_IDS.includes('owner'),
      `roster=${JSON.stringify(ROSTER_AGENT_IDS)}`)
    assertPass('bootstrap registers exactly six identity profiles',
      team.profiles.length === 6 && team.identity.listProfiles().length === 6, JSON.stringify(team.identity.listProfiles().map(p => p.agentId)))
    assertPass('every roster member has a registered profile',
      ROSTER_AGENT_IDS.every(id => team.identity.getProfile(id) !== undefined))
    assertPass('profiles carry the org-chart role',
      team.profiles.every(p => p.role === p.agentId && ROSTER.find(r => r.agentId === p.agentId)?.claimRole === p.role))
    assertPass('profiles mint ed25519 keypairs (public key present)',
      team.profiles.every(p => typeof p.publicKey === 'string' && p.publicKey.length > 0))
    const signed = team.identity.sign({ type: 'fleet/team-smoke', actor: 'lead', payload: { ok: true } })
    assertPass('a registered member can sign + verify events',
      team.identity.verify(signed).ok === true)

    // Re-registration is idempotent (keys never rotate, no duplicates).
    const before = team.identity.listProfiles().map(p => `${p.agentId}:${p.createdAt}`)
    for (const profile of ROSTER) team.identity.register({ agentId: profile.agentId, name: profile.name, role: profile.claimRole })
    const after = team.identity.listProfiles().map(p => `${p.agentId}:${p.createdAt}`)
    assertPass('re-registering the roster is idempotent (no duplicates, stable createdAt)',
      team.identity.listProfiles().length === 6 && before.join(',') === after.join(','))
  }

  // ---- (b) org-chart role resolution ----
  {
    const team = mountTeamForTest()
    assertPass('resolveRole maps every agent to its org-chart role',
      ROSTER_AGENT_IDS.every(id => resolveRole(id) === id))
    assertPass('resolveAgentForRole maps qa role → qa agent (the gate)',
      resolveAgentForRole(QA_ROLE) === QA_AGENT_ID && QA_AGENT_ID === 'qa')
    assertPass('resolveAgentForRole maps dev roles to their agents',
      resolveAgentForRole('dev-1') === 'dev-1' && resolveAgentForRole('arch') === 'arch' && resolveAgentForRole('devops') === 'devops')
    assertPass('resolveAgentForRole(undefined) → undefined', resolveAgentForRole(undefined) === undefined)
    assertPass('ORG_CHART covers the roster (agent → role shape)',
      ROSTER_AGENT_IDS.every(id => ORG_CHART[id] === id) && Object.keys(ORG_CHART).length === 6)
    assertPass('ROLE_TO_AGENT mirrors the org chart (role → agent, watchdog shape)',
      ROSTER_AGENT_IDS.every(id => ROLE_TO_AGENT[id as keyof typeof ROLE_TO_AGENT] === id))
    const cfg = fleetTasksOrgChartConfig()
    assertPass('fleet-tasks config carries the org chart + resolveRole',
      cfg.orgChart?.['dev-2'] === 'dev-2' && cfg.resolveRole?.('qa') === 'qa')

    // claimWake routes by the org chart: dev-1 skips tasks routed to qa.
    const qaTask = team.tasks.create({ title: 'qa routed review', claimRole: QA_ROLE, severity: 'P0' }, 'lead')
    const openTask = team.tasks.create({ title: 'open implementation', severity: 'P1' }, 'lead')
    const dev1 = team.tasks.claimWake('dev-1', { kind: 'task-claim', agentId: 'dev-1' })
    assertPass('claimWake skips tasks routed to another role (qa)',
      dev1.ok === true && dev1.task?.title === 'open implementation', JSON.stringify(dev1))
    const dev1Again = team.tasks.claimWake('dev-1', { kind: 'task-claim', agentId: 'dev-1' })
    assertPass('claimWake exhausts the dev-1 claimable pool (skips the qa-routed task)',
      dev1Again.ok === false, JSON.stringify(dev1Again))
    const qa = team.tasks.claimWake('qa', { kind: 'task-claim', agentId: QA_AGENT_ID })
    assertPass('claimWake routes the qa task to the qa role agent',
      qa.ok === true && qa.task?.id === qaTask.id && qa.task?.assignee === 'qa', JSON.stringify(qa))
  }

  // ---- (c) END-TO-END genuine job flow: lead → claimWake → complete → qa gate → watchdog ----
  {
    const team = mountTeamForTest()
    // 1. lead creates the job as a task with an artifact contract + claimRole.
    const job = team.tasks.create({
      title: 'build the monitoring dashboard',
      claimRole: 'dev-1',
      severity: 'P1',
      artifactContract: exitContract(),
    }, 'lead')
    assertPass('lead task_create → task in the claimable pool with a contract',
      job.state === 'Triage' && job.claimRole === 'dev-1' && job.artifactContract?.metric === 'exit-code')

    // 2. dev-1 claims via claimWake (heartbeat-wake seam / task_claim path).
    const claim = team.tasks.claimWake('dev-1', { kind: 'task-claim', agentId: 'dev-1' })
    assertPass('claimWake dev-1 → Started with single assignee + execution lock',
      claim.ok === true && claim.token !== undefined && claim.task?.assignee === 'dev-1' && claim.task?.state === 'Started')
    assertPass('fleet/task-created + fleet/task-claimed published (originKind task)',
      eventsOf(team, FLEET_TASK_EVENT_TYPES.created).length === 1
        && eventsOf(team, FLEET_TASK_EVENT_TYPES.claimed).length === 1
        && eventsOf(team, FLEET_TASK_EVENT_TYPES.claimed)[0]!.originKind === 'task')

    // 3. dev-1 completes with artifact evidence (result = measured metric value).
    team.clock.advance(1_000)
    const completed = team.tasks.complete(job.id, claim.token!, exitEvidence('0', 'dev-1'), 'dev-1')
    assertPass('task_complete with evidence → Completed, acceptance pending',
      completed.state === 'Completed' && completed.evidence?.result === '0' && completed.acceptance?.status === 'pending')
    assertPass('fleet/task-completed published', eventsOf(team, FLEET_TASK_EVENT_TYPES.completed).length === 1)

    // 4. qa gate: task_accept verifies the evidence against the contract → PASS.
    team.clock.advance(1_000)
    const accepted = team.tasks.accept(job.id, {}, 'qa')
    assertPass('qa task_accept PASSes evidence that satisfies the contract',
      accepted.accepted === true && accepted.task.state === 'Completed' && accepted.task.acceptance?.status === 'accepted')
    assertPass('fleet/task-accepted published', eventsOf(team, FLEET_TASK_EVENT_TYPES.accepted).length === 1)

    // 5. watchdog-style verify: watch the (already resting) tree → structural PASS.
    team.watchdog.watch(job.id)
    const watch = team.watchdog.status(job.id)!
    assertPass('watchdog-style verify PASSes the accepted completion',
      watch.status === 'verified' && watch.lastVerdict === 'PASS', JSON.stringify(watch))
    assertPass('fleet/watchdog-stopped + fleet/watchdog-pass published (originKind watchdog)',
      eventsOf(team, 'fleet/watchdog-stopped').length === 1
        && eventsOf(team, 'fleet/watchdog-pass').length === 1
        && eventsOf(team, 'fleet/watchdog-pass')[0]!.originKind === 'watchdog')

    // The board renders the job lifecycle (transparency).
    team.board.refresh()
    const feedEvents = team.board.read({})
    assertPass('fleet-board shows the job lifecycle from the durable bus store',
      feedEvents.some(e => e.type === FLEET_TASK_EVENT_TYPES.created)
        && feedEvents.some(e => e.type === FLEET_TASK_EVENT_TYPES.completed)
        && feedEvents.some(e => e.type === FLEET_TASK_EVENT_TYPES.accepted),
      `feed types=${JSON.stringify([...new Set(feedEvents.map(e => e.type))])}`)
  }

  // ---- (c2) false-done path: qa REJECTs an artifact mismatch ----
  {
    const team = mountTeamForTest()
    const job = team.tasks.create({
      title: 'must exit zero',
      claimRole: 'dev-1',
      artifactContract: exitContract(),
    }, 'lead')
    const claim = team.tasks.claimWake('dev-1', { kind: 'task-claim', agentId: 'dev-1' })
    assertPass('false-done setup: dev-1 claims the job', claim.ok === true)
    team.clock.advance(1_000)
    team.tasks.complete(job.id, claim.token!, exitEvidence('1', 'dev-1'), 'dev-1') // metric 1 !== 0

    team.clock.advance(1_000)
    const rejected = team.tasks.accept(job.id, {}, 'qa')
    assertPass('qa task_accept REJECTs an artifact mismatch (false-done)',
      rejected.accepted === false && typeof rejected.reason === 'string' && rejected.reason.includes('exit-code'),
      JSON.stringify(rejected))
    assertPass('rejection reopens to Unstarted + releases assignee + lock',
      rejected.task.state === 'Unstarted' && rejected.task.assignee === undefined && rejected.task.locks.length === 0)
    assertPass('fleet/task-rejected published with the metric reason',
      eventsOf(team, FLEET_TASK_EVENT_TYPES.rejected).length === 1
        && ((eventsOf(team, FLEET_TASK_EVENT_TYPES.rejected)[0]!.payload as { reason?: string }).reason?.includes('exit-code') ?? false))

    // Reopened + re-claimable: a new claim works (live path restored).
    const reClaim = team.tasks.claimWake('dev-1', { kind: 'task-claim', agentId: 'dev-1', taskId: job.id })
    assertPass('reopened task is re-claimable by the role agent',
      reClaim.ok === true && reClaim.task?.state === 'Started' && reClaim.task?.assignee === 'dev-1')

    // Watchdog REJECT path (structural, on a resting tree with a bad leaf).
    const team2 = mountTeamForTest()
    const root = team2.tasks.create({ title: 'goal', severity: 'P1' }, 'lead')
    const leaf = team2.tasks.create({ title: 'false-done leaf', parentId: root.id, claimRole: 'dev-1', artifactContract: exitContract() }, 'lead')
    team2.watchdog.watch(root.id)
    const leafClaim = team2.tasks.claimWake('dev-1', { kind: 'task-claim', agentId: 'dev-1', taskId: leaf.id })
    team2.clock.advance(1_000)
    team2.tasks.complete(leaf.id, leafClaim.token!, exitEvidence('1', 'dev-1'), 'dev-1')
    const watch2 = team2.watchdog.status(root.id)!
    assertPass('watchdog REJECTs the false-done leaf on a resting tree',
      watch2.status === 'rejected' && watch2.lastVerdict === 'REJECT', JSON.stringify(watch2))
    assertPass('watchdog reopened the leaf + reassigned to the role agent',
      team2.tasks.get(leaf.id)!.state === 'Started' && team2.tasks.get(leaf.id)!.assignee === 'dev-1')
    assertPass('watchdog created a marked review task under the rejected leaf',
      team2.tasks.list().some(t => t.parentId === leaf.id && t.claimRole === WATCHDOG_REVIEW_ROLE && t.title.startsWith('[watchdog]')))
    assertPass('fleet/watchdog-reject published',
      eventsOf(team2, 'fleet/watchdog-reject').length === 1
        && eventsOf(team2, 'fleet/watchdog-reject')[0]!.originKind === 'watchdog')
  }

  // ---- (c3) supervisor wake → claimWake seam: lead creates, supervisor wakes dev-1, dev-1 claims ----
  {
    const woken: unknown[] = []
    const team = mountTeamForTest({
      resolveAgent: () => ({ followup: (m: unknown) => { woken.push(m) }, inject: () => {} }),
    })
    const job = team.tasks.create({
      title: 'wake-claimed work',
      claimRole: 'dev-1',
      severity: 'P2',
      artifactContract: exitContract(),
    }, 'lead')
    team.supervisor.enqueueWake({
      targetAgentId: 'dev-1',
      kind: 'task-claim',
      context: { taskId: job.id },
      dueAt: team.clock.now(),
    })
    const tick = await team.supervisor.runTick(team.clock.now())
    assertPass('supervisor delivered the wake (followup) to dev-1',
      tick.agentsWoken.includes('dev-1') && woken.length === 1, JSON.stringify(tick))
    assertPass('the task-claim wake seam claimed the task for dev-1',
      team.tasks.get(job.id)!.state === 'Started' && team.tasks.get(job.id)!.assignee === 'dev-1')
    assertPass('fleet/wake published with originKind supervisor',
      eventsOf(team, 'fleet/wake').length === 1 && eventsOf(team, 'fleet/wake')[0]!.originKind === 'supervisor')
  }

  console.log('team-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`team-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
