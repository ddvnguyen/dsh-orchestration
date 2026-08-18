/**
 * ContextSummaryRow — sticky trajectory header row, registered into the
 * `trajectory.context.summary` slot (declared by DSH's ui-trajectory). The
 * TrajectoryView owner reads the durable token-usage and context-pressure
 * projections and passes them through the owner share; this row renders them
 * pinned at the top of the Trajectory view:
 *
 *   `Context: 135K / 300K (45%) │ Input: 2.8M (96% cache) │ Output: 21.8K`
 *
 * Consuming the owner share (not the projections directly) keeps the row a
 * pure presentation of what TrajectoryView already resolved, and keeps it
 * decoupled from the projection-wire types.
 * @module @hydra/dsh-fleet-ui-overrides/client
 */

import { Fragment, memo } from 'react'
import { formatTokens } from './FleetStatsLine.tsx'
import css from './styles.module.css'

/** Whole-log billed usage share (billed input is the total across buckets). */
export interface TrajectoryUsageShare {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
}

/** Approximate context occupancy share. */
export interface TrajectoryPressureShare {
  projectedTokens?: number
  contextWindow?: number
}

/** Props: the trajectory owner's summary share (framework kit not required). */
export interface ContextSummaryRowProps {
  /** Whole-log billed usage supplied by the TrajectoryView. */
  usage?: TrajectoryUsageShare
  /** Approximate context occupancy supplied by the TrajectoryView. */
  pressure?: TrajectoryPressureShare
}

/** Cache-hit share of billed input, rounded to whole percent; null when input is 0/absent. */
function cacheHitPercent(usage: TrajectoryUsageShare): number | null {
  const input = usage.inputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  return input <= 0 ? null : Math.round(cacheRead / input * 100)
}

/**
 * Summary row for the trajectory header. Groups drop out whole when their
 * source is absent; the row hides entirely while neither usage nor pressure
 * has been reported.
 */
export const ContextSummaryRow = memo(function ContextSummaryRow(
  { usage, pressure }: ContextSummaryRowProps,
) {
  const used = pressure?.projectedTokens
  const windowSize = pressure?.contextWindow
  const billedInput = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  if (used === undefined && windowSize === undefined && billedInput <= 0 && output <= 0) return null

  const cells: string[] = []
  if (used !== undefined && windowSize !== undefined) {
    const percent = Math.min(100, Math.round(used / windowSize * 100))
    cells.push(
      `Context: ${formatTokens(used)} / ${formatTokens(windowSize)} (${percent}%)`,
    )
  }
  if (usage !== undefined && (billedInput > 0 || output > 0)) {
    const cacheHit = cacheHitPercent(usage)
    cells.push(
      `Input: ${formatTokens(billedInput)}${cacheHit !== null ? ` (${cacheHit}% cache)` : ''}`,
    )
    cells.push(`Output: ${formatTokens(output)}`)
  }
  if (cells.length === 0) return null

  return (
    <div className={css.contextSummaryRow} data-trajectory-context-summary>
      {cells.map((cell, i) => (
        <Fragment key={cell}>
          {i > 0 && <span className={css.cellSep} aria-hidden>│</span>}
          <span className={css.cell}>{cell}</span>
        </Fragment>
      ))}
    </div>
  )
})
