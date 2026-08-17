import { useCallback, useEffect, useState } from 'react'
import {
  fetchAgents, updateAgent, toggleAgent,
  type AgentsResponse,
} from './api.ts'
import css from './styles.module.css'

export function FleetAgentsSection() {
  const [data, setData] = useState<AgentsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editModel, setEditModel] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetchAgents()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  if (loading) return <div className={css.loading}>Loading agents...</div>
  if (error) return <div className={css.error}>{error}</div>
  if (!data) return null

  const handleSave = (id: string) => {
    void updateAgent(id, { model: editModel }).then(() => {
      setEditingId(null)
      load()
    })
  }

  const handleToggle = (id: string, enabled: boolean) => {
    void toggleAgent(id, enabled).then(load)
  }

  const handleCopyId = useCallback((id: string) => {
    void navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1000)
    })
  }, [])

  return (
    <div className={css.section}>
      <div className={css.header}>
        <span className={css.count}>{data.count} agents</span>
      </div>
      {data.profiles.length === 0 ? (
        <div className={css.empty}>No agent profiles configured</div>
      ) : (
        <table className={css.table}>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Model</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.profiles.map(a => (
              <tr key={a.id}>
                <td>
                  <div className={css.agentId}>
                    <span title={a.id}>{a.displayName || a.id}</span>
                    <button
                      type="button"
                      className={`${css.copyBtn}${copiedId === a.id ? ` ${css.copyBtnCopied}` : ''}`}
                      onClick={() => handleCopyId(a.id)}
                      title={copiedId === a.id ? 'Copied!' : 'Copy agent ID'}
                    >
                      {copiedId === a.id ? '✓' : '⎘'}
                    </button>
                  </div>
                </td>
                <td>
                  {editingId === a.id ? (
                    <div className={css.actions}>
                      <input value={editModel} onChange={e => setEditModel(e.target.value)} />
                      <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={() => handleSave(a.id)}>Save</button>
                      <button type="button" className={css.btn} onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <span>{a.model}</span>
                  )}
                </td>
                <td>
                  <span className={`${css.badge} ${a.enabled ? css.badgeRunning : css.badgeIdle}`}>
                    {a.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
                <td>
                  <div className={css.actions}>
                    {editingId !== a.id && (
                      <button type="button" className={css.btn} onClick={() => { setEditingId(a.id); setEditModel(a.model) }}>
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${css.btn} ${a.enabled ? css.btnDanger : css.btnPrimary}`}
                      onClick={() => handleToggle(a.id, !a.enabled)}
                    >
                      {a.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
