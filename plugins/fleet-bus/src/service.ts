/**
 * FleetBusService — the `ctx.fleetBus` Cordis service behind the fleet-bus
 * plugin (issue #26, orchestration-v3 §4 P0.1).
 *
 * The fleet-level event foundation: a durable event store
 * ({@link FleetEventStore}, append-only JSONL under `$DSH_HOME/fleet`),
 * publish → subscriber fan-out with per-agent delivery, and replay of past
 * events. Registration pattern follows the family's FleetService
 * (`super(ctx, key)` in vendor/cordis/src/service.ts:35-57) and a `fleet-bus/event`
 * Cordis event per publish (mirroring fleet-heartbeat's `fleet/event`).
 *
 * DELIVERY SEAM (file:line in the dsh submodule):
 * - `Agent.followup(message: UserMessage): void` — packages/core/agent/src/runtime-types.ts:124
 *   ("Queue an ordinary follow-up turn and wake the driver") = `wake` mode.
 * - `Agent.inject(message: UserMessage): void` — packages/core/agent/src/runtime-types.ts:143
 *   ("Queue model-facing context for the next pre-step without waking the driver") = `inject` mode.
 * - The live Agent is resolved through the agent registry,
 *   `AgentRegistry.get(id: SessionId)` at packages/core/agent/src/index.ts:583,
 *   read here via the optional `ctx.get('agents')` service access
 *   (returns `undefined` when the registry is not composed — the same
 *   optional pattern as bundle/headless/src/index.ts:100-104).
 * - Only IN-PROCESS dsh agents (root or subagent) are registered in the agent
 *   registry, so only those receive live delivery. Out-of-process children
 *   (claude-code / acp) are not reachable via followup/inject; they observe
 *   the bus through the `fleet_events` replay tool (documented seam, see README).
 * @module @hydra/dsh-fleet-bus/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { systemClock, type FleetClock } from '../../../src/types.ts'
import { computeFingerprint } from './fingerprint.ts'
import { FleetEventStore } from './store.ts'
import {
  fleetBusEventToMessage,
  matchesFleetBusFilter,
  type FleetBusDeliveryMode,
  type FleetBusEvent,
  type FleetBusEventInput,
  type FleetBusFilter,
  type FleetBusSubscription,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetBus: FleetBusService
  }

  interface Events {
    /**
     * One fleet-bus event was published (emitted synchronously after the
     * durable append and fan-out). Observers use it for feeds, digests, or
     * policies — fleet-board (P1.2) is the intended consumer.
     * @param event - the published event.
     * @mode emit
     */
    'fleet-bus/event'(event: FleetBusEvent): void
  }
}

/** The minimal live-agent surface delivery needs (structural: Agent satisfies it). */
export interface FleetBusDeliveryTarget {
  followup(message: UserMessage): void
  inject(message: UserMessage): void
}

/** Structural view of the agent registry used for optional delivery lookup. */
interface AgentRegistryLike {
  get(id: SessionId): { followup(message: UserMessage): void; inject(message: UserMessage): void } | undefined
}

export interface FleetBusServiceConfig {
  /** Directory holding the durable store. Default `$DSH_HOME/fleet`. */
  storeDir?: string
  /** Store file name. Default `fleet-bus.jsonl`. */
  storeFile?: string
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /**
   * Resolve the delivery target for a subscribed agent id. Defaults to the
   * live in-process agent registry (`ctx.get('agents')`); tests inject fake
   * targets so no real agent loop is needed.
   */
  resolveAgent?: (agentId: string) => FleetBusDeliveryTarget | undefined
}

export interface FleetBusSubscribeOptions {
  /**
   * Wake-dedupe window (ms). When set, identical wake triggers — same
   * effective fingerprint (event.fingerprint or the payload hash) — delivered
   * to this subscriber within the window are suppressed. Default unset =
   * every matching event wakes.
   */
  dedupeMs?: number
}

export class FleetBusService extends Service {
  readonly store: FleetEventStore
  private readonly clock: FleetClock
  private readonly resolveAgent: (agentId: string) => FleetBusDeliveryTarget | undefined
  private readonly subscriptions = new Map<string, FleetBusSubscription>()
  /** Wake dedupe: `${subscriptionId}:${fingerprint}` -> last-wake ts (service clock). */
  private readonly wakeDedupe = new Map<string, number>()
  private subscriptionSeq = 0

  constructor(ctx: Context, config: FleetBusServiceConfig = {}) {
    super(ctx, 'fleetBus')
    this.clock = config.clock ?? systemClock
    this.resolveAgent = config.resolveAgent ?? ((agentId) => this.lookupLiveAgent(agentId))
    this.store = new FleetEventStore({ dir: config.storeDir, file: config.storeFile })
  }

  /** Live subscriptions (test/observability surface). */
  listSubscriptions(): readonly FleetBusSubscription[] {
    return [...this.subscriptions.values()]
  }

