/**
 * FleetContextMeter — the composer's context-occupancy ring for the fleet UI
 * overrides, registered into the `conversation.input.right` slot under the
 * shipped ring's cell id (`context-meter`), replacing both the DSH
 * ContextMeter and the plugin's earlier empty occupant that removed the ring.
 *
 * Same ring and breakdown panel as DSH's ContextMeter — projected occupancy
 * via `contextPressure`, heuristic system/tools/messages composition via
 * `contextBreakdown` — with one behavioral difference: the panel opens on
 * hover instead of click. Moving the pointer onto the ring shows the full
 * breakdown; moving it off hides the panel again.
 *
 * Note that on hover the panel is a preview bound to the ring itself: it
 * stays visible while the pointer rests on the ring and closes the moment
 * the pointer leaves it (the panel floats 8px above the ring, positioned by
 * `.panel`'s `bottom: calc(100% + 8px)`, so it is read rather than
 * interacted with). Should an interactive panel ever be wanted, move the
 * onMouseEnter/onMouseLeave handlers up to the root span and bridge the gap
 * (e.g. a `.panel::before` runway), so the pointer can travel into the panel
 * without tripping the leave handler.
 * @module @hydra/dsh-fleet-ui-overrides/client
 */

import { useEffect, useState } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the `contextPressure` / `contextBreakdown` projection
// keys into SessionProjectionMap so the useProjection calls below are typed
// (same pattern as FleetStatsLine and DSH's ContextMeter).
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { contextOccupancy, formatTokens } from './context-helpers.ts'
import css from './styles.module.css'

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word
 * order (`45% of context used` / `上下文已用 45%`).
 */
const READING_SLOT = '\u0000'

/** Panel legend rows, in bar-segment order; each color class carries the shared swatch/segment tint. */
const ROWS = [
  { key: 'systemTokens', label: 'context.system', color: css.colorSystem },
  { key: 'toolsTokens', label: 'context.tools', color: css.colorTools },
  { key: 'messageTokens', label: 'context.messages', color: css.colorMessages },
] as const

/** Props: the framework kit seats the input-right occupant reads. */
export interface FleetContextMeterProps {
  /** Fifth framework hook seat: key-addressed projection reader. */
  useProjection: UseProjection
  /** Locale seat — the entry registers with `locale: 'conversation'`. */
  t: TranslateNS<'conversation'>
}

/**
 * Context-occupancy ring: hovering the ring opens the full breakdown panel
 * (system / tools / messages), leaving it closes the panel. Renders nothing
 * until a provider reports both pressure and a route capacity.
 */
export function FleetContextMeter({ useProjection, t }: FleetContextMeterProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const [open, setOpen] = useState(false)
  const context = contextOccupancy(pressure)
  const available = context !== null

  // A model switch can temporarily remove capacity while this component stays
  // mounted. Close the now-unavailable panel instead of preserving stale UI.
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  if (context === null) return null
  const percent = context.percent
  const reading = `${percent}%`
  const [headBefore = '', headAfter = ''] = t('context.aria', { percent: READING_SLOT })
    .split(READING_SLOT)
    .map(part => part.trim())

  // The bar's overall length stays the provider-exact percent; the heuristic
  // breakdown only proportions its colored parts. A zero-width part is dropped
  // instead of rendered: `.segment`'s min-width keeps a hairline part visible,
  // which at 0% occupancy would draw a filled bar over an empty context.
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdownTotal === 0
    ? [{ key: 'total', color: undefined, width: percent }]
    : ROWS.map(row => ({ key: row.key, color: row.color, width: percent * breakdown[row.key] / breakdownTotal }))
  const segments = parts.filter(part => part.width > 0)

  return (
    <span className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-label={t('context.aria', { percent: reading })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseEnter={() => { setOpen(true) }}
        onMouseLeave={() => { setOpen(false) }}
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
          <circle className={css.track} cx="7" cy="7" r={RADIUS} />
          <circle
            className={css.fill}
            cx="7"
            cy="7"
            r={RADIUS}
            strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
      </button>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('context.used')}>
          <div className={css.header}>
            {/* Empty sides collapse through `.headline:empty` so the locale that
                needs no leading (or trailing) text spends no header gap. */}
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            <span className={css.figures}>
              {`~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`}
            </span>
          </div>
          <div className={css.bar}>
            {segments.map(segment => (
              <div
                key={segment.key}
                className={segment.color === undefined ? css.segment : `${css.segment} ${segment.color}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {breakdown !== undefined && (
            <dl className={css.rows}>
              {ROWS.map(row => (
                <div key={row.key} className={css.row}>
                  <dt>
                    <span className={`${css.swatch} ${row.color}`} aria-hidden />
                    {t(row.label)}
                  </dt>
                  <dd>{`~${formatTokens(breakdown[row.key])}`}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </span>
  )
}
