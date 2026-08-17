/** Fetch helpers for the fleet-settings API surface mounted at `/fleet-settings/api`. */

const API_BASE = '/fleet-settings/api'

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`fleet-settings ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

// ---- sessions ----

export interface SessionRow {
  id: string
  title?: string
  agentPreset?: string
  origin?: 'subagent'
  cwd?: string
  status: 'running' | 'done' | 'idle'
  hasActivity: boolean
  createdAt: string
  updatedAt: string
  archived: boolean
}

export interface SessionsResponse {
  ok: true
  count: number
  running: number
  archived: string[]
  sessions: SessionRow[]
}

export function fetchSessions(): Promise<SessionsResponse> {
  return requestJson<SessionsResponse>('/sessions')
}

export function resumeSession(id: string): Promise<{ ok: boolean; executed?: boolean }> {
  return requestJson(`/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST', body: '{}' })
}

export function archiveSession(id: string): Promise<{ ok: boolean }> {
  return requestJson(`/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' })
}

// ---- agents ----

export interface AgentProfile {
  id: string
  model: string
  enabled: boolean
  displayName?: string
}

export interface AgentsResponse {
  ok?: boolean
  count: number
  profiles: AgentProfile[]
}

export function fetchAgents(): Promise<AgentsResponse> {
  return requestJson<AgentsResponse>('/agents')
}

export function updateAgent(id: string, patch: Partial<Pick<AgentProfile, 'model'>>): Promise<{ ok: boolean; profile: AgentProfile }> {
  return requestJson(`/agents/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(patch) })
}

export function toggleAgent(id: string, enable: boolean): Promise<{ ok: boolean; profile: AgentProfile }> {
  return requestJson(`/agents/${encodeURIComponent(id)}/${enable ? 'enable' : 'disable'}`, { method: 'POST', body: '{}' })
}

// ---- teams ----

export interface TeamMember {
  agentId: string
  role: string
}

export interface TeamRoom {
  id: string
  name: string
  members: TeamMember[]
  grants: Record<string, string>
}

export interface TeamEntry {
  id: string
  name: string
  rooms: TeamRoom[]
}

export interface TeamsResponse {
  ok?: boolean
  teams: TeamEntry[]
}

export function fetchTeams(): Promise<TeamsResponse> {
  return requestJson<TeamsResponse>('/teams')
}

// ---- budgets ----

export interface BudgetEntry {
  scope: { kind: string; owner?: string }
  cap: number
  unit: string
  spent: number
}

export interface BudgetsResponse {
  ok: boolean
  budgets: BudgetEntry[]
}

export function fetchBudgets(): Promise<BudgetsResponse> {
  return requestJson<BudgetsResponse>('/budgets')
}

export function setBudget(data: { scope: { kind: string; owner?: string }; cap: number; unit?: string; actor: string }): Promise<{ ok: boolean; budget: BudgetEntry }> {
  return requestJson('/budgets', { method: 'POST', body: JSON.stringify(data) })
}

// ---- policy ----

export interface PolicyEntry {
  scope: { kind: string; agentId?: string }
  posture: string
}

export interface PolicyResponse {
  ok: boolean
  policies: PolicyEntry[]
}

export function fetchPolicy(): Promise<PolicyResponse> {
  return requestJson<PolicyResponse>('/policy')
}

export function setPolicy(data: { posture: string; scope: { kind: string; agentId?: string }; actor: string }): Promise<{ ok: boolean; posture: string; scope: { kind: string; agentId?: string } }> {
  return requestJson('/policy', { method: 'POST', body: JSON.stringify(data) })
}
