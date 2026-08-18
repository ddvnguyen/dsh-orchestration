/**
 * FleetStatsLine — replacement for DSH's StatsLine, registered into the
 * `conversation.composer.dock` slot under the SAME cell id (`'stats'`) so it
 * shadows the shipped entry. It trades the input/output token figures for
 * context occupancy while keeping the count/duration strip and the cache-hit
 * share:
 *
 *   `13 turns · 68 steps | LLM 13m50s | Context: 45% (135K/300K) | Cache: 96%`
 *
 * Data rides the same durable projections as DSH's StatsLine (whole-log
 * values survive paging and compaction):
 * - `sessionStats`      → turns / steps / LLM wall time
 * - `contextPressure`   → context size (used tokens + window capacity)
 * - `tokenUsage`        → cache-hit share of billed input
 * @module @hydra/dsh-fleet-ui-overrides/client
 */

import { Fragment, memo, useMemo } from 'react'
import type {
  ConversationSnapshot,
  UseProjection,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the 'sessionStats' key into SessionProjectionMap so the
// useProjection('sessionStats') call below is typed (same pattern as DSH).
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {
  ContextPressureProjection,
  TokenUsageProjection,
} from '@deepseek-ai/dsh-token-meter/client'
import css from './styles.module.css'

/** Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits). */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Compact duration: 45.2s under a minute, 13m50s from there on. */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Sum the three disjoint prompt-side billing buckets. */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Cache-hit share of prompt-side input over the whole durable log. */
export function cacheHitPercent(usage: TokenUsageProjection): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0
    ? null
    : Math.round(usage.cacheReadTokens / denominator * 100)
}

export interface ContextOccupancy {
  /** Context used (projected, so compaction shows immediately). */
  usedTokens: number
  /** Newest known route capacity. */
  contextWindow: number
  /** Rounded occupancy percent (clamped at 100). */
  percent: number
}

/**
 * Approximate context occupancy — mirrored from DSH's StatsLine reader:
 * the numerator is `projectedTokens` (provider sample carried over surface
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

/** Window-scoped fold fallback: counts/wall time for what is on screen. */
interface WindowStats {
  turns: number
  steps: number
  llmMs: number
}

/**
 * Fold assistant nodes into window-scoped display totals — the FALLBACK for
 * assemblies without the `sessionStats` projection (field names mirror the
 * projection's so the two swap wholesale, per DSH's StatsLine pattern).
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed LLM wall time.
 */
function deriveWindowStats(nodes: ConversationSnapshot['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
  }
  return { turns: turns.size, steps, llmMs }
}

/** Props: the framework standard kit seats this row reads (nothing more). */
export interface FleetStatsLineProps {
  /** Conversation-snapshot selector — used only by the window fold fallback. */
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  /** Fifth framework hook seat: key-addressed projection reader. */
  useProjection: UseProjection
}

/**
 * The fleet status line. Pipe-separated groups (figma stats strip); a group
 * with no data drops out whole, and the row renders nothing at all before
 * any data exists.
 */
export const FleetStatsLine = memo(function FleetStatsLine(
  { useSession, useProjection }: FleetStatsLineProps,
) {
  // Settled-node identity prevents stream-delta updates from rerendering.
  const settledNodes = useSession(s => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  const pressure = useProjection('contextPressure')
  // Durable whole-log figures; an assembly without the unit falls back to
  // the window-scoped fold wholesale (same field names).
  const projected = useProjection('sessionStats')
  const stats = useMemo(
    () => projected ?? deriveWindowStats(settledNodes),
    [projected, settledNodes],
  )

  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(
      `${stats.turns} ${stats.turns === 1 ? 'turn' : 'turns'} · `
      + `${stats.steps} ${stats.steps === 1 ? 'step' : 'steps'}`,
    )
    if (stats.llmMs > 0) groups.push(`LLM ${formatDuration(stats.llmMs)}`)
  }
  const occupancy = contextOccupancy(pressure)
  if (occupancy !== null) {
    groups.push(
      `Context: ${occupancy.percent}% (${formatTokens(occupancy.usedTokens)}/${formatTokens(occupancy.contextWindow)})`,
    )
  }
  if (usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(`Cache: ${cacheHit}%`)
  }
  if (groups.length === 0) return null

  return (
    <div className={css.statsRow} data-fleet-stats-line>
      {groups.map((group, i) => (
        <Fragment key={group}>
          {i > 0 && <><span className={css.statsSep} aria-hidden>|</span>{' '}</>}
          <span>{group}</span>
        </Fragment>
      ))}
    </div>
  )
})
