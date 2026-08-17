import { useEffect, useState } from 'react'
import { fetchBudgets, setBudget, type BudgetsResponse } from './api.ts'
import css from './styles.module.css'

export function FleetBudgetsSection() {
  const [data, setData] = useState<BudgetsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cap, setCap] = useState('')
  const [unit, setUnit] = useState('tokens')
  const [scopeOwner, setScopeOwner] = useState('')
  const [actor, setActor] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = () => {
    setLoading(true)
    setError(null)
    fetchBudgets()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const handleSetBudget = () => {
    if (!cap || !actor) return
    setSubmitting(true)
    void setBudget({
      scope: { kind: 'context', ...(scopeOwner ? { owner: scopeOwner } : {}) },
      cap: Number(cap),
      unit,
      actor,
    }).then(() => {
      setCap('')
      load()
    }).finally(() => setSubmitting(false))
  }

  if (loading) return <div className={css.loading}>Loading budgets...</div>
  if (error) return <div className={css.error}>{error}</div>
  if (!data) return null

  return (
    <div className={css.section}>
      <div className={css.header}>
        <span className={css.count}>{data.budgets.length} budgets</span>
      </div>
      {data.budgets.length === 0 ? (
        <div className={css.empty}>No budgets configured</div>
      ) : (
        <table className={css.table}>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Cap</th>
              <th>Unit</th>
              <th>Spent</th>
              <th>Utilization</th>
            </tr>
          </thead>
          <tbody>
            {data.budgets.map((b, i) => (
              <tr key={i}>
                <td>{b.scope.owner || b.scope.kind}</td>
                <td>{b.cap}</td>
                <td>{b.unit}</td>
                <td>{b.spent}</td>
                <td>{b.cap > 0 ? `${Math.round((b.spent / b.cap) * 100)}%` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={css.subsection}>
        <div className={css.subsectionTitle}>Set Budget</div>
        <div className={css.form}>
          <label>Cap</label>
          <input type="number" value={cap} onChange={e => setCap(e.target.value)} placeholder="10000" />
          <label>Unit</label>
          <select value={unit} onChange={e => setUnit(e.target.value)}>
            <option value="tokens">tokens</option>
            <option value="cost">cost</option>
          </select>
          <label>Owner</label>
          <input value={scopeOwner} onChange={e => setScopeOwner(e.target.value)} placeholder="optional" />
          <label>Actor</label>
          <input value={actor} onChange={e => setActor(e.target.value)} placeholder="required" />
          <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={handleSetBudget} disabled={submitting || !cap || !actor}>
            Set
          </button>
        </div>
      </div>
    </div>
  )
}
