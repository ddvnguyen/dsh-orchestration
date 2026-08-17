/**
 * @hydra/dsh-fleet-bus — the V3 event foundation: a fleet-level event store
 * with publish / subscribe / replay and delivery to agents via
 * `agent.followup` (wake) / `agent.inject` (quiet inbox).
 *
 * Registers `ctx.fleetBus` (Cordis Service, {@link FleetBusService}) and four
 * model-facing tools on the global `ctx.tools` registry (the tool-todo
 * pattern, packages/todo/tool-todo/src/index.ts:149) so ANY in-process agent
 * can publish, subscribe, unsubscribe, and replay fleet events. The tools use
 * `exec.agent` for caller identity (packages/core/tools/src/index.ts:360-361).
 *
 * ```
 * - id: fleet-bus
 *   name: '@hydra/dsh-fleet-bus'
 *   config:
 *     storeDir: ''      # default $DSH_HOME/fleet (durable JSONL store)
 * ```
 * @module @hydra/dsh-fleet-bus
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { type JsonValue } from '@deepseek-ai/dsh-session'
import { FleetBusService, type FleetBusServiceConfig } from './service.ts'
import type { FleetBusEvent, FleetBusScope } from './types.ts'

export const name = 'fleet-bus'
/** Self-contained: ctx.agents is resolved optionally at delivery time. */
export const inject: string[] = []

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetBusServiceConfig {}

export const Config: z<Config> = z.object({
  /** Directory holding the durable event store. Default `$DSH_HOME/fleet`. */
  storeDir: z.string(),
  /** Store file name. Default `fleet-bus.jsonl`. */
  storeFile: z.string(),
  /** Injectable clock (tests only). */
  clock: z.any(),
  /** Delivery-target resolver override (tests only). */
  resolveAgent: z.any(),
})

