import { useEffect, useState } from 'react'
import {
  fetchSessions, resumeSession, archiveSession,
  type SessionsResponse, type SessionRow,
} from './api.ts'
import css from './styles.module.css'

function statusBadge(status: SessionRow['status']) {
  const cls = status === 'running' ? css.badgeRunning : status === 'done' ? css.badgeDone : css.badgeIdle
  return <span className={`${css.badge} ${cls}`}>{status}</span>
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function FleetSessionsSection() {
  const [data, setData] = useState<SessionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetchSessions()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  if (loading) return <div className={css.loading}>Loading sessions...</div>
  if (error) return <div className={css.error}>{error}</div>
  if (!data) return null

  const visible = data.sessions.filter(s => !s.archived)
  const archived = data.sessions.filter(s => s.archived)

  return (
    <div className={css.section}>
      <div className={css.header}>
        <span className={css.count}>{data.count} sessions ({data.running} running)</span>
      </div>
      {visible.length === 0 ? (
        <div className={css.empty}>No active sessions</div>
      ) : (
        <table className={css.table}>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Agent</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(s => (
              <tr key={s.id}>
                <td>{s.title || s.id.slice(0, 8)}</td>
                <td>{statusBadge(s.status)}</td>
                <td>{s.agentPreset || '-'}</td>
                <td>{timeAgo(s.updatedAt)}</td>
                <td>
                  <div className={css.actions}>
                    {s.status !== 'running' && (
                      <button type="button" className={css.btn} onClick={() => { void resumeSession(s.id).then(load) }}>
                        Resume
                      </button>
                    )}
                    <button type="button" className={`${css.btn} ${css.btnDanger}`} onClick={() => { void archiveSession(s.id).then(load) }}>
                      Archive
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {archived.length > 0 && (
        <div className={css.subsection}>
          <div className={css.subsectionTitle}>Archived ({archived.length})</div>
          <table className={css.table}>
            <thead>
              <tr><th>Title</th><th>Agent</th><th>Archived</th></tr>
            </thead>
            <tbody>
              {archived.map(s => (
                <tr key={s.id}>
                  <td>{s.title || s.id.slice(0, 8)}</td>
                  <td>{s.agentPreset || '-'}</td>
                  <td>{timeAgo(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
