/**
 * @hydra/dsh-fleet-policy — the QM posture + command-policy layer (issue #26,
 * orchestration-v3 §4 P3.1).
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`). It constructs the
 * {@link FleetPolicyService} (registers `ctx.fleetPolicy`) and registers four
 * model-facing tools on the global `ctx.tools` registry (the fleet-tasks
 * pattern, plugins/fleet-tasks/src/index.ts:87) so ANY in-process agent can
 * set/get a QM posture, pre-flight a command, and route an action through the
 * enforcement guard.
 *
 * ```
 * - id: fleet-policy
 *   name: '@hydra/dsh-fleet-policy'
 *   config:
 *     defaultPosture: Auto    # Strict | Auto | Dangerous (context default)
 *     rules: []               # custom rule set (default: DEFAULT_POLICY_RULES)
 * ```
 *
 * Postures: `Strict` deny-by-default (allowlist only), `Auto` routine-safe
 * (hard + soft denials block), `Dangerous` only hard denials block. HARD
 * denials (destructive commands + mutating commands on protected paths) apply
 * in EVERY posture. A denied action is BLOCKED: `authorize()` refuses (throws
 * {@link PolicyDeniedError}) and publishes `fleet/policy-denied` with the rule
 * + actor. `ctx.fleetBus` / `ctx.fleetAgent` are optional event seams.
 *
 * Deps: self-contained — `ctx.fleetBus` (event publish) and `ctx.fleetAgent`
 * (signed events) are resolved optionally at decision time.
 * @module @hydra/dsh-fleet-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { FleetPolicyService, type FleetPolicyConfig } from './service.ts'
import { PolicyDeniedError, policyRuleToJson, type PolicyEvalInput, type PolicyPosture } from './types.ts'

export const name = 'fleet-policy'
/** Self-contained: ctx.fleetBus / ctx.fleetAgent are resolved optionally. */
export const inject: string[] = ['tools']

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetPolicyConfig {
  /** Register the policy_* tools on ctx.tools (default true). Host-plane compositions set false. */
  injectTools: boolean
}

export const Config: z<Config> = z.object({
  /** Injectable clock (tests only). */
  clock: z.any(),
  /** Context-wide (default) posture. Default `Auto`. */
  defaultPosture: z.union(['Strict', 'Auto', 'Dangerous'] as const).default('Auto'),
  /** Custom rule set (default: the built-in hard denials + Strict allowlist). */
  rules: z.any(),
  /** Register tools (default true). Host-plane compositions set false. */
  injectTools: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const policy = new FleetPolicyService(ctx, config)
  if (config.injectTools) {
    registerFleetPolicyTools(ctx, policy)
  }
}

/** Scoped tools only run inside an agent; a caller without one has no id. */
function requireAgent(agent: { id: string } | undefined): { id: string } {
  if (agent === undefined) {
    throw new Error('fleet tools require an owning agent session')
  }
  return agent
}

/** Narrow a JSON output value to a record for render-time shaping. */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** The action params shared by `policy_evaluate` and `policy_guard`. */
function actionInput(caller: { id: string }, args: { command: string; args?: string[]; cwd?: string; path?: string }): PolicyEvalInput {
  return {
    actor: caller.id,
    command: args.command,
    ...(args.args !== undefined ? { args: args.args } : {}),
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.path !== undefined ? { path: args.path } : {}),
  }
}

function renderVerdict(value: JsonValue | undefined): { type: 'text'; text: string }[] {
  const record = asRecord(value)
  if (record === undefined) return [{ type: 'text', text: 'policy: no decision returned' }]
  const denied = record.allowed === false
  const verdict = denied ? 'DENIED' : 'ALLOWED'
  const posture = String(record.posture ?? '?')
  const rule = record.rule === undefined ? '' : ` [${String((record.rule as Record<string, JsonValue>).id ?? '?')}]`
  return [{ type: 'text', text: `policy (${posture}): ${verdict}${rule} — ${String(record.reason ?? '')}` }]
}