  /**
   * Persist one event, emit `fleet-bus/event`, and fan it out to every
   * matching subscription (delivery per the subscription's mode).
   * @param input - event type/scope/actor/originKind/payload; id/ts/seq are assigned.
   * @returns the stored, fully-assigned event.
   */
  publish(input: FleetBusEventInput): FleetBusEvent {
    if (input.type.length === 0) throw new Error('fleet-bus: event type must be non-empty')
    if (input.actor.length === 0) throw new Error('fleet-bus: event actor must be non-empty')
    const events = this.store.list()
    const seq = (events[events.length - 1]?.seq ?? 0) + 1
    const event: FleetBusEvent = {
      id: `${input.type}-${seq}`,
      type: input.type,
      scope: input.scope ?? 'fleet',
      actor: input.actor,
      originKind: input.originKind ?? 'agent',
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
      payload: input.payload,
      ts: this.clock.now(),
      seq,
    }
    this.store.append(event)
    this.ctx.emit('fleet-bus/event', event)
    this.fanout(event)
    return event
  }

  /**
   * Subscribe one agent to events matching a filter.
   * @param agentId - receiving agent id (resolved for delivery via the
   *   configured resolver; for real dsh agents this is also their SessionId).
   * @param filter - event type/scope/excluded-originKind predicate; empty matches every event.
   * @param mode - `wake` (agent.followup) or `inject` (agent.inject). Default `inject`.
   * @param options - wake-dedupe window and other delivery options.
   * @returns the subscription (also the key to unsubscribe).
   */
  subscribe(
    agentId: string,
    filter: FleetBusFilter = {},
    mode: FleetBusDeliveryMode = 'inject',
    options: FleetBusSubscribeOptions = {},
  ): FleetBusSubscription {
    const subscription: FleetBusSubscription = {
      id: `fleet-bus-sub-${++this.subscriptionSeq}`,
      agentId,
      filter,
      mode,
      ...(options.dedupeMs !== undefined ? { dedupeMs: options.dedupeMs } : {}),
    }
    this.subscriptions.set(subscription.id, subscription)
    return subscription
  }

  /** Remove a subscription; returns true when one existed. */
  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId)
  }

  /**
   * Return stored events matching a filter, optionally from a timestamp cutoff.
   * @param filter - event type/scope predicate; empty matches every event.
   * @param since - only events with `ts >= since` (unix epoch ms).
   * @returns matching events in seq order.
   */
  replay(filter: FleetBusFilter = {}, since?: number): FleetBusEvent[] {
    return this.store.list().filter(event => {
      if (!matchesFleetBusFilter(filter, event)) return false
      if (since !== undefined && event.ts < since) return false
      return true
    })
  }

  private fanout(event: FleetBusEvent): void {
    for (const subscription of this.subscriptions.values()) {
      if (!matchesFleetBusFilter(subscription.filter, event)) continue
      this.deliver(subscription, event)
    }
  }

  private deliver(subscription: FleetBusSubscription, event: FleetBusEvent): void {
    if (subscription.mode === 'wake' && this.isDedupedWake(subscription, event)) return
    const target = this.resolveAgent(subscription.agentId)
    if (target === undefined) {
      this.ctx.logger.debug(
        `fleet-bus: no live delivery target for subscription ${subscription.id} (agent "${subscription.agentId}"); `,
      )
      return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: fleetBusEventToMessage(event) }],
      // Same plugin source fleet-inject uses for delivered fleet messages
      // (MessageSource plugin kind: packages/llm/llm/src/message.ts:100-105).
      source: { kind: 'plugin', plugin: 'hydra/dsh-fleet' },
    })
    if (subscription.mode === 'wake') target.followup(message)
    else target.inject(message)
  }

  /**
   * Wake-storm guard: an identical trigger fingerprint delivered to this
   * subscriber within its dedupe window is suppressed. The effective
   * fingerprint is the event's explicit `fingerprint` (publisher-scoped to
   * trigger-relevant fields) or, when absent, the SHA-256 of the full payload.
   */
  private isDedupedWake(subscription: FleetBusSubscription, event: FleetBusEvent): boolean {
    const dedupeMs = subscription.dedupeMs
    if (dedupeMs === undefined) return false
    const effectiveFingerprint = event.fingerprint ?? computeFingerprint(event.payload)
    const key = `${subscription.id}:${effectiveFingerprint}`
    const now = this.clock.now()
    const lastWake = this.wakeDedupe.get(key)
    if (lastWake !== undefined && now - lastWake < dedupeMs) {
      this.ctx.logger.debug(
        `fleet-bus: suppressed duplicate wake for ${subscription.id} (fingerprint ${effectiveFingerprint.slice(0, 8)}…)`,
      )
      return true
    }
    // Record (or refresh) the wake; entries age out and are pruned lazily on
    // the next identical trigger.
    this.wakeDedupe.set(key, now)
    return false
  }

  private lookupLiveAgent(agentId: string): FleetBusDeliveryTarget | undefined {
    // Optional service access: returns undefined when the agent registry is
    // not composed (per the AGENTS.md rule, optional services use ctx.get).
    const agents = this.ctx.get('agents') as AgentRegistryLike | undefined
    return agents?.get(SessionId(agentId))
  }
}
