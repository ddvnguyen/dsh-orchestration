/**
 * VERIFY (issue #26): fleet-policy smoke test.
 * Unit coverage for the P3.1 QM posture + command-policy layer: postures
 * Strict/Auto/Dangerous (per-identity + per-context), the command policy of
 * HARD denials (destructive commands + mutating commands on protected paths)
 * that apply in EVERY posture, Strict deny-by-default via the allowlist, the
 * Auto soft-denial (rm -rf) that Dangerous permits, the BLOCKED-action
 * acceptance (`authorize` refuses by throwing PolicyDeniedError) with the
 * `fleet/policy-denied` event carrying the rule + actor, the posture-update
 * event, the four tools, and signing via fleet-agent when present. No live
 * LLM — real fleet-bus + real fleet-agent (the family harness pattern).
 *
 * Run: pnpm test:policy  (or)  tsx tests/fleet-policy-smoke.ts
 * @module @hydra/dsh-fleet/tests/fleet-policy-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertPass, fakeClock } from './harness.ts'
import { apply as applyPolicy } from '../plugins/fleet-policy/src/index.ts'
import {
  DEFAULT_POLICY_RULES,
  FleetPolicyService,
  POLICY_EVENT_TYPES,
  POLICY_ORIGIN_KIND,
} from '../plugins/fleet-policy/src/service.ts'
import { PolicyDeniedError, type PolicyDecision, type PolicyEvalInput } from '../plugins/fleet-policy/src/types.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'
import { FleetAgentService, type FleetSignedEvent } from '../plugins/fleet-agent/src/service.ts'

/** Mount fleet-bus + fleet-policy on one fresh Context. */
function mountPolicy(config: Record<string, unknown> = {}): {
  ctx: CordisContext
  clock: ReturnType<typeof fakeClock>
  bus: FleetBusService
  policy: FleetPolicyService
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-policy-bus-')),
    clock,
    resolveAgent: () => undefined,
  })
  const policy = new FleetPolicyService(ctx, { clock, ...config })
  assertPass('ctx.fleetPolicy is registered', ctx.fleetPolicy !== undefined)
  return { ctx, clock, bus, policy }
}

/** Bus events of one type, newest-last. */
function eventsOf(bus: FleetBusService, type: string): FleetBusEvent[] {
  return bus.replay({ type })
}

/** A denied decision from `evaluate` (no side effects). */
function deniedOf(decision: PolicyDecision): PolicyDecision {
  assertPass('decision is a denial', decision.allowed === false, JSON.stringify(decision))
  return decision
}

/** `authorize` must REFUSE the action (throw PolicyDeniedError) — the block. */
function assertBlocked(policy: FleetPolicyService, input: PolicyEvalInput): PolicyDeniedError {
  let caught: PolicyDeniedError | undefined
  try {
    policy.authorize(input)
  } catch (error) {
    caught = error instanceof PolicyDeniedError ? error : undefined
  }
  assertPass(`authorize blocks "${input.command}" for ${input.actor} (service refuses)`, caught !== undefined)
  return caught!
}

