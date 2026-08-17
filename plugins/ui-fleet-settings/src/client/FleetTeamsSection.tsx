import { useEffect, useState } from 'react'
import { fetchTeams, type TeamsResponse, type TeamEntry } from './api.ts'
import css from './styles.module.css'

function TeamCard({ team }: { team: TeamEntry }) {
  return (
    <div style={{ border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: 8, padding: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{team.name || team.id}</div>
      {team.rooms.length === 0 ? (
        <div className={css.empty}>No rooms</div>
      ) : (
        team.rooms.map(room => (
          <div key={room.id} className={css.subsection}>
            <div className={css.subsectionTitle}>{room.name || room.id}</div>
            {room.members.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-text-secondary)', marginBottom: 4 }}>
                {room.members.map(m => m.agentId).join(', ')}
              </div>
            )}
            {Object.keys(room.grants).length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-text-tertiary)' }}>
                Grants: {Object.entries(room.grants).map(([k, v]) => `${k}=${v}`).join(', ')}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

export function FleetTeamsSection() {
  const [data, setData] = useState<TeamsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchTeams()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className={css.loading}>Loading teams...</div>
  if (error) return <div className={css.error}>{error}</div>
  if (!data) return null

  return (
    <div className={css.section}>
      <div className={css.header}>
        <span className={css.count}>{data.teams.length} teams</span>
      </div>
      {data.teams.length === 0 ? (
        <div className={css.empty}>No teams configured</div>
      ) : (
        data.teams.map(t => <TeamCard key={t.id} team={t} />)
      )}
    </div>
  )
}
