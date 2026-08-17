import { useState } from 'react'
import { FleetSessionsSection } from './FleetSessionsSection.tsx'
import { FleetAgentsSection } from './FleetAgentsSection.tsx'
import { FleetTeamsSection } from './FleetTeamsSection.tsx'
import { FleetBudgetsSection } from './FleetBudgetsSection.tsx'
import { FleetPolicySection } from './FleetPolicySection.tsx'
import css from './styles.module.css'

const TABS = [
  { id: 'sessions', label: 'Sessions', Component: FleetSessionsSection },
  { id: 'agents', label: 'Agents', Component: FleetAgentsSection },
  { id: 'teams', label: 'Teams', Component: FleetTeamsSection },
  { id: 'budgets', label: 'Budgets', Component: FleetBudgetsSection },
  { id: 'policy', label: 'Policy', Component: FleetPolicySection },
] as const

export function OrchestrationSection() {
  const [activeTab, setActiveTab] = useState<string>(TABS[0].id)
  const active = TABS.find(t => t.id === activeTab) ?? TABS[0]

  return (
    <div className={css.section}>
      <div className={css.tabBar}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`${css.tab} ${tab.id === activeTab ? css.tabActive : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <active.Component />
    </div>
  )
}
