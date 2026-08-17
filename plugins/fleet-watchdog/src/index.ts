/**
 * @hydra/dsh-fleet-watchdog — the V3 verification gate on stopped work
 * (issue #26, orchestration-v3 §4 P2.4, #28 — paperclip Task Watchdog).
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`). It constructs the
 * {@link FleetWatchdogService} (registers `ctx.fleetWatchdog`) and registers
 * three model-facing tools on the global `ctx.tools` registry (the fleet-tasks
 * pattern, plugins/fleet-tasks/src/index.ts:87) so ANY in-process agent can
 * assign a task tree to watch, force a verification, and inspect watch state.
 *
 * ```
 * - id: fleet-watchdog
 *   name: '@hydra/dsh-fleet-watchdog'
 *   config:
 *     reverifyWindowMs: 60000   # identical stopped state → single verification (#28)
 *     reassignAgents: {}        # role → agentId, for false-done reassignment
 * ```
 *
 * Verification is STRUCTURAL (contract present? evidence non-empty? metric in
 * passRange?) — no LLM calls. Every watchdog event publishes with
 * `originKind: 'watchdog'` (self-trigger guard) and is signed via
 * `ctx.fleetAgent` when a `watchdog` profile is registered.
 *
 * Deps: fleet-tasks REQUIRED (verification reads + reopens + reassigns through
 * it); `ctx.fleetBus` / `ctx.fleetAgent` are resolved optionally at event
 * time.
 * @module @hydra/dsh-fleet-watchdog
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { FleetWatchdogService, type FleetWatchdogConfig } from './service.ts'

export const name = 'fleet-watchdog'
/** fleet-tasks is required; ctx.fleetBus / ctx.fleetAgent are optional seams. */
export const inject: string[] = []

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetWatchdogConfig {}

export const Config: z<Config> = z.object({
  /** Injectable clock (tests only). */
  clock: z.any(),
  /** Stop-fingerprint re-verification window (ms, #28). Default 60 s. */
  reverifyWindowMs: z.number().min(0).default(60_000),
  /** Org-chart reassignment: role → agent id (false-done reassign). */
  reassignAgents: z.any(),
  /** Reassignment role resolver override (tests + policy). */
  resolveAgentForRole: z.any(),
})

export function apply(ctx: Context, config: Config): void {
  const watchdog = new FleetWatchdogService(ctx, config)
  registerFleetWatchdogTools(ctx, watchdog)
}

/** Narrow a JSON output value to a record for render-time shaping. */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Scoped tools only run inside an agent; a caller without one has no id. */
function requireAgent(agent: { id: string } | undefined): { id: string } {
  if (agent === undefined) {
    throw new Error('fleet tools require an owning agent session')
  }
  return agent
}

/** Register the three fleet-watchdog tools on the global tools registry. */
function registerFleetWatchdogTools(ctx: Context, watchdog: FleetWatchdogService): void {
  ctx.tools.register(defineTool({
    name: 'watchdog_watch',
    description: 'Assign a task tree (a top-level goal + its descendants, via goal ancestry) to the fleet watchdog. ' +
      'When every leaf of the tree rests (Completed/Cancelled), the watchdog verifies the stop against evidence ' +
      '(artifact contract present? evidence non-empty? metric in passRange?) and rejects false "done" by reopening, ' +
      'creating a review task, and reassigning the leaf. Give it the goal task id.',
    parameters: {
      treeRootId: { type: 'string', required: true, description: 'The top-level goal task id to watch.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Watch ${record?.treeRootId as string | undefined ?? '?'}: ${record?.status as string | undefined ?? '?'} (${(record?.leaves as unknown as unknown[] | undefined)?.length ?? 0} leaves)` }]
      },
    },
    async execute(args, exec) {
      requireAgent(exec.agent)
      const watch = watchdog.watch(args.treeRootId)
      return { treeRootId: watch.treeRootId, status: watch.status, createdAt: watch.createdAt, leaves: watch.leaves ?? [] } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Watch fleet task tree', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'watchdog_verify',
    description: 'Manually run the verification gate on a watched task tree: recompute the leaves and, when every leaf ' +
      'rests, verify each stopped leaf against its artifact contract. Forced — bypasses the stop-fingerprint window. ' +
      'A false-done leaf is reopened + reassigned (fleet/watchdog-reject).',
    parameters: {
      treeRootId: { type: 'string', required: true, description: 'The watched goal task id to verify.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        if (record?.rested === false) return [{ type: 'text', text: `Tree ${record.treeRootId as string | undefined ?? '?'}: not at rest — ${String(record?.reason ?? 'leaves still working')}` }]
        return [{ type: 'text', text: `Verification for ${record?.treeRootId as string | undefined ?? '?'}: ${String(record?.verdict ?? '?')} (${(record?.rejected as unknown as unknown[] | undefined)?.length ?? 0} rejected)` }]
      },
    },
    async execute(args, exec) {
      requireAgent(exec.agent)
      const result = watchdog.verify(args.treeRootId, { force: true })
      return result as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Verify fleet task tree', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'watchdog_status',
    description: 'The fleet watchdog state: every watched task tree, its lifecycle status (watching/verifying/verified/rejected), ' +
      'the stop-fingerprint dedupe window, and the last verification verdict + leaf views.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const count = (record?.watches as unknown as unknown[] | undefined)?.length ?? 0
        return [{ type: 'text', text: `Watchdog: ${count} watched tree(s), reverify window ${String(record?.reverifyWindowMs ?? '?')}ms` }]
      },
    },
    async execute() {
      return {
        reverifyWindowMs: watchdog.reverifyWindowMs,
        watches: watchdog.listWatches().map(watch => ({
          treeRootId: watch.treeRootId,
          status: watch.status,
          createdAt: watch.createdAt,
          lastVerdict: watch.lastVerdict,
          lastReason: watch.lastReason,
          stoppedFingerprint: watch.stoppedFingerprint,
          lastStoppedAt: watch.lastStoppedAt,
          lastVerifiedAt: watch.lastVerifiedAt,
          leaves: watch.leaves ?? [],
        })),
      } as unknown as JsonValue
    },
    presentCall: () => ({ card: 'generic', title: 'Fleet watchdog status', kind: 'other', rawInput: null }),
  }))
}
