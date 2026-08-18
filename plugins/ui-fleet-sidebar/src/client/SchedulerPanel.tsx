/**
 * Scheduler slide-out panel: heartbeat (schedule) management — list, create,
 * pause/resume, run-now, edit, delete. Fixed-position overlay sliding in from
 * the right (the DSH settings panel pattern), rendered by SchedulerIcon while
 * the Scheduler action is open.
 * @module @hydra/dsh-fleet-sidebar/SchedulerPanel
 */

import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import {
  createHeartbeat, deleteHeartbeat, fetchAgents, fetchHeartbeats, pauseHeartbeat,
  resumeHeartbeat, runHeartbeatOnce, updateHeartbeat,
  type HeartbeatCreateInput, type ScheduleCadence, type ScheduleRecord,
} from './api.ts'
import { closePanel } from './panel-store.ts'
import css from './styles.module.css'

/** Human-readable cadence from a schedule cadence object. */
function formatCadence(cadence: ScheduleCadence): string {
  if (cadence.type === 'every') {
    const ms = cadence.everyMs ?? 0
    if (ms < 60000) return `Every ${Math.max(1, Math.round(ms / 1000))}s`
    if (ms % 3600000 === 0) return `Every ${ms / 3600000}h`
    if (ms % 60000 === 0) return `Every ${ms / 60000}m`
    return `Every ${Math.round(ms / 60000)}m`
  }
  const tz = cadence.timezone !== undefined && cadence.timezone.length > 0 ? ` · ${cadence.timezone}` : ''
  return `cron ${cadence.expression ?? ''}${tz}`
}

function timeAgoLabel(ts: number, prefix: string): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return `${prefix} just now`
  if (mins < 60) return `${prefix} ${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${prefix} ${hrs}h ago`
  return `${prefix} ${Math.floor(hrs / 24)}d ago`
}

function statusBadgeClass(status: ScheduleRecord['status']): string | undefined {
  if (status === 'active') return css.badgeRunning
  if (status === 'paused') return css.badgeIdle
  return css.badgeDone
}

type CadenceType = 'every' | 'cron'

interface FormState {
  name: string
  prompt: string
  agentId: string
  cadenceType: CadenceType
  everyMinutes: string
  cronExpression: string
  timezone: string
  maxRuns: string
  expiresInMinutes: string
}

const EMPTY_FORM: FormState = {
  name: '',
  prompt: '',
  agentId: 'lead',
  cadenceType: 'every',
  everyMinutes: '30',
  cronExpression: '* * * * *',
  timezone: '',
  maxRuns: '',
  expiresInMinutes: '',
}

/** Build the cadence object the API expects from the form values. */
function formToCadence(form: FormState): ScheduleCadence {
  if (form.cadenceType === 'cron') {
    return form.timezone.trim().length > 0
      ? { type: 'cron', expression: form.cronExpression.trim(), timezone: form.timezone.trim() }
      : { type: 'cron', expression: form.cronExpression.trim() }
  }
  const minutes = Math.max(1, Number.parseInt(form.everyMinutes, 10) || 1)
  return { type: 'every', everyMs: minutes * 60000 }
}

