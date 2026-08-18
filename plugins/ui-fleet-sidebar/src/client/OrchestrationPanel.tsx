/**
 * Orchestration slide-out panel: fleet settings in five tabs — Sessions,
 * Agents, Teams, Budgets, Policy. Simplified read views over the `/api/fleet`
 * family (the ui-fleet-settings dialog covers the full edit surfaces); the
 * Budgets/Policy tabs also expose their primary write action.
 * @module @hydra/dsh-fleet-sidebar/OrchestrationPanel
 */

import { useEffect, useState, type ReactNode } from 'react'
import {
  fetchAgents, fetchBudgets, fetchPolicy, fetchSessions, fetchTeams,
  setFleetBudget, setFleetPolicy,
  type AgentsResponse, type BudgetsResponse, type PolicyResponse,
  type SessionsResponse, type TeamsResponse,
} from './api.ts'
import { closePanel } from './panel-store.ts'
import css from './styles.module.css'

/** One data-fetching tab section. */
function Section({ children }: { children: ReactNode }) {
  return <div className={css.section}>{children}</div>
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ---- Sessions ----

function SessionsTab() {
  const [data, setData] = useState<SessionsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetchSessions().then(setData).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  return (
    <Section>
      <div className={css.sectionHeader}>
        <span className={css.count}>{data === null ? '…' : `${data.count} sessions (${data.running} running)`}</span>
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      {data === null || data.sessions.length === 0 ? (
        <div className={css.empty}>No sessions</div>
      ) : (
        <table className={css.table}>
          <thead>
            <tr><th>Title</th><th>Status</th><th>Agent</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {data.sessions.map(session => (
              <tr key={session.id}>
                <td>{session.title ?? session.id.slice(0, 8)}</td>
                <td>
                  <span className={`${css.badge} ${
                    session.status === 'running' ? css.badgeRunning : session.status === 'done' ? css.badgeDone : css.badgeIdle
                  }`}>{session.status}</span>
                </td>
                <td>{session.agentPreset ?? '-'}</td>
                <td>{timeAgo(session.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

// ---- Agents ----

function AgentsTab() {
  const [data, setData] = useState<AgentsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetchAgents().then(setData).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  return (
    <Section>
      {error !== null && <div className={css.error}>{error}</div>}
      {data === null || data.profiles.length === 0 ? (
        <div className={css.empty}>No agent profiles</div>
      ) : (
        <table className={css.table}>
          <thead>
            <tr><th>Agent</th><th>Role</th><th>Provider</th><th>Status</th></tr>
          </thead>
          <tbody>
            {data.profiles.map(profile => (
              <tr key={profile.agentId}>
                <td>
                  <div className={css.cellTitle}>{profile.name}</div>
                  <div className={css.cellSub}>{profile.agentId}</div>
                </td>
                <td>{profile.role}</td>
                <td>{profile.model ?? '-'}</td>
                <td>
                  <span className={`${css.badge} ${profile.enabled ? css.badgeRunning : css.badgeIdle}`}>
                    {profile.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

// ---- Teams ----

function TeamsTab() {
  const [data, setData] = useState<TeamsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetchTeams().then(setData).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  return (
    <Section>
      {error !== null && <div className={css.error}>{error}</div>}
      {data === null || data.teams.length === 0 ? (
        <div className={css.empty}>No teams</div>
      ) : (
        data.teams.map(team => (
          <div key={team.team.id} className={css.card}>
            <div className={css.cardTitle}>{team.team.name} <span className={css.count}>· {team.rooms.length} rooms</span></div>
            {team.rooms.length === 0 ? (
              <div className={css.empty}>No rooms</div>
            ) : (
              <table className={css.table}>
                <tbody>
                  {team.rooms.map(room => (
                    <tr key={room.id}>
                      <td>{room.name}</td>
                      <td>{room.members.length > 0 ? room.members.join(', ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      )}
    </Section>
  )
}

// ---- Budgets ----

function BudgetsTab() {
  const [data, setData] = useState<BudgetsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ cap: '10000', unit: 'tokens', owner: '' })
  const load = () => {
    setError(null)
    fetchBudgets().then(setData).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])
  const submit = () => {
    const cap = Number.parseFloat(form.cap)
    if (!Number.isFinite(cap) || cap <= 0) { setError('Cap must be a positive number'); return }
    setError(null)
    setFleetBudget({
      scope: { kind: 'global' },
      cap,
      unit: form.unit,
      ...(form.owner.trim().length > 0 ? { owner: form.owner.trim() } : {}),
    })
      .then(load)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  return (
    <Section>
      {error !== null && <div className={css.error}>{error}</div>}
      <div className={css.formRow}>
        <input className={css.input} type="number" min={1} placeholder="cap" value={form.cap}
          onChange={e => setForm(current => ({ ...current, cap: e.target.value }))} />
        <select className={css.input} value={form.unit}
          onChange={e => setForm(current => ({ ...current, unit: e.target.value }))}>
          <option value="tokens">tokens</option>
          <option value="cost">cost</option>
        </select>
        <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={submit}>Set global budget</button>
      </div>
      {data === null || data.budgets.length === 0 ? (
        <div className={css.empty}>No budgets</div>
      ) : (
        <table className={css.table}>
          <thead>
            <tr><th>Scope</th><th>Cap</th><th>Level</th><th>Spend</th></tr>
          </thead>
          <tbody>
            {data.budgets.map((budget, index) => {
              const key = Object.keys(data.levels)[index] ?? budget.scope.kind
              const level = data.levels[key] ?? 'ok'
              return (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{budget.cap} {budget.unit}</td>
                  <td>
                    <span className={`${css.badge} ${
                      level === 'critical' ? css.badgeDanger : level === 'warning' ? css.badgeWarning : css.badgeRunning
                    }`}>{level}</span>
                  </td>
                  <td>{budget.unit === 'cost' ? budget.spentCost : budget.spentTokens} {budget.unit}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Section>
  )
}

// ---- Policy ----

function PolicyTab() {
  const [data, setData] = useState<PolicyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setError(null)
    fetchPolicy().then(setData).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])
  const setPosture = (posture: string, scope: { kind: 'context' } | { kind: 'identity'; agentId: string }) => {
    setError(null)
    setFleetPolicy({ posture, scope }).then(load).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  return (
    <Section>
      {error !== null && <div className={css.error}>{error}</div>}
      {data === null ? (
        <div className={css.loading}>Loading policy...</div>
      ) : (
        <>
          <div className={css.card}>
            <div className={css.cardTitle}>Context posture</div>
            <div className={css.formRow}>
              <span className={`${css.badge} ${
                data.context === 'Strict' ? css.badgeWarning : data.context === 'Auto' ? css.badgeRunning : css.badgeIdle
              }`}>{data.context}</span>
              {(['Strict', 'Auto', 'Dangerous'] as const).filter(p => p !== data.context).map(p => (
                <button key={p} type="button" className={css.btn} onClick={() => setPosture(p, { kind: 'context' })}>
                  Set {p}
                </button>
              ))}
            </div>
          </div>
          <div className={css.card}>
            <div className={css.cardTitle}>Identity overrides</div>
            {Object.keys(data.identities).length === 0 ? (
              <div className={css.empty}>None</div>
            ) : (
              <table className={css.table}>
                <thead><tr><th>Agent</th><th>Posture</th></tr></thead>
                <tbody>
                  {Object.entries(data.identities).map(([agentId, posture]) => (
                    <tr key={agentId}>
                      <td>{agentId}</td>
                      <td><span className={css.badge}>{posture}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </Section>
  )
}

const TABS = [
  { id: 'sessions', label: 'Sessions', Component: SessionsTab },
  { id: 'agents', label: 'Agents', Component: AgentsTab },
  { id: 'teams', label: 'Teams', Component: TeamsTab },
  { id: 'budgets', label: 'Budgets', Component: BudgetsTab },
  { id: 'policy', label: 'Policy', Component: PolicyTab },
] as const

export function OrchestrationPanel() {
  const [activeTab, setActiveTab] = useState<string>(TABS[0].id)
  const active = TABS.find(tab => tab.id === activeTab) ?? TABS[0]

  return (
    <div className={css.overlay}>
      <div className={css.dismiss} onClick={closePanel} aria-hidden />
      <section className={css.panel} aria-label="Orchestration">
        <header className={css.header}>
          <span className={css.title}>Orchestration</span>
          <button type="button" className={css.close} aria-label="Close Orchestration" onClick={closePanel}>✕</button>
        </header>
        <div className={css.nav}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`${css.navButton} ${tab.id === activeTab ? css.navButtonActive : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className={css.body}>
          <active.Component />
        </div>
      </section>
    </div>
  )
}