async function main(): Promise<void> {
  console.log('policy-smoke: QM postures (Strict/Auto/Dangerous) + command policy hard denials — denied action blocked, events carry rule + actor')

  // ---- 1. posture defaults + per-identity / per-context resolution ----
  {
    const { policy } = mountPolicy()
    assertPass('context defaults to Auto', policy.getPosture({ kind: 'context' }) === 'Auto')
    assertPass('an identity without an override inherits the context posture', policy.getPosture({ kind: 'identity', agentId: 'agent-a' }) === 'Auto')

    policy.setPosture({ kind: 'identity', agentId: 'agent-a' }, 'Strict', 'lead-1')
    assertPass('identity override resolves for that identity', policy.getPosture({ kind: 'identity', agentId: 'agent-a' }) === 'Strict')
    assertPass('other identities keep the context posture', policy.getPosture({ kind: 'identity', agentId: 'agent-b' }) === 'Auto')

    policy.setPosture({ kind: 'context' }, 'Dangerous', 'lead-1')
    assertPass('context posture overrides the default', policy.getPosture({ kind: 'context' }) === 'Dangerous')
    assertPass('identity override still wins over context', policy.getPosture({ kind: 'identity', agentId: 'agent-a' }) === 'Strict')

    policy.setPosture({ kind: 'identity', agentId: 'agent-a' }, 'Auto', 'lead-1')
    const status = policy.status()
    assertPass('status() reports context + identity overrides + the rule set',
      status.context === 'Dangerous' && status.identities['agent-a'] === 'Auto' && status.rules.length === DEFAULT_POLICY_RULES.length,
      JSON.stringify(status))
    assertPass('unknown posture is rejected', (() => {
      try { policy.setPosture({ kind: 'context' }, 'Relaxed' as never, 'lead-1'); return false } catch { return true }
    })())
  }

  // ---- 2. ACCEPTANCE: a hard-denied action is BLOCKED in EVERY posture ----
  {
    for (const posture of ['Strict', 'Auto', 'Dangerous'] as const) {
      const { ctx, bus, policy } = mountPolicy({ defaultPosture: posture })
      const input: PolicyEvalInput = { actor: 'agent-a', command: 'git', args: ['push', '--force'] }

      const pre = deniedOf(policy.evaluate(input))
      assertPass(`${posture}: force-push is denied (evaluate pre-flight)`, pre.rule?.id === 'deny-git-force-push', JSON.stringify(pre))

      const blocked = assertBlocked(policy, input)
      assertPass(`${posture}: authorize refuses + reports the deny rule`, blocked.decision.rule?.id === 'deny-git-force-push')

      const denied = eventsOf(bus, POLICY_EVENT_TYPES.denied)
      assertPass(`${posture}: fleet/policy-denied published ONCE, with the rule + actor`,
        denied.length === 1
          && denied[0]!.actor === 'agent-a'
          && denied[0]!.originKind === POLICY_ORIGIN_KIND
          && (denied[0]!.payload as { rule: { id: string } }).rule.id === 'deny-git-force-push',
        JSON.stringify(denied))
      assertPass(`${posture}: the denied payload carries the command line`,
        (denied[0]!.payload as { command: string; args: string[] }).command === 'git'
          && JSON.stringify((denied[0]!.payload as { args: string[] }).args) === JSON.stringify(['push', '--force']))
      assertPass(`${posture}: policy_evaluate emits nothing (pure pre-flight)`, ctx.fleetPolicy !== undefined)
    }

    // A protected-path hard denial also blocks everywhere (path + mutating command).
    for (const posture of ['Strict', 'Auto', 'Dangerous'] as const) {
      const { bus, policy } = mountPolicy({ defaultPosture: posture })
      const input: PolicyEvalInput = { actor: 'agent-a', command: 'rm', args: ['-rf', '/etc/foo'] }
      const decision = deniedOf(policy.evaluate(input))
      assertPass(`${posture}: rm -rf on /etc is denied by the protected-path rule`, decision.rule?.id === 'deny-write-etc', JSON.stringify(decision))
      assertBlocked(policy, input)
      assertPass(`${posture}: protected-path denial also emits fleet/policy-denied`, eventsOf(bus, POLICY_EVENT_TYPES.denied).length === 1)
    }
  }

  // ---- 3. Strict = deny-by-default (allowlist only) ----
  {
    const { policy } = mountPolicy({ defaultPosture: 'Strict' })
    assertPass('Strict: ls (allowlisted) is allowed',
      policy.evaluate({ actor: 'agent-a', command: 'ls', args: ['-la'] }).allowed === true)
    assertPass('Strict: git status (allowlisted prefix) is allowed',
      policy.evaluate({ actor: 'agent-a', command: 'git', args: ['status', '--short'] }).allowed === true)
    assertPass('Strict: npm install (not allowlisted) is DENIED',
      deniedOf(policy.evaluate({ actor: 'agent-a', command: 'npm', args: ['install'] })).rule === undefined)
    assertPass('Strict: the denial reason names the missing allowlist',
      !policy.evaluate({ actor: 'agent-a', command: 'npm', args: ['install'] }).allowed)
  }

  // ---- 4. Auto vs Dangerous: the soft denial (rm -rf) ----
  {
    const auto = mountPolicy({ defaultPosture: 'Auto' })
    assertPass('Auto: npm install (unclassified) is allowed',
      auto.policy.evaluate({ actor: 'agent-a', command: 'npm', args: ['install'] }).allowed === true)
    assertPass('Auto: plain rm (no -rf) is allowed',
      auto.policy.evaluate({ actor: 'agent-a', command: 'rm', args: ['report.tmp'] }).allowed === true)
    const softDeny = deniedOf(auto.policy.evaluate({ actor: 'agent-a', command: 'rm', args: ['-rf', 'node_modules'] }))
    assertPass('Auto: rm -rf is denied by the soft denial', softDeny.rule?.id === 'deny-rm-recursive', JSON.stringify(softDeny))
    assertBlocked(auto.policy, { actor: 'agent-a', command: 'rm', args: ['-rf', 'node_modules'] })

    const dangerous = mountPolicy({ defaultPosture: 'Dangerous' })
    assertPass('Dangerous: rm -rf is PERMITTED (soft denial only blocks Auto)',
      dangerous.policy.evaluate({ actor: 'agent-a', command: 'rm', args: ['-rf', 'node_modules'] }).allowed === true)
    assertPass('Dangerous: hard denials still block (force-push)',
      deniedOf(dangerous.policy.evaluate({ actor: 'agent-a', command: 'git', args: ['push', '--force'] })).rule?.id === 'deny-git-force-push')
  }

  // ---- 5. protected paths: reads are allowed, mutating commands are denied ----
  {
    const { policy } = mountPolicy({ defaultPosture: 'Auto' })
    assertPass('Auto: cat /etc/hostname is allowed (read-only; path rule is command-scoped)',
      policy.evaluate({ actor: 'agent-a', command: 'cat', args: ['/etc/hostname'] }).allowed === true)
    const teeEtc = deniedOf(policy.evaluate({ actor: 'agent-a', command: 'tee', args: ['/etc/fstab.new'], path: '/etc/fstab.new' }))
    assertPass('Auto: tee into /etc is denied by the protected-path rule', teeEtc.rule?.id === 'deny-write-etc', JSON.stringify(teeEtc))
    assertPass('Auto: a non-protected path is not denied',
      policy.evaluate({ actor: 'agent-a', command: 'rm', args: ['-rf', 'build/'], cwd: '/home/dev/proj' }).allowed === false) // soft deny only
    // The soft deny fired (rm -rf), NOT a path rule — confirm by the rule id.
    assertPass('Auto: rm -rf in a work path is denied by the SOFT rule (path untouched)',
      deniedOf(policy.evaluate({ actor: 'agent-a', command: 'rm', args: ['-rf', 'build/'], cwd: '/home/dev/proj' })).rule?.id === 'deny-rm-recursive')
  }

  // ---- 6. tools: four policy tools registered + execute ----
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

    applyPolicy(ctx, { clock, defaultPosture: 'Auto', injectTools: true } as never)
    assertPass('apply registers the four policy tools',
      ['policy_set_posture', 'policy_get_posture', 'policy_evaluate', 'policy_guard'].every(name => registered.has(name)),
      JSON.stringify([...registered.keys()]))

    const exec = { agent: { id: 'agent-a', session: { id: 'agent-a' } } }

    const setTool = registered.get('policy_set_posture')!
    const setResult = await setTool.execute!({ posture: 'Strict' }, exec as never) as { scope: string; posture: string }
    assertPass('policy_set_posture executes (per-caller identity by default)',
      setResult.scope === 'context' && setResult.posture === 'Strict', JSON.stringify(setResult))

    const getTool = registered.get('policy_get_posture')!
    const getResult = await getTool.execute!({}, exec as never) as { context: string; effectiveFor: string; rules: unknown[] }
    assertPass('policy_get_posture executes (context + effective + rule list)',
      getResult.context === 'Strict' && getResult.effectiveFor === 'Strict' && getResult.rules.length === DEFAULT_POLICY_RULES.length)

    const evalTool = registered.get('policy_evaluate')!
    const evalResult = await evalTool.execute!({ command: 'git', args: ['push', '--force'] }, exec as never) as { allowed: boolean; rule: { id: string } }
    assertPass('policy_evaluate executes under the new Strict posture (denied, no throw)',
      evalResult.allowed === false && evalResult.rule.id === 'deny-git-force-push', JSON.stringify(evalResult))

    // Release Strict so the guard exercises the Auto soft-denial path.
    await setTool.execute!({ posture: 'Auto' }, exec as never)

    const guardTool = registered.get('policy_guard')!
    const deniedGuard = await guardTool.execute!({ command: 'rm', args: ['-rf', 'node_modules'] }, exec as never) as { allowed: boolean; reason: string }
    assertPass('policy_guard executes on a denied action (returns the denial verdict)',
      deniedGuard.allowed === false && deniedGuard.reason.includes('recursive force delete'), JSON.stringify(deniedGuard))
    const allowedGuard = await guardTool.execute!({ command: 'cat', args: ['README.md'] }, exec as never) as { allowed: boolean }
    assertPass('policy_guard executes on an allowed action', allowedGuard.allowed === true)

    const noAgent = await setTool.execute!({ posture: 'Auto' }, {} as never).then(() => false, () => true)
    assertPass('policy tools require an owning agent session', noAgent === true)
  }

  // ---- 7. events: originKind "policy" + actor attribution + posture updates + signed ----
  {
    const clock = fakeClock()
    const ctx = new CordisContext()
    const identity = new FleetAgentService(ctx, { home: mkdtempSync(join(tmpdir(), 'fleet-policy-identity-')) })
    identity.register({ agentId: 'agent-a' })
    const bus = new FleetBusService(ctx, { storeDir: mkdtempSync(join(tmpdir(), 'fleet-policy-bus-')), clock, resolveAgent: () => undefined })
    const policy = new FleetPolicyService(ctx, { clock })

    const input: PolicyEvalInput = { actor: 'agent-a', command: 'git', args: ['push', '--force'] }
    assertBlocked(policy, input)

    const denied = eventsOf(bus, POLICY_EVENT_TYPES.denied)
    assertPass('denied events carry originKind "policy" + the acting agent',
      denied.length === 1 && denied[0]!.originKind === POLICY_ORIGIN_KIND && denied[0]!.actor === 'agent-a')
    const deniedPayload = denied[0]!.payload as { signed?: FleetSignedEvent }
    assertPass('denied events embed a signed envelope when identity is available',
      deniedPayload.signed !== undefined && identity.verify(deniedPayload.signed!).ok === true)

    policy.setPosture({ kind: 'context' }, 'Strict', 'lead-1')
    const updated = eventsOf(bus, POLICY_EVENT_TYPES.updated)
    assertPass('posture changes publish fleet/policy-updated (actor + scope + posture)',
      updated.length === 1
        && updated[0]!.actor === 'lead-1'
        && updated[0]!.originKind === POLICY_ORIGIN_KIND
        && (updated[0]!.payload as { posture: string; scope: string }).posture === 'Strict'
        && (updated[0]!.payload as { scope: string }).scope === 'context',
      JSON.stringify(updated))

    const seen: Array<{ type: string; actor: string }> = []
    ctx.on('fleet-policy/event', (info) => { seen.push(info) })
    assertBlocked(policy, { actor: 'agent-a', command: 'rm', args: ['-rf', '/etc/foo'] })
    assertPass('fleet-policy/event emitted per decision (denied with actor)',
      seen.some(entry => entry.type === POLICY_EVENT_TYPES.denied && entry.actor === 'agent-a'),
      JSON.stringify(seen))
  }

  // ---- 8. LIVE flow: a Strict identity is blocked, then released by Auto ----
  {
    const { ctx, bus, policy } = mountPolicy()
    policy.setPosture({ kind: 'identity', agentId: 'agent-a' }, 'Strict', 'lead-1')

    const attempt: PolicyEvalInput = { actor: 'agent-a', command: 'npm', args: ['install'] }
    assertPass('LIVE Strict: npm install (not allowlisted) is denied',
      policy.evaluate(attempt).allowed === false)
    assertBlocked(policy, attempt)
    assertPass('LIVE Strict: the denial hit the bus', eventsOf(bus, POLICY_EVENT_TYPES.denied).length === 1)

    policy.setPosture({ kind: 'identity', agentId: 'agent-a' }, 'Auto', 'lead-1')
    assertPass('LIVE Auto: npm install is allowed again',
      policy.evaluate(attempt).allowed === true
        && policy.authorize(attempt).allowed === true
        && eventsOf(bus, POLICY_EVENT_TYPES.denied).length === 1)
    assertPass('LIVE: hard denials never release (force-push stays blocked in Auto)',
      (() => {
        try { policy.authorize({ actor: 'agent-a', command: 'git', args: ['push', '--force'] }); return false } catch { return true }
      })())
  }

  console.log('policy-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`policy-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
