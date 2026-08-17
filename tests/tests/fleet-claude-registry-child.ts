/**
 * Verify (issue #23): fleet-inject extension registers Claude Code fleet
 * out-of-process children in ctx.fleet when a matching subagent/start fires,
 * and marks them offline on subagent/end.
 *
 * The spawn hook is not invoked here — this is a pure registry test.
 * @module @hydra/dsh-fleet/tests/fleet-claude-registry-child
 */

import { assertPass, mountHeartbeat } from './harness.ts'
import { apply as applyInject } from '../plugins/fleet-inject/src/index.ts'

function main(): void {
  console.log('fleet-claude-registry-child: out-of-process child registration + offline lifecycle')

  const { ctx } = mountHeartbeat({ stallThresholdMs: 600_000 })
  const fleet = ctx.fleet

  applyInject(ctx, {
    tools: [],
    autoRegisterAgents: false,
    registerClaudeCodeFleetChildren: true,
    acpMcpServers: [],
  })

  const childSessionId = 'claude-code-session-1'
  const runId = 'run-1'

  // Emit a fake subagent/start matching the fork's provider name.
  // Scope-filtered subagent lifecycle events require a global listener
  // (external/deepseek-harness/packages/subagent/subagent/src/invariant.ts:74).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ctx as any).emit('subagent/start', {
    runId,
    provider: 'claude-code-fleet',
    id: childSessionId,
    local: false,
  })

  const entry = fleet.registry.get(childSessionId)
  assertPass(
    'subagent/start registers the out-of-process child as claude-code',
    entry !== undefined && entry.kind === 'claude-code' && entry.sessionId === childSessionId && entry.status === 'active',
    JSON.stringify(entry),
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ctx as any).emit('subagent/end', {
    runId,
    provider: 'claude-code-fleet',
    id: childSessionId,
    local: false,
    stopReason: 'completed',
  })

  const offline = fleet.registry.get(childSessionId)
  assertPass(
    'subagent/end marks the out-of-process child offline',
    offline !== undefined && offline.status === 'offline',
    JSON.stringify(offline),
  )

  console.log('fleet-claude-registry-child: ALL PASS')
}

try {
  main()
} catch (error: unknown) {
  console.error(`fleet-claude-registry-child: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
