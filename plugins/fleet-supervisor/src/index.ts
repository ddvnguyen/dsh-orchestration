/**
 * @hydra/dsh-fleet-supervisor — the V3 fleet supervisor: fleet timers, the
 * fleet-scheduler (heartbeat-wake execution), takeover, orphan recovery,
 * digests, the ready-queue, the #28 silent active-run watchdog, and the
 * verification-gated merge queue.
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`). It constructs the
 * {@link FleetSupervisorService} (registers `ctx.fleetSupervisor`) and
 * registers five model-facing tools on the global `ctx.tools` registry (the
 * fleet-bus pattern, plugins/fleet-bus/src/index.ts:65) so ANY in-process
 * agent can wake work, inspect the queues, force a digest, and drive the merge
 * queue. Every supervisor event uses `originKind: 'supervisor'` (self-trigger
 * guard) and is signed via `ctx.fleetAgent` when a `supervisor` profile is
 * registered.
 *
 * ```
 * - id: fleet-supervisor
 *   name: '@hydra/dsh-fleet-supervisor'
 *   config:
 *     tickMs: 30000            # 30 s heartbeat tick (default)
 *     orphanThresholdMs: 900000    # 15 min: woken run died → re-due
 *     silentThresholdMs: 600000    # 10 min: active-but-silent → fleet/silent-run (#28)
 *     digestIntervalMs: 600000     # 10 min: periodic fleet/digest
 *     budgetRetryMs: 300000        # budget-blocked entries retry after 5 min
 *     storeDir: ''             # default $DSH_HOME/fleet (durable wake queue)
 * ```
 * @module @hydra/dsh-fleet-supervisor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  FleetSupervisorService,
  type FleetSupervisorConfig,
  type FleetSupervisorDeliveryTarget,
} from './service.ts'
import type { MergeGate, WakeEntryInput } from './types.ts'

export const name = 'fleet-supervisor'
/** Self-contained: ctx.fleet / fleetBus / fleetAgent / fleetTasks / skills are optional seams. */
export const inject: string[] = []

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetSupervisorConfig {}

export const Config: z<Config> = z.object({
  /** Tick timer cadence (ms). */
  tickMs: z.number().min(1).default(30_000),
  /** Directory holding the durable wake queue. Default `$DSH_HOME/fleet`. */
  storeDir: z.string(),
  /** Wake queue file name. Default `fleet-wake-queue.jsonl`. */
  storeFile: z.string(),
  /** Injectable clock (tests only). */
  clock: z.any(),
  /** Delivery-target resolver override (tests only). */
  resolveAgent: z.any(),
  /** Takeover successor resolver (tests + policy). */
  successorFor: z.any(),
  /** Woken-run window before orphan recovery re-dues the entry. */
  orphanThresholdMs: z.number().min(1).default(15 * 60_000),
  /** Active-but-silent window before `fleet/silent-run` fires (#28). */
  silentThresholdMs: z.number().min(1).default(10 * 60_000),
  /** Re-arm interval for repeated silent-run signals on one agent. */
  silentResendMs: z.number().min(1).default(60_000),
  /** Digest emission interval. */
  digestIntervalMs: z.number().min(1).default(10 * 60_000),
  /** Budget-deferred entries re-enter the due scan after this delay. */
  budgetRetryMs: z.number().min(1).default(5 * 60_000),
  /** Named verification gates the merge queue resolves at enqueue (#28). */
  mergeGates: z.any(),
})

