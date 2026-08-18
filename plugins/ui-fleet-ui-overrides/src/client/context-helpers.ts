/**
 * Local context-occupancy helpers for the fleet UI overrides. These are the
 * same reader utilities DSH's StatsLine exports, vendored here so the hover
 * ContextMeter (FleetContextMeter) stays decoupled from ui-conversation's
 * internal chat module — the plugin's components only ever talk to the
 * `@deepseek-ai/dsh-token-meter/client` type surface.
 *
 * - `contextOccupancy(pressure)` — projected used tokens vs. the newest
 *   known route capacity, as { usedTokens, contextWindow, percent }.
 * - `formatTokens(n)` — compact token figures (517 / 12.2K / 517K / 1.2M).
 * @module @hydra/dsh-fleet-ui-overrides/client
 */

import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Resolved occupancy: used tokens, the known capacity, and rounded percent. */
export interface ContextOccupancy {
  /** Context used (projected, so compaction shows immediately). */
  usedTokens: number
  /** Newest known route capacity. */
  contextWindow: number
  /** Rounded occupancy percent (clamped at 100). */
  percent: number
}

/**
 * Approximate context occupancy — mirrored from DSH's StatsLine reader: the
 * numerator is `projectedTokens` (provider sample carried over surface
 * movement since), falling back to the bare `pressureTokens` sample.
 * @param pressure - the session's context-pressure projection value.
 * @returns occupancy with its numerator and denominator, or null until both values are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    usedTokens,
    contextWindow: pressure.contextWindow,
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
  }
}

/** Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits). */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}