/** Register the four fleet-policy tools on the global tools registry. */
function registerFleetPolicyTools(ctx: Context, policy: FleetPolicyService): void {
  ctx.tools.register(defineTool({
    name: 'policy_set_posture',
    description: 'Set the QM posture for a scope. Postures: Strict (deny-by-default — only allowlisted commands run), ' +
      'Auto (routine-safe by default — hard + soft denials block), Dangerous (only the hard denials block). ' +
      'Per-identity overrides the context default; "context" sets the fleet-wide default. ' +
      'Hard denials (force-push, reset --hard, mkfs/dd/shutdown, mutating /etc|/boot|/root) apply in EVERY posture.',
    parameters: {
      posture: { type: 'string', enum: ['Strict', 'Auto', 'Dangerous'], required: true, description: 'The QM posture to set.' },
      scope: { type: 'string', description: 'Set for this agent id, or "context" for the fleet-wide default (default: the calling agent).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `policy: ${String(record?.scope ?? '?')} → ${String(record?.posture ?? '?')}` }]
      },
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const scope = args.scope === undefined || args.scope === 'context'
        ? { kind: 'context' as const }
        : { kind: 'identity' as const, agentId: args.scope }
      const posture = policy.setPosture(scope, args.posture as PolicyPosture, caller.id)
      return {
        scope: scope.kind === 'context' ? 'context' : scope.agentId,
        posture,
        effective: policy.getPosture({ kind: 'identity', agentId: caller.id }),
      } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Set fleet policy posture', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'policy_get_posture',
    description: 'Inspect the current command policy: the context posture, any per-identity overrides, and the active rule set ' +
      '(hard denials + Strict allowlist). Use it before acting to know what a command will be evaluated against.',
    parameters: {
      agentId: { type: 'string', description: 'Resolve the effective posture for this agent id (default: the calling agent).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const count = (record?.rules as unknown as unknown[] | undefined)?.length ?? 0
        return [{ type: 'text', text: `policy: context ${String(record?.context ?? '?')}, ${count} rule(s)` }]
      },
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const status = policy.status()
      return {
        context: status.context,
        identities: status.identities,
        effectiveFor: policy.getPosture({ kind: 'identity', agentId: args.agentId ?? caller.id }),
        rules: status.rules.map(rule => policyRuleToJson(rule)),
      } as unknown as JsonValue
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect fleet policy', kind: 'other', rawInput: null }),
  }))

  ctx.tools.register(defineTool({
    name: 'policy_evaluate',
    description: 'Pre-flight a command against the command policy — pure check, no enforcement. Returns whether the action is ' +
      'allowed under the caller\'s effective posture and the rule that decides it (or "not on the Strict allowlist"). ' +
      'Hard denials block in every posture; in Strict only allowlisted commands run; in Auto soft denials (e.g. rm -rf) block; ' +
      'in Dangerous only hard denials block.',
    parameters: {
      command: { type: 'string', required: true, description: 'The command name (e.g. "git", "rm", "npm").' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (e.g. ["push", "--force"]).' },
      path: { type: 'string', description: 'The path the command targets (e.g. "/etc/hosts" for a protected-path check).' },
      cwd: { type: 'string', description: 'Working directory, to resolve a relative target path.' },
    },
    output: {
      schema: { type: 'json' },
      render: renderVerdict,
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const decision = policy.evaluate(actionInput(caller, args))
      return {
        allowed: decision.allowed,
        posture: decision.posture,
        ...(decision.rule !== undefined ? { rule: policyRuleToJson(decision.rule) } : {}),
        reason: decision.reason,
      } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Evaluate command against policy', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'policy_guard',
    description: 'Enforce the command policy: evaluate the action AND, on a denial, refuse it (the service throws) and publish ' +
      'fleet/policy-denied with the rule + actor. A denied action is BLOCKED — route anything destructive through this before ' +
      'executing. Returns the decision; check `allowed` before running the command.',
    parameters: {
      command: { type: 'string', required: true, description: 'The command name (e.g. "git", "rm").' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (e.g. ["push", "--force"]).' },
      path: { type: 'string', description: 'The path the command targets (e.g. "/etc/hosts").' },
      cwd: { type: 'string', description: 'Working directory, to resolve a relative target path.' },
    },
    output: {
      schema: { type: 'json' },
      render: renderVerdict,
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const input = actionInput(caller, args)
      try {
        const decision = policy.authorize(input)
        return {
          allowed: true,
          posture: decision.posture,
          ...(decision.rule !== undefined ? { rule: policyRuleToJson(decision.rule) } : {}),
          reason: decision.reason,
        } as unknown as JsonValue
      } catch (error) {
        if (error instanceof PolicyDeniedError) {
          return {
            allowed: false,
            posture: error.decision.posture,
            ...(error.decision.rule !== undefined ? { rule: policyRuleToJson(error.decision.rule) } : {}),
            reason: error.decision.reason,
          } as unknown as JsonValue
        }
        throw error
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Guard command with policy', kind: 'other', rawInput: args }),
  }))
}

/** Re-export the vocabulary for consumers of the plugin. */
export type { PolicyDecision, PolicyEvalInput, PolicyPosture, PolicyRule, PolicyScope, PolicyStatus } from './types.ts'
export { DEFAULT_POLICY_RULES, POLICY_ACTOR, POLICY_EVENT_TYPES, POLICY_ORIGIN_KIND } from './service.ts'
