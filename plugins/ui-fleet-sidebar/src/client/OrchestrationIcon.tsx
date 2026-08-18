/**
 * Orchestration sidebar foot action: the fleet-settings trigger. Renders
 * IconBranchOutline16 in the 56px rail (tooltip on hover), a labeled row in
 * the wide sidebar, and a highlight dot while its panel is open.
 * @module @hydra/dsh-fleet-sidebar/OrchestrationIcon
 */

import { IconBranchOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useFleetSidebarPanel, togglePanel } from './panel-store.ts'
import { OrchestrationPanel } from './OrchestrationPanel.tsx'
import css from './styles.module.css'

export function OrchestrationIcon({ wide }: SidebarFooterActionOwnerProps) {
  const [open] = useFleetSidebarPanel()
  const active = open === 'orchestration'
  return (
    <div className={wide ? css.action : `${css.action} ${css.actionRail}`}>
      <Tooltip label="Orchestration" side="right" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={`${css.actionButton} ${active ? css.actionActive : ''}`}
          aria-label="Orchestration (fleet settings)"
          aria-expanded={active}
          data-active={active || undefined}
          onClick={() => togglePanel('orchestration')}
        >
          <IconBranchOutline16 size={wide ? 16 : 18} />
          {wide && <span className={css.actionLabel}>Orchestration</span>}
          {active && <span className={css.activeDot} aria-hidden />}
        </button>
      </Tooltip>
      {open === 'orchestration' && <OrchestrationPanel />}
    </div>
  )
}
