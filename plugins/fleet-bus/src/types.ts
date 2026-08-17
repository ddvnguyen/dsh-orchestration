/**
 * fleet-bus vocabulary: the fleet-level event model, filters, subscriptions,
 * and delivery modes for the V3 event foundation (issue #26).
 *
 * An event is one durable, replayable fact about the fleet
 * (`type` + `scope` + `actor` + `payload` at a point in time). A subscription
 * pins one agent to a filter (event `type` / `scope`) and a delivery mode:
 * `wake` (agent.followup — an ordinary follow-up turn) or `inject`
 * (agent.inject — quiet inbox push, no wake).
 * @module @hydra/dsh-fleet-bus/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** Which world an event belongs to: one agent, a team, or the whole fleet. */
export type FleetBusScope = 'agent' | 'team' | 'fleet'

/**
 * How a matching event reaches the subscribed agent:
 * - `wake`: `agent.followup(message)` — an ordinary later turn, wakes an idle driver.
 * - `inject`: `agent.inject(message)` — model-facing context for the next step, no wake.
 */
export type FleetBusDeliveryMode = 'wake' | 'inject'

/** One durable fleet event as appended to the store and fanned out. */
export interface FleetBusEvent {
  /** Stable identity `<type>-<seq>`; unique per store. */
  readonly id: string
  /** Free-form event type (e.g. `build.status`, `task.done`, `fleet/stall`). */
  readonly type: string
  readonly scope: FleetBusScope
  /** The agent id (or `system`) that produced the event. */
  readonly actor: string
  /**
   * The mechanism that produced the event (e.g. `agent`, `task`, `watchdog`,
   * `scheduler`, `heartbeat`). Subscriptions may EXCLUDE origin kinds so a
   * mechanism can never trigger itself.
   */
  readonly originKind: string
  /**
   * Trigger-state fingerprint for wake dedupe: the SHA-256 of the
   * trigger-relevant fields that produced this event (publisher-computed via
   * {@link computeFingerprint}). When absent, the bus falls back to hashing the
   * full payload at delivery time.
   */
  readonly fingerprint?: string
  /** JSON-safe event body. */
  readonly payload: JsonValue
  /** Unix epoch ms (service clock). */
  readonly ts: number
  /** Monotonic store sequence (1-based, continues across restarts). */
  readonly seq: number
}

/** The caller-provided half of an event; id/ts/seq are assigned by the bus. */
export interface FleetBusEventInput {
  /** Free-form event type. */
  type: string
  /** Event scope; defaults to `fleet`. */
  scope?: FleetBusScope
  /** The producing agent id (or `system`). */
  actor: string
  /** JSON-safe event body. */
  payload: JsonValue
  /** Producing mechanism; defaults to `agent`. */
  originKind?: string
  /** Optional trigger-state fingerprint (see {@link FleetBusEvent.fingerprint}). */
  fingerprint?: string
}

/** A subscription filter: omit a field to match any value of it. */
export interface FleetBusFilter {
  /** Match events with exactly this type. */
  type?: string
  /** Match events with exactly this scope. */
  scope?: FleetBusScope
  /** Exclude events produced by these mechanisms (self-trigger guard). */
  excludeOriginKinds?: string[]
}

/** One live subscription: agent + filter + delivery mode. */
export interface FleetBusSubscription {
  readonly id: string
  readonly agentId: string
  readonly filter: FleetBusFilter
  readonly mode: FleetBusDeliveryMode
  /**
   * Wake-dedupe window (ms): identical trigger fingerprints delivered to this
   * subscriber within the window are suppressed (wake-storm guard). Default
   * unset = every matching event wakes.
   */
  readonly dedupeMs?: number
}

/** True when an event satisfies a filter. */
export function matchesFleetBusFilter(filter: FleetBusFilter, event: FleetBusEvent): boolean {
  if (filter.type !== undefined && filter.type !== event.type) return false
  if (filter.scope !== undefined && filter.scope !== event.scope) return false
  if (filter.excludeOriginKinds !== undefined && filter.excludeOriginKinds.includes(event.originKind)) return false
  return true
}

/** The one-line text body delivered to a subscribed agent (followup/inject). */
export function fleetBusEventToMessage(event: FleetBusEvent): string {
  return `[fleet-bus ${event.type} (${event.scope}) by ${event.actor}] ${JSON.stringify(event.payload)}`
}
