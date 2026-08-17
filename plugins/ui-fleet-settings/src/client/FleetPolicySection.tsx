import { useEffect, useState } from 'react'
import { fetchPolicy, type PolicyResponse } from './api.ts'
import css from './styles.module.css'

/** Safe length accessor — handles both { policies: [] } and { rules: [] } shapes. */
function policyCount(data: PolicyResponse): number {
  const p = data as Record<string, unknown>
  if (Array.isArray(p.policies)) return p.policies.length
  if (Array.isArray(p.rules)) return p.rules.length
  return 0
}

export function FleetPolicySection() {
  const [data, setData] = useState<PolicyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetchPolicy()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  if (loading) return <div className={css.loading}>Loading policy...</div>
  if (error) return <div className={css.error}>{error}</div>
  if (!data) return null

  const count = policyCount(data)
  const raw = data as Record<string, unknown>
  const contextPosture = typeof raw.context === 'string' ? raw.context : 'N/A'
  const identities = (typeof raw.identities === 'object' && raw.identities !== null ? raw.identities : {}) as Record<string, string>
  const rules = Array.isArray(raw.rules) ? raw.rules as Array<Record<string, unknown>> : []
  const policies = Array.isArray(raw.policies) ? raw.policies as Array<Record<string, unknown>> : []

  return (
    <div className={css.section}>
      <div className={css.header}>
        <span className={css.count}>{count} policies</span>
      </div>

      <div className={css.subsection}>
        <div className={css.subsectionTitle}>Context Posture</div>
        <div className={css.field}>{contextPosture}</div>
      </div>

      {Object.keys(identities).length > 0 && (
        <div className={css.subsection}>
          <div className={css.subsectionTitle}>Identity Overrides</div>
          <table className={css.table}>
            <thead><tr><th>Identity</th><th>Posture</th></tr></thead>
            <tbody>
              {Object.entries(identities).map(([id, posture]) => (
                <tr key={id}><td>{id}</td><td>{String(posture)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rules.length > 0 && (
        <div className={css.subsection}>
          <div className={css.subsectionTitle}>Rules ({rules.length})</div>
          <table className={css.table}>
            <thead><tr><th>ID</th><th>Mode</th><th>Kind</th><th>Value</th><th>Reason</th></tr></thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={i}>
                  <td>{String(r.id ?? '')}</td>
                  <td>{String(r.mode ?? '')}</td>
                  <td>{String(r.kind ?? '')}</td>
                  <td>{String(r.value ?? '')}</td>
                  <td>{String(r.reason ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {policies.length > 0 && (
        <div className={css.subsection}>
          <div className={css.subsectionTitle}>Legacy Policies</div>
          <table className={css.table}>
            <thead><tr><th>Scope</th><th>Posture</th></tr></thead>
            <tbody>
              {policies.map((p, i) => (
                <tr key={i}>
                  <td>{String((p.scope as Record<string, unknown>)?.agentId ?? (p.scope as Record<string, unknown>)?.kind ?? '')}</td>
                  <td>{String(p.posture ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {count === 0 && rules.length === 0 && (
        <div className={css.empty}>No policy overrides configured</div>
      )}
    </div>
  )
}