export function SchedulerPanel() {
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null)
  const [agents, setAgents] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetchHeartbeats()
      .then(response => setSchedules(response.schedules))
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  const loadAgents = () => {
    fetchAgents()
      .then(response => setAgents(response.profiles.map(p => p.agentId)))
      .catch(() => setAgents([]))
  }

  useEffect(() => { load() }, [])
  useEffect(() => { loadAgents() }, [])

  const defaultAgentId = useMemo(() => {
    if (agents.includes('lead')) return 'lead'
    return agents.length > 0 ? (agents[0] ?? 'lead') : 'lead'
  }, [agents])

  const run = async (id: string, action: () => Promise<unknown>) => {
    if (pending.has(id)) return
    setPending(current => new Set(current).add(id))
    setError(null)
    try {
      await action()
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(current => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({ ...EMPTY_FORM, agentId: defaultAgentId })
    setFormError(null)
    setFormOpen(true)
  }

  const openEdit = (schedule: ScheduleRecord) => {
    const every = schedule.cadence.type === 'every' ? schedule.cadence.everyMs ?? 0 : 0
    setEditingId(schedule.id)
    setForm({
      name: schedule.name ?? '',
      prompt: schedule.prompt,
      agentId: schedule.target.agentId,
      cadenceType: schedule.cadence.type,
      everyMinutes: every > 0 ? String(Math.max(1, Math.round(every / 60000))) : '30',
      cronExpression: schedule.cadence.type === 'cron' ? schedule.cadence.expression ?? '' : '* * * * *',
      timezone: schedule.cadence.type === 'cron' ? schedule.cadence.timezone ?? '' : '',
      maxRuns: schedule.maxRuns !== null ? String(schedule.maxRuns) : '',
      expiresInMinutes: '',
    })
    setFormError(null)
    setFormOpen(true)
  }

  const submitForm = () => {
    if (form.prompt.trim().length === 0) { setFormError('Prompt is required'); return }
    if (form.cadenceType === 'cron' && form.cronExpression.trim().length === 0) {
      setFormError('Cron expression is required')
      return
    }
    const cadence = formToCadence(form)
    const maxRuns = form.maxRuns.trim().length > 0 ? Math.max(1, Number.parseInt(form.maxRuns, 10) || 1) : undefined
    const expiresInMs = form.expiresInMinutes.trim().length > 0
      ? Math.max(1, Number.parseInt(form.expiresInMinutes, 10) || 1) * 60000
      : undefined

    const base = {
      name: form.name.trim().length > 0 ? form.name.trim() : undefined,
      prompt: form.prompt.trim(),
      cadence,
      target: { type: 'agent' as const, agentId: form.agentId },
      ...(maxRuns !== undefined ? { maxRuns } : {}),
    }

    setFormError(null)
    const action = editingId === null
      ? createHeartbeat({ ...base, ...(expiresInMs !== undefined ? { expiresInMs } : {}) } as HeartbeatCreateInput)
      : updateHeartbeat(editingId, {
          name: base.name ?? null,
          prompt: base.prompt,
          cadence,
          ...(base.maxRuns !== undefined ? { maxRuns: base.maxRuns } : { maxRuns: null }),
          ...(expiresInMs !== undefined ? { expiresAt: Date.now() + expiresInMs } : { expiresAt: null }),
        })
    action
      .then(() => { setFormOpen(false); setEditingId(null); load() })
      .catch(e => setFormError(e instanceof Error ? e.message : String(e)))
  }

  const formField = (key: keyof FormState) => ({
    value: form[key],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(current => ({ ...current, [key]: event.target.value })),
  })

  return (
    <div className={css.overlay}>
      <div className={css.dismiss} onClick={closePanel} aria-hidden />
      <section className={css.panel} aria-label="Scheduler">
        <header className={css.header}>
          <span className={css.title}>Scheduler</span>
          <button type="button" className={css.close} aria-label="Close Scheduler" onClick={closePanel}>✕</button>
        </header>
        <div className={css.body}>
          <div className={css.toolbar}>
            <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={openCreate}>
              + Create Heartbeat
            </button>
            <button type="button" className={css.btn} onClick={load}>Refresh</button>
          </div>

          {formOpen && (
            <div className={css.formCard}>
              <div className={css.formTitle}>{editingId === null ? 'New Heartbeat' : `Edit Heartbeat ${editingId !== null ? `(${editingId.slice(0, 12)})` : ''}`}</div>
              <label className={css.field}>
                <span>Name</span>
                <input type="text" placeholder="e.g. Morning standup sync" {...formField('name')} />
              </label>
              <label className={css.field}>
                <span>Prompt</span>
                <textarea rows={3} placeholder="Prompt delivered to the agent on each run" {...formField('prompt')} />
              </label>
              <div className={css.fieldRow}>
                <label className={css.field}>
                  <span>Target Agent</span>
                  <select {...formField('agentId')}>
                    {agents.length === 0 && <option value="lead">lead</option>}
                    {agents.map(agentId => <option key={agentId} value={agentId}>{agentId}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span>Cadence Type</span>
                  <select {...formField('cadenceType')}>
                    <option value="every">Every</option>
                    <option value="cron">Cron</option>
                  </select>
                </label>
              </div>
              {form.cadenceType === 'every' ? (
                <label className={css.field}>
                  <span>Value (minutes)</span>
                  <input type="number" min={1} placeholder="30" {...formField('everyMinutes')} />
                </label>
              ) : (
                <div className={css.fieldRow}>
                  <label className={css.field}>
                    <span>Cron Expression</span>
                    <input type="text" placeholder="* * * * *" {...formField('cronExpression')} />
                  </label>
                  <label className={css.field}>
                    <span>Timezone (optional)</span>
                    <input type="text" placeholder="UTC" {...formField('timezone')} />
                  </label>
                </div>
              )}
              <div className={css.fieldRow}>
                <label className={css.field}>
                  <span>Max Runs (optional)</span>
                  <input type="number" min={1} placeholder="unlimited" {...formField('maxRuns')} />
                </label>
                <label className={css.field}>
                  <span>Expires In (minutes)</span>
                  <input type="number" min={1} placeholder="never" {...formField('expiresInMinutes')} />
                </label>
              </div>
              {formError !== null && <div className={css.error}>{formError}</div>}
              <div className={css.formActions}>
                <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={submitForm}>
                  {editingId === null ? 'Create' : 'Save'}
                </button>
                <button type="button" className={css.btn} onClick={() => { setFormOpen(false); setEditingId(null) }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error !== null && <div className={css.error}>{error}</div>}
          {loading ? (
            <div className={css.loading}>Loading heartbeats...</div>
          ) : schedules === null ? null : schedules.length === 0 ? (
            <div className={css.empty}>No heartbeats yet — create one above.</div>
          ) : (
            <table className={css.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Cadence</th>
                  <th>Status</th>
                  <th>Last Run</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map(schedule => (
                  <tr key={schedule.id}>
                    <td>
                      <div className={css.cellTitle}>{schedule.name ?? schedule.id.slice(0, 12)}</div>
                      <div className={css.cellSub} title={schedule.prompt}>{schedule.prompt}</div>
                    </td>
                    <td>{formatCadence(schedule.cadence)}</td>
                    <td><span className={`${css.badge} ${statusBadgeClass(schedule.status)}`}>{schedule.status}</span></td>
                    <td>{schedule.lastRunAt !== null ? timeAgoLabel(schedule.lastRunAt, '') : '—'}</td>
                    <td>
                      <div className={css.actions}>
                        {schedule.status === 'active' ? (
                          <button type="button" className={css.btn} disabled={pending.has(schedule.id)}
                            onClick={() => void run(schedule.id, () => pauseHeartbeat(schedule.id))}>Pause</button>
                        ) : (
                          <button type="button" className={css.btn} disabled={pending.has(schedule.id)}
                            onClick={() => void run(schedule.id, () => resumeHeartbeat(schedule.id))}>Resume</button>
                        )}
                        <button type="button" className={css.btn} disabled={pending.has(schedule.id) || schedule.status !== 'active'}
                          onClick={() => void run(schedule.id, () => runHeartbeatOnce(schedule.id))}>Run Now</button>
                        <button type="button" className={css.btn} disabled={pending.has(schedule.id)}
                          onClick={() => openEdit(schedule)}>Edit</button>
                        <button type="button" className={`${css.btn} ${css.btnDanger}`} disabled={pending.has(schedule.id)}
                          onClick={() => void run(schedule.id, () => deleteHeartbeat(schedule.id))}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