export function apply(ctx: Context, config: Config): void {
  const bus = new FleetBusService(ctx, config)
  registerFleetBusTools(ctx, bus)
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

/** Register the four fleet-bus tools on the global tools registry. */
function registerFleetBusTools(ctx: Context, bus: FleetBusService): void {
  ctx.tools.register(defineTool({
    name: 'fleet_publish',
    description: 'Publish a fleet event. Every subscription whose filter matches the event type/scope receives it — ' +
      'as a follow-up turn (wake mode) or a quiet inbox push (inject mode) — and the event is durably stored, ' +
      'replayable later via fleet_events.',
    parameters: {
      type: { type: 'string', required: true, description: 'Event type, e.g. "build.status", "task.done".' },
      payload: { type: 'object', additionalProperties: true, required: true, description: 'JSON payload carried by the event.' },
      scope: { type: 'string', enum: ['agent', 'team', 'fleet'], description: 'Event scope (default fleet).' },
      actor: { type: 'string', description: 'Acting agent id (default: the calling agent).' },
      originKind: { type: 'string', description: 'Producing mechanism, e.g. "agent", "watchdog", "scheduler" (default "agent").' },
      fingerprint: { type: 'string', description: 'Optional SHA-256 of the trigger-relevant state for wake dedupe.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Published fleet-bus event ${record?.id as string | undefined ?? '?'} (seq ${record?.seq as number | undefined ?? '?'})` }]
      },
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const event: FleetBusEvent = bus.publish({
        type: args.type,
        payload: args.payload,
        scope: args.scope ?? 'fleet',
        actor: args.actor ?? caller.id,
        ...(args.originKind !== undefined ? { originKind: args.originKind } : {}),
        ...(args.fingerprint !== undefined ? { fingerprint: args.fingerprint } : {}),
      })
      return { id: event.id, seq: event.seq, ts: event.ts, scope: event.scope, originKind: event.originKind }
    },
    presentCall: args => ({ card: 'generic', title: 'Publish fleet event', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_subscribe',
    description: 'Subscribe the calling agent (or another agent) to fleet events matching a type/scope filter. ' +
      'Matching published events are delivered per mode: "wake" as an ordinary follow-up turn (agent.followup), ' +
      '"inject" as a quiet inbox push (agent.inject) that surfaces on the next step. Returns the subscriptionId ' +
      'for fleet_unsubscribe.',
    parameters: {
      type: { type: 'string', description: 'Only match events with exactly this type (omit for any type).' },
      scope: { type: 'string', enum: ['agent', 'team', 'fleet'], description: 'Only match events with exactly this scope (omit for any scope).' },
      excludeOriginKinds: { type: 'array', items: { type: 'string' }, description: 'Do NOT deliver events produced by these mechanisms — prevents self-triggering (e.g. a watchdog excludes "watchdog").' },
      mode: { type: 'string', enum: ['wake', 'inject'], description: 'Delivery mode (default inject).' },
      agentId: { type: 'string', description: 'Receiving agent id (default: the calling agent).' },
      dedupeMs: { type: 'integer', description: 'Wake-dedupe window: suppress re-wake for an identical trigger fingerprint within this many ms (default: no dedupe).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Subscribed ${record?.agentId as string | undefined ?? '?'} to fleet-bus as ${record?.subscriptionId as string | undefined ?? '?'}` }]
      },
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const subscription = bus.subscribe(
        args.agentId ?? caller.id,
        {
          ...(args.type !== undefined ? { type: args.type } : {}),
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.excludeOriginKinds !== undefined && args.excludeOriginKinds.length > 0
            ? { excludeOriginKinds: args.excludeOriginKinds }
            : {}),
        },
        args.mode ?? 'inject',
        args.dedupeMs !== undefined ? { dedupeMs: args.dedupeMs } : {},
      )
      return {
        subscriptionId: subscription.id,
        agentId: subscription.agentId,
        mode: subscription.mode,
        filter: {
          ...(subscription.filter.type !== undefined ? { type: subscription.filter.type } : {}),
          ...(subscription.filter.scope !== undefined ? { scope: subscription.filter.scope } : {}),
          ...(subscription.filter.excludeOriginKinds !== undefined
            ? { excludeOriginKinds: subscription.filter.excludeOriginKinds }
            : {}),
        },
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Subscribe to fleet events', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_unsubscribe',
    description: 'Remove a fleet-bus subscription by its id (returned by fleet_subscribe).',
    parameters: {
      subscriptionId: { type: 'string', required: true, description: 'The subscription id to remove.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: record?.ok === true ? 'Unsubscribed' : 'Subscription not found' }]
      },
    },
    async execute(args) {
      return { ok: bus.unsubscribe(args.subscriptionId) }
    },
    presentCall: args => ({ card: 'generic', title: 'Unsubscribe from fleet events', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_events',
    description: 'Replay past fleet-bus events matching an optional type/scope filter, optionally only those on or ' +
      'after a unix-epoch-ms timestamp. Use it to learn what happened in the fleet before this turn.',
    parameters: {
      type: { type: 'string', description: 'Only return events with exactly this type (omit for any type).' },
      scope: { type: 'string', enum: ['agent', 'team', 'fleet'], description: 'Only return events with exactly this scope (omit for any scope).' },
      since: { type: 'integer', description: 'Only return events with ts >= since (unix epoch ms).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Fleet events: ${record?.count as number | undefined ?? 0} matching (see structuredContent)` }]
      },
    },
    async execute(args) {
      const events = bus.replay(
        {
          ...(args.type !== undefined ? { type: args.type } : {}),
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
        },
        args.since,
      ).map(event => ({
        id: event.id, type: event.type, scope: event.scope, actor: event.actor,
        payload: event.payload, ts: event.ts, seq: event.seq,
      }))
      return { count: events.length, events }
    },
    presentCall: args => ({ card: 'generic', title: 'Replay fleet events', kind: 'other', rawInput: args }),
  }))
}

/** Re-export the vocabulary for consumers of the plugin. */
export type { FleetBusEvent, FleetBusScope } from './types.ts'