export function apply(ctx: Context, config: Config): void {
  new FleetSupervisorService(ctx, config)
  registerFleetSupervisorTools(ctx, config)
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

/** Register the five fleet-supervisor tools on the global tools registry. */
function registerFleetSupervisorTools(ctx: Context, config: Config): void {
  const supervisor = new FleetSupervisorService(ctx, config)

  ctx.tools.register(defineTool({
    name: 'fleet_wake',
    description: 'Wake a fleet agent with a piece of work (the fleet-scheduler): enqueue a durable wake entry ' +
      'targeting the agent; the supervisor delivers it as a follow-up turn once due (immediately by default). ' +
      'Pass kind/context describing the work; optional skillNames inject the skill content into the wake prompt.',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Target agent id to wake.' },
      kind: { type: 'string', default: 'manual', description: 'Wake kind, e.g. "task-claim", "cron", "routine", "notify".' },
      context: { type: 'object', additionalProperties: true, default: {}, description: 'JSON payload describing the work.' },
      skillNames: { type: 'array', items: { type: 'string' }, description: 'Skills to inject into the wake prompt.' },
      dueInMs: { type: 'integer', description: 'Delay the wake by this many ms (default 0 = wake now).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Wake queued: ${record?.entryId as string | undefined ?? '?'} for ${record?.agentId as string | undefined ?? '?'} (status ${record?.status as string | undefined ?? '?'})` }]
      },
    },
    async execute(args, exec) {
      requireAgent(exec.agent)
      const dueAt = args.dueInMs !== undefined && args.dueInMs > 0 ? Date.now() + args.dueInMs : undefined
      const entry = await supervisor.wakeNow(args.agentId, {
        kind: args.kind ?? 'manual',
        context: (args.context ?? {}) as JsonValue,
        ...(args.skillNames !== undefined && args.skillNames.length > 0 ? { skillNames: args.skillNames } : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
      } as Omit<WakeEntryInput, 'targetAgentId'>)
      return { entryId: entry.id, agentId: entry.targetAgentId, status: entry.status, dueAt: entry.dueAt }
    },
    presentCall: args => ({ card: 'generic', title: 'Wake fleet agent', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_queue_status',
    description: 'Current supervisor queues: pending/woken/completed/blocked wake entries, the ready-queue rollup ' +
      '(fleet-tasks unstarted tasks; empty when fleet-tasks is absent), and the verification-gated merge queue.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Wake queue: ${record?.pendingWakes as number | undefined ?? 0} pending · Ready: ${record?.readyQueueLength as number | undefined ?? 0} · Merge: ${record?.mergeEntries as number | undefined ?? 0}` }]
      },
    },
    async execute() {
      const entries = supervisor.listWakeQueue()
      const pendingWakes = entries.filter(entry => entry.status === 'pending').length
      return {
        pendingWakes,
        wakes: entries.map(entry => ({
          id: entry.id, agentId: entry.targetAgentId, kind: entry.kind,
          status: entry.status, dueAt: entry.dueAt,
        })),
        readyQueueLength: supervisor.readyQueue().length,
        readyQueue: supervisor.readyQueue(),
        mergeEntries: supervisor.listMergeQueue().length,
        merge: supervisor.listMergeQueue().map(entry => ({
          id: entry.id, title: entry.title, target: entry.target, sourceRef: entry.sourceRef,
          status: entry.status, isolated: entry.isolated, attempts: entry.attempts,
        })),
        mergeGates: supervisor.listMergeGates(),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Fleet queue status', kind: 'other', rawInput: null }),
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_digest_now',
    description: 'Emit a fleet digest immediately: agents, active/stalled/silent counts, pending wakes, ' +
      'ready-queue length, and recent fleet-bus activity. Published as a fleet/digest event (consumable by fleet-board).',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Digest emitted: ${record?.activeCount as number | undefined ?? 0} active, ${record?.stalledCount as number | undefined ?? 0} stalled, ${record?.readyQueueLength as number | undefined ?? 0} ready` }]
      },
    },
    async execute() {
      const summary = supervisor.emitDigest()
      return summary as unknown as JsonValue
    },
    presentCall: () => ({ card: 'generic', title: 'Emit fleet digest now', kind: 'other', rawInput: null }),
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_merge_enqueue',
    description: 'Enqueue a verification-gated merge (#28): the entry lands only when every named gate passes. ' +
      'On a failing gate the entry is isolated and a merge-fix wake is re-dispatched to the owner agent. ' +
      'Gates are named checks registered by the supervisor (full GitHub CI integration is out of scope).',
    parameters: {
      title: { type: 'string', required: true, description: 'Short description of the merge.' },
      target: { type: 'string', required: true, description: 'Target branch/ref the entry would land on.' },
      sourceRef: { type: 'string', required: true, description: 'Source ref/branch the entry represents.' },
      ownerAgentId: { type: 'string', required: true, description: 'Agent re-dispatched the fix when a gate fails.' },
      gateNames: { type: 'array', items: { type: 'string' }, required: true, description: 'Named verification gates that must all pass.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Merge enqueued: ${record?.id as string | undefined ?? '?'} (${record?.status as string | undefined ?? '?'}) gates=${JSON.stringify(record?.gates)}` }]
      },
    },
    async execute(args, exec) {
      requireAgent(exec.agent)
      const entry = supervisor.enqueueMerge({
        title: args.title,
        target: args.target,
        sourceRef: args.sourceRef,
        ownerAgentId: args.ownerAgentId,
        gateNames: args.gateNames,
      })
      return { id: entry.id, title: entry.title, target: entry.target, sourceRef: entry.sourceRef, status: entry.status, gates: entry.gates.map(gate => gate.name) }
    },
    presentCall: args => ({ card: 'generic', title: 'Enqueue verification-gated merge', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_merge_status',
    description: 'The verification-gated merge queue: every entry, its status (pending/verifying/merged/failed), ' +
      'isolation flag, attempt count, and the registered gate names.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Merge queue: ${record?.count as number | undefined ?? 0} entries` }]
      },
    },
    async execute() {
      return {
        count: supervisor.listMergeQueue().length,
        entries: supervisor.listMergeQueue().map(entry => ({
          id: entry.id, title: entry.title, target: entry.target, sourceRef: entry.sourceRef,
          status: entry.status, isolated: entry.isolated, attempts: entry.attempts,
          gates: entry.gates.map(gate => gate.name),
          lastResult: entry.lastResult,
        })),
        gates: supervisor.listMergeGates(),
      } as unknown as JsonValue
    },
    presentCall: () => ({ card: 'generic', title: 'Fleet merge status', kind: 'other', rawInput: null }),
  }))
}

/** Re-export the merge-gate vocabulary for plugin consumers. */
export type { FleetSupervisorDeliveryTarget, MergeGate }
