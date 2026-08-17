/**
 * VERIFY (issue #20 bullet 2): registry smoke test.
 * Registers 2 fake agents, sends a message between them, advances the clock
 * past the stall threshold and asserts the stall status flips — plus the
 * session-ledger mirror against a real dsh session log.
 *
 * Run: pnpm test:registry  (or)  tsx tests/registry-smoke.ts
 * @module @hydra/dsh-fleet/tests/registry-smoke
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { assertPass, mountHeartbeat, mountHeartbeatWithSessions } from './harness.ts'

async function main(): Promise<void> {
  console.log('registry-smoke: fleet-heartbeat registry, heartbeat, stall, message, session mirror')

  // ---- 1. registry + heartbeat + stall ----
  {
    const { ctx, clock } = mountHeartbeat({ stallThresholdMs: 600_000 })
    const fleet = ctx.fleet

    const delivered: string[] = []
    const a1 = fleet.registerAgent('agent-1', 'external', { label: 'Fake One' })
    const a2 = fleet.registerAgent('agent-2', 'external', { label: 'Fake Two', onMessage: message => { delivered.push(message.text) } })
    const message = fleet.sendMessage('agent-1', 'agent-2', 'hello from agent-1')
    assertPass('sendMessage settles delivered', message.state === 'delivered', `state=${message.state}`)
    assertPass('receiver onMessage fired', delivered.length === 1 && delivered[0] === 'hello from agent-1')
    const ledger1 = fleet.registry.eventsOf('agent-1')
    const ledger2 = fleet.registry.eventsOf('agent-2')
    assertPass(
      'message recorded in both ledgers',
      ledger1.some(e => e.kind === 'message') && ledger2.some(e => e.kind === 'message'),
    )

    // 3. advance the clock past the stall threshold -> stall flips
    clock.advance(600_000 + 5_000) // past 10-min threshold
    const tick = fleet.runTick()
    assertPass('tick flags agent-1 stalled', tick.stalled.includes('agent-1'), JSON.stringify(tick))
    const statusA1 = fleet.getStatus('agent-1')
    assertPass('agent-1 status flipped to stalled', statusA1?.status === 'stalled', `status=${statusA1?.status}`)
    assertPass(
      'stall record appended to ledger',
      fleet.registry.eventsOf('agent-1').some(e => e.kind === 'stall'),
    )

    // 4. heartbeat resumes
    fleet.heartbeat('agent-1', 'back')
    const statusA1b = fleet.getStatus('agent-1')
    assertPass('heartbeat resumes agent-1', statusA1b?.status === 'active', `status=${statusA1b?.status}`)
    const events = fleet.registry.eventsOf('agent-1').map(e => e.kind)
    assertPass(
      'ledger has resume after heartbeat',
      events.includes('resume') && events.filter(e => e === 'heartbeat').length >= 2,
      JSON.stringify(events),
    )
  }

  // ---- 5. session-ledger mirror with a REAL dsh session ----
  {
    const { ctx, clock } = await mountHeartbeatWithSessions()
    const fleet = ctx.fleet
    const session = ctx.sessions.create(SessionId('fleet-ledger-1'), { meta: { cwd: '/tmp' } })
    fleet.registerAgent('dsh-agent', 'dsh', { sessionId: session.id })

    // Heartbeat triggers a fleet/heartbeat mirror into the real session log.
    fleet.heartbeat('dsh-agent', 'tick')
    clock.advance(600_000 + 5_000)
    fleet.runTick()
    fleet.heartbeat('dsh-agent', 'resumed')

    const types = session.events.map(event => event.type)
    assertPass(
      'session log carries fleet/heartbeat + fleet/stall + fleet/resume',
      types.includes('fleet/heartbeat') && types.includes('fleet/stall') && types.includes('fleet/resume'),
      JSON.stringify(types),
    )
    const stall = session.events.find(event => event.type === 'fleet/stall')
    assertPass(
      'fleet/stall payload is JSON + correct agent',
      stall !== undefined && stall.data.agentId === 'dsh-agent' && typeof stall.data.stalledMs === 'number',
    )
  }

  console.log('registry-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`registry-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
