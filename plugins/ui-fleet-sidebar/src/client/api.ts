/**
 * Fetch helpers for the ui-fleet-sidebar API surface mounted at `/api/fleet`
 * by the plugin's server half (src/server/routes.ts).
 * @module @hydra/dsh-fleet-sidebar/api
 */

const API_BASE = '/api/fleet'

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`fleet-sidebar ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

// ---- schedules (heartbeats) ----

/** How often a heartbeat fires (`every` ms interval or 5-field cron). */
export interface ScheduleCadence {
  type: 'every' | 'cron'
  everyMs?: number
  expression?: string
  timezone?: string
}

/** Lifecycle status of a schedule. */
export type ScheduleStatus = 'active' | 'paused' | 'completed'

/** One execution record in a schedule's run history (last 20 kept). */
export interface ScheduleRunRecord {
  id: string
  scheduledFor: number
  startedAt: number
  status: 'running' | 'succeeded' | 'failed'
  agentId: string
  error: string | null
}

/** One fleet schedule (heartbeat). Epoch-ms timestamps. */
export interface ScheduleRecord {
  id: string
  name: string | null
  prompt: string
  cadence: ScheduleCadence
  target: { type: 'agent'; agentId: string }
  status: ScheduleStatus
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  lastRunAt: number | null
  pausedAt: number | null
  expiresAt: number | null
  maxRuns: number | null
  runCount: number
  runs: ScheduleRunRecord[]
}

export interface HeartbeatsResponse {
  ok: true
  count: number
  schedules: ScheduleRecord[]
}

export interface HeartbeatResponse {
  ok: true
  schedule: ScheduleRecord
}

export interface HeartbeatDeleteResponse {
  ok: true
  id: string
}

export function fetchHeartbeats(): Promise<HeartbeatsResponse> {
  return requestJson<HeartbeatsResponse>('/heartbeats')
}

export function fetchHeartbeat(id: string): Promise<HeartbeatResponse> {
  return requestJson<HeartbeatResponse>(`/heartbeats/${encodeURIComponent(id)}`)
}

/** Create input; timestamps/ids are assigned server-side. */
export interface HeartbeatCreateInput {
  name?: string
  prompt: string
  cadence: ScheduleCadence
  target: { type: 'agent'; agentId: string }
  maxRuns?: number
  expiresInMs?: number
  /** Explicit absolute expiry (epoch ms); mutually exclusive with expiresInMs. */
  expiresAt?: number
}

export function createHeartbeat(input: HeartbeatCreateInput): Promise<HeartbeatResponse> {
  return requestJson<HeartbeatResponse>('/heartbeats', { method: 'POST', body: JSON.stringify(input) })
}

/** Update patch; `null` clears the label / limits. */
export interface HeartbeatUpdatePatch {
  name?: string | null
  prompt?: string
  cadence?: ScheduleCadence
  maxRuns?: number | null
  expiresAt?: number | null
}

export function updateHeartbeat(id: string, patch: HeartbeatUpdatePatch): Promise<HeartbeatResponse> {
  return requestJson<HeartbeatResponse>(`/heartbeats/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) })
}

export function deleteHeartbeat(id: string): Promise<HeartbeatDeleteResponse> {
  return requestJson<HeartbeatDeleteResponse>(`/heartbeats/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function pauseHeartbeat(id: string): Promise<HeartbeatResponse> {
  return requestJson<HeartbeatResponse>(`/heartbeats/${encodeURIComponent(id)}/pause`, { method: 'POST', body: '{}' })
}

export function resumeHeartbeat(id: string): Promise<HeartbeatResponse> {
  return requestJson<HeartbeatResponse>(`/heartbeats/${encodeURIComponent(id)}/resume`, { method: 'POST', body: '{}' })
}

export function runHeartbeatOnce(id: string): Promise<HeartbeatResponse> {
  return requestJson<HeartbeatResponse>(`/heartbeats/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}' })
}

// ---- fleet data (Orchestration panel) ----

export interface AgentProfile {
  agentId: string
  name: string
  role: string
  status: string
  claimRole?: string
  cwd?: string
  tier?: string
  provider?: string
  model?: string
  promptFile?: string
  avatar?: string
  enabled: boolean
  createdAt: number
  publicKey: string
}

export interface AgentsResponse {
  ok: boolean
  count: number
  profiles: AgentProfile[]
}

export interface TeamRoom {
  id: string
  name: string
  members: string[]
  grants: Record<string, unknown>
}

export interface TeamEntry {
  team: { id: string; name: string }
  rooms: TeamRoom[]
}

export interface TeamsResponse {
  ok: boolean
  teams: TeamEntry[]
}

export type SessionStatus = 'running' | 'done' | 'idle'

export interface SessionRow {
  id: string
  title?: string
  agentPreset?: string
  origin?: 'subagent'
  cwd?: string
  status: SessionStatus
  hasActivity: boolean
  createdAt: number
  updatedAt: number
  archived: boolean
}

export interface SessionsResponse {
  ok: true
  count: number
  running: number
  sessions: SessionRow[]
}

export interface BudgetEntry {
  scope: { kind: string; agentId?: string; taskKind?: string }
  cap: number
  unit: 'tokens' | 'cost'
  spentTokens: number
  spentCost: number
  softThreshold: number
  criticalThreshold: number
}

export interface BudgetsResponse {
  ok: boolean
  levels: Record<string, 'ok' | 'warning' | 'critical'>
  worst: 'ok' | 'warning' | 'critical'
  budgets: BudgetEntry[]
  totals: { tokens: number; cost: number }
}

export interface PolicyResponse {
  ok: boolean
  context: 'Strict' | 'Auto' | 'Dangerous'
  identities: Record<string, 'Strict' | 'Auto' | 'Dangerous'>
  rules: unknown[]
}

/** Minimal budget-set payload (cap/unit/owner per scope). */
export function setFleetBudget(data: {
  scope: { kind: string; agentId?: string; taskKind?: string }
  cap: number
  unit?: string
  owner?: string
}): Promise<{ ok: boolean; budget: BudgetEntry }> {
  return requestJson('/budgets', { method: 'POST', body: JSON.stringify(data) })
}

export function setFleetPolicy(data: {
  posture: string
  scope: { kind: 'context' } | { kind: 'identity'; agentId: string }
}): Promise<{ ok: boolean; posture: string; scope: unknown }> {
  return requestJson('/policy', { method: 'POST', body: JSON.stringify(data) })
}

export function fetchAgents(): Promise<AgentsResponse> {
  return requestJson<AgentsResponse>('/agents')
}

export function fetchTeams(): Promise<TeamsResponse> {
  return requestJson<TeamsResponse>('/teams')
}

export function fetchSessions(): Promise<SessionsResponse> {
  return requestJson<SessionsResponse>('/sessions')
}

export function fetchBudgets(): Promise<BudgetsResponse> {
  return requestJson<BudgetsResponse>('/budgets')
}

export function fetchPolicy(): Promise<PolicyResponse> {
  return requestJson<PolicyResponse>('/policy')
}
