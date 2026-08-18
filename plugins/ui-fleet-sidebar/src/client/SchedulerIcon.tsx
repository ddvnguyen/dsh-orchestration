/**
 * Scheduler sidebar foot action: the heartbeat-management trigger. Renders
 * IconRefreshOutline16 in the 56px rail (tooltip on hover), a labeled row in
 * the wide sidebar, and a highlight dot while its panel is open.
 * @module @hydra/dsh-fleet-sidebar/SchedulerIcon
 */

import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useFleetSidebarPanel, togglePanel } from './panel-store.ts'
import { SchedulerPanel } from './SchedulerPanel.tsx'
import css from './styles.module.css'

export function SchedulerIcon({ wide }: SidebarFooterActionOwnerProps) {
  const [open] = useFleetSidebarPanel()
  const active = open === 'scheduler'
  return (
    <div className={wide ? css.action : `${css.action} ${css.actionRail}`}>
      <Tooltip label="Scheduler" side="right" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={`${css.actionButton} ${active ? css.actionActive : ''}`}
          aria-label="Scheduler (heartbeat schedules)"
          aria-expanded={active}
          data-active={active || undefined}
          onClick={() => togglePanel('scheduler')}
        >
          <IconRefreshOutline16 size={wide ? 16 : 18} />
          {wide && <span className={css.actionLabel}>Scheduler</span>}
          {active && <span className={css.activeDot} aria-hidden />}
        </button>
      </Tooltip>
      {open === 'scheduler' && <SchedulerPanel />}
    </div>
  )
}
