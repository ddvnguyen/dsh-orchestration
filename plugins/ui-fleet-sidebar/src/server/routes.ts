/**
 * `/api/fleet` HTTP surface for the ui-fleet-sidebar panels (heartbeat
 * management + fleet data read views). Built as plain `(req, res)` handlers
 * and mounted on the dsh webServer via `ctx.webServer.register` (src/index.ts)
 * at the `/api/fleet` prefix (the fleet-board / fleet-settings webServer
 * pattern, research note in orchestration/state/fleet-board-26.md).
 *
 * The dsh webServer passes the FULL pathname to a prefix handler, so the api
 * handler is wrapped with the shared `withMountPrefix` helper
 * (src/family-mount.ts) to strip `/api/fleet` before routing.
 *
 * All fleet-family services are optional (`ctx.get` at apply time):
 * - Heartbeats need `ctx.fleetSchedule` (plugins/fleet-schedule). When it is
 *   not composed the heartbeat routes answer 503 with a clear reason — a
 *   shadow ScheduleService is deliberately NOT created, because a second
 *   instance would start its own 1 s tick timer and double-run schedules.
 * - Fleet data (agents/teams/sessions/budgets/policy) falls back to fresh
 *   service instances over the same durable dirs (the fleet-settings
 *   pattern), so the Orchestration tabs work in any composition.
 *
 * Routes (standalone paths after the mount strip):
 * ```
 * GET    /heartbeats               → list schedules
 * POST   /heartbeats               → create schedule
 * GET    /heartbeats/:id           → schedule detail (incl. run history)
 * PUT    /heartbeats/:id           → update schedule
 * DELETE /heartbeats/:id           → delete schedule
 * POST   /heartbeats/:id/pause     → pause
 * POST   /heartbeats/:id/resume    → resume
 * POST   /heartbeats/:id/run       → run once (manual trigger)
 * GET    /agents                   → fleet-agent profiles
 * GET    /teams                    → teams + rooms + members + effective grants
 * GET    /sessions                 → session ledger rows
 * GET    /budgets                  → fleet-budget status
 * POST   /budgets                  → setBudget
 * GET    /policy                   → fleet-policy status
 * POST   /policy                   → setPosture
 * ```
 * @module @hydra/dsh-fleet-sidebar/server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { withRequestLog, type RequestLogTarget } from '../../../../src/request-log.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withMountPrefix } from '../../../../src/family-mount.ts'
import type { ScheduleCadence } from '../../../../src/types.ts'
import type { ScheduleCreateInput, ScheduleUpdatePatch } from '../../../../src/schedule-service.ts'
import { ScheduleService } from '../../../../src/schedule-service.ts'
import { FleetAgentService, type FleetAgentProfile } from '../../../fleet-agent/src/service.ts'
import { FleetTeamsService } from '../../../fleet-teams/src/service.ts'
import { FleetBudgetService } from '../../../fleet-budget/src/service.ts'
import { FleetPolicyService } from '../../../fleet-policy/src/service.ts'
import { SessionLedger, type SessionLedgerEntry } from '../../../fleet-settings/src/sessions.ts'

/** The optional fleet services + durable-dir anchor the API family consumes. */
export interface FleetSidebarDeps {
  /** DSH_HOME for shadow service instances. */
  home?: string
  /** Live `ctx.fleetSchedule` — required for heartbeat routes. */
  schedule?: ScheduleService
  /** Live `ctx.fleetAgent` (agents tab). */
  agents?: FleetAgentService
  /** Live `ctx.fleetTeams` (teams tab). */
  teams?: FleetTeamsService
  /** Live `ctx.fleetBudget` (budgets tab). */
  budgets?: FleetBudgetService
  /** Live `ctx.fleetPolicy` (policy tab). */
  policy?: FleetPolicyService
}

/** The route surfaces the sidebar panels consume (mount on any HTTP carrier). */
export interface FleetSidebarHandlers {
  /** GET /api/fleet/health — liveness + live-vs-shadow service report. */
  health(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** /api/fleet/* — heartbeats + fleet data. */
  api(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** The webServer mount path of the api handler (see src/index.ts). */
export const API_MOUNT_PATH = '/api/fleet'
/** Synthetic actor for browser-initiated mutations (no agent identity on HTTP). */
export const WEB_UI_ACTOR = 'web-ui'

/**
 * Build the route handlers over one dep set. The dsh webServer passes full
 * urls to prefix handlers, so the api handler is wrapped with the shared
 * `withMountPrefix` helper (src/family-mount.ts) — the SAME handler would
 * serve a standalone bin unmodified.
 */
export function createFleetSidebarHandlers(
  deps: FleetSidebarDeps,
  log?: RequestLogTarget,
): FleetSidebarHandlers {
  const wrap = <T extends (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>(handler: T): T =>
    log === undefined ? handler : withRequestLog(log.svc, log.storeDir, handler)
  return {
    health: wrap((_req, res) => {
      writeJson(res, 200, {
        ok: true,
        service: 'fleet-sidebar',
        schedule: deps.schedule !== undefined ? 'live' : 'missing',
        agents: deps.agents !== undefined ? 'live' : 'shadow',
        teams: deps.teams !== undefined ? 'live' : 'shadow',
        budgets: deps.budgets !== undefined ? 'live' : 'shadow',
        policy: deps.policy !== undefined ? 'live' : 'shadow',
        home: deps.home ?? '',
      })
    }),
    api: wrap(withMountPrefix(API_MOUNT_PATH, (req, res) => {
      void dispatchApi(req, res, deps)
    })),
  }
}

/** Dispatch one `/api/fleet/*` request (pathname already prefix-stripped). */
async function dispatchApi(req: IncomingMessage, res: ServerResponse, deps: FleetSidebarDeps): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  try {
    // ---- heartbeats ----
    if (pathname === '/heartbeats') {
      const schedule = requireSchedule(deps, res)
      if (schedule === undefined) return
      if (req.method === 'GET') {
        const schedules = schedule.list()
        writeJson(res, 200, { ok: true, count: schedules.length, schedules })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        void scheduleCreate(schedule, body, res)
        return
      }
      return methodNotAllowed(res, req.method)
    }
    const heartbeatMatch = /^\/heartbeats\/([^/]+)$/.exec(pathname)
    if (heartbeatMatch !== null) {
      const schedule = requireSchedule(deps, res)
      if (schedule === undefined) return
      const id = decodeURIComponent(heartbeatMatch[1] ?? '')
      if (req.method === 'GET') {
        const record = schedule.inspect(id)
        if (record === undefined) return notFound(res, `heartbeat "${id}"`)
        writeJson(res, 200, { ok: true, schedule: record })
        return
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req)
        try {
          const record = schedule.update(id, scheduleActor(schedule, id, body), pickSchedulePatch(body))
          writeJson(res, 200, { ok: true, schedule: record })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: errorMessage(error) })
        }
        return
      }
      if (req.method === 'DELETE') {
        try {
          const removed = schedule.delete(id, scheduleActor(schedule, id, undefined))
          writeJson(res, 200, { ok: true, ...removed })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: errorMessage(error) })
        }
        return
      }
      return methodNotAllowed(res, req.method)
    }
    const heartbeatVerbMatch = /^\/heartbeats\/([^/]+)\/(pause|resume|run)$/.exec(pathname)
    if (heartbeatVerbMatch !== null) {
      const schedule = requireSchedule(deps, res)
      if (schedule === undefined) return
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      const id = decodeURIComponent(heartbeatVerbMatch[1] ?? '')
      const verb = heartbeatVerbMatch[2]
      try {
        const actor = scheduleActor(schedule, id, undefined)
        const record = verb === 'pause'
          ? schedule.pause(id, actor)
          : verb === 'resume' ? schedule.resume(id, actor) : schedule.runOnce(id, actor)
        writeJson(res, 200, { ok: true, schedule: record })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorMessage(error) })
      }
      return
    }

    // ---- agents ----
    if (pathname === '/agents') {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      const profiles = agents(deps).listProfiles()
      writeJson(res, 200, { ok: true, count: profiles.length, profiles: profiles.map(toAgentView) })
      return
    }

    // ---- teams ----
    if (pathname === '/teams') {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      writeJson(res, 200, teamList(deps))
      return
    }

    // ---- sessions ----
    if (pathname === '/sessions') {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      writeJson(res, 200, await sessionList(deps))
      return
    }

    // ---- budgets ----
    if (pathname === '/budgets') {
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, ...budgets(deps).status() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        try {
          const scope = parseBudgetScope(body)
          const cap = requirePositiveNumber(body, 'cap')
          const budget = budgets(deps).setBudget({
            scope,
            cap,
            ...(typeof body?.unit === 'string' ? { unit: body.unit as 'tokens' | 'cost' } : {}),
            ...(typeof body?.owner === 'string' && body.owner.length > 0 ? { owner: body.owner } : {}),
          }, actorOf(body))
          writeJson(res, 200, { ok: true, budget })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: errorMessage(error) })
        }
        return
      }
      return methodNotAllowed(res, req.method)
    }

    // ---- policy ----
    if (pathname === '/policy') {
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, ...policy(deps).status() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        try {
          const posture = requireString(body, 'posture') as 'Strict' | 'Auto' | 'Dangerous'
          const scope = body?.scope === 'identity'
            ? { kind: 'identity' as const, agentId: requireString(body, 'agentId') }
            : { kind: 'context' as const }
          const effective = policy(deps).setPosture(scope, posture, actorOf(body))
          writeJson(res, 200, { ok: true, posture: effective, scope })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: errorMessage(error) })
        }
        return
      }
      return methodNotAllowed(res, req.method)
    }

    writeJson(res, 404, { ok: false, error: `not found: ${req.method ?? ''} ${pathname}` })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: errorMessage(error) })
  }
}

// ---- heartbeats ----

/** Require the live schedule service, else answer 503 (graceful degradation). */
function requireSchedule(deps: FleetSidebarDeps, res: ServerResponse): ScheduleService | undefined {
  if (deps.schedule !== undefined) return deps.schedule
  writeJson(res, 503, {
    ok: false,
    error: 'fleet-schedule plugin is not composed — heartbeat routes are unavailable. ' +
      'No shadow ScheduleService is created because a second instance would run its own tick timer.',
  })
  return undefined
}

/** Create a schedule from a POST body (target agent, cadence, limits). */
async function scheduleCreate(schedule: ScheduleService, body: Record<string, unknown> | undefined, res: ServerResponse): Promise<void> {
  try {
    const prompt = requireString(body, 'prompt')
    const cadence = parseCadence(body)
    const input: ScheduleCreateInput = {
      prompt,
      cadence,
      target: parseTarget(body),
      ...(typeof body?.name === 'string' && body.name.length > 0 ? { name: body.name } : {}),
      ...(body?.maxRuns !== undefined && body.maxRuns !== null ? { maxRuns: requirePositiveNumber(body, 'maxRuns') } : {}),
      ...(body?.expiresInMs !== undefined && body.expiresInMs !== null ? { expiresInMs: requirePositiveNumber(body, 'expiresInMs') } : {}),
      ...(body?.expiresAt !== undefined && body.expiresAt !== null ? { expiresAt: requirePositiveNumber(body, 'expiresAt') } : {}),
    }
    const record = schedule.create(input, actorOf(body))
    writeJson(res, 201, { ok: true, schedule: record })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: errorMessage(error) })
  }
}

/** Parse a cadence body: `{ type: 'every', everyMs }` or `{ type: 'cron', expression, timezone? }`. */
function parseCadence(body: Record<string, unknown> | undefined): ScheduleCadence {
  const raw = body?.cadence
  if (raw === null || typeof raw !== 'object') throw new Error('fleet-sidebar: "cadence" must be an object')
  const cadence = raw as Record<string, unknown>
  if (cadence.type === 'every') {
    const everyMs = cadence.everyMs
    if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs <= 0) {
      throw new Error('fleet-sidebar: cadence.everyMs must be a positive number (ms)')
    }
    return { type: 'every', everyMs }
  }
  if (cadence.type === 'cron') {
    const expression = cadence.expression
    if (typeof expression !== 'string' || expression.trim().length === 0) {
      throw new Error('fleet-sidebar: cadence.expression must be a non-empty cron string')
    }
    const timezone = cadence.timezone
    return typeof timezone === 'string' && timezone.trim().length > 0
      ? { type: 'cron', expression: expression.trim(), timezone: timezone.trim() }
      : { type: 'cron', expression: expression.trim() }
  }
  throw new Error('fleet-sidebar: cadence.type must be "every" | "cron"')
}

/** Parse the target agent: `{ type:'agent', agentId }` or a bare agentId string. */
function parseTarget(body: Record<string, unknown> | undefined): ScheduleCreateInput['target'] {
  const raw = body?.target
  if (typeof raw === 'string' && raw.trim().length > 0) return { type: 'agent', agentId: raw.trim() }
  if (raw !== null && typeof raw === 'object') {
    const target = raw as Record<string, unknown>
    const agentId = typeof target.agentId === 'string' ? target.agentId.trim() : ''
    if (target.type === 'agent' && agentId.length > 0) return { type: 'agent', agentId }
  }
  throw new Error('fleet-sidebar: "target" must be an agentId string or { type: "agent", agentId }')
}

/** Narrow a PUT body to the ScheduleUpdatePatch (null clears label/limits). */
function pickSchedulePatch(body: Record<string, unknown> | undefined): ScheduleUpdatePatch {
  const patch: ScheduleUpdatePatch = {}
  if (body !== undefined && body.name !== undefined) {
    if (body.name !== null && typeof body.name !== 'string') throw new Error('fleet-sidebar: "name" must be a string or null')
    patch.name = body.name === null ? null : body.name
  }
  if (body !== undefined && body.prompt !== undefined) {
    if (typeof body.prompt !== 'string') throw new Error('fleet-sidebar: "prompt" must be a string')
    patch.prompt = body.prompt
  }
  if (body !== undefined && body.cadence !== undefined) patch.cadence = parseCadence(body)
  if (body !== undefined && body.maxRuns !== undefined) {
    patch.maxRuns = body.maxRuns === null ? null : requirePositiveNumber(body, 'maxRuns')
  }
  if (body !== undefined && body.expiresAt !== undefined) {
    patch.expiresAt = body.expiresAt === null ? null : requirePositiveNumber(body, 'expiresAt')
  }
  return patch
}

/** The acting identity for bus attribution; bodies may override the default. */
function actorOf(body: Record<string, unknown> | undefined): string {
  return typeof body?.actor === 'string' && body.actor.length > 0 ? body.actor : WEB_UI_ACTOR
}

/**
 * The actor for one owned-schedule mutation: an explicit body actor wins,
 * otherwise the schedule's OWNER (its target agent) — the web UI acts on the
 * agent's behalf, and fleet-schedule mutations are ownership-scoped, so the
 * sidebar must present itself as the schedule's target to pass the check.
 */
function scheduleActor(schedule: ScheduleService, id: string, body: Record<string, unknown> | undefined): string {
  const explicit = typeof body?.actor === 'string' && body.actor.length > 0 ? body.actor : undefined
  if (explicit !== undefined) return explicit
  return schedule.inspect(id)?.target.agentId ?? WEB_UI_ACTOR
}

// ---- fleet data views ----

/** Shadow-or-live agent service (the fleet-settings standalone pattern). */
function agents(deps: FleetSidebarDeps): FleetAgentService {
  if (deps.agents !== undefined) return deps.agents
  return new FleetAgentService(new Context(), { home: deps.home ?? resolveDshHome() })
}

/** Shadow-or-live teams service. */
function teams(deps: FleetSidebarDeps): FleetTeamsService {
  if (deps.teams !== undefined) return deps.teams
  const home = deps.home ?? resolveDshHome()
  return new FleetTeamsService(new Context(), { home, storeDir: `${home}/fleet/teams` })
}

/** Shadow-or-live budget service. */
function budgets(deps: FleetSidebarDeps): FleetBudgetService {
  if (deps.budgets !== undefined) return deps.budgets
  return new FleetBudgetService(new Context(), {})
}

/** Shadow-or-live policy service. */
function policy(deps: FleetSidebarDeps): FleetPolicyService {
  if (deps.policy !== undefined) return deps.policy
  return new FleetPolicyService(new Context(), {})
}

/** Shadow-or-live session ledger. */
function ledger(deps: FleetSidebarDeps): SessionLedger {
  return new SessionLedger({ home: deps.home ?? resolveDshHome() })
}

/** The full session list (ledger rows; simplified — no overlay archive flags). */
async function sessionList(deps: FleetSidebarDeps): Promise<{
  ok: true
  count: number
  running: number
  sessions: Array<SessionRow & { archived: false }>
}> {
  const entries = await ledger(deps).list()
  const sessions = entries.map(entry => ({ ...toSessionRow(entry), archived: false as const }))
  return {
    ok: true,
    count: sessions.length,
    running: sessions.filter(session => session.status === 'running').length,
    sessions,
  }
}

/** One session row the sidebar Sessions tab renders (ledger-derived). */
export interface SessionRow {
  id: string
  title?: string
  agentPreset?: string
  origin?: 'subagent'
  cwd?: string
  status: 'running' | 'done' | 'idle'
  hasActivity: boolean
  createdAt: number
  updatedAt: number
}

function toSessionRow(entry: SessionLedgerEntry): SessionRow {
  return {
    id: entry.id,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.agentPreset !== undefined ? { agentPreset: entry.agentPreset } : {}),
    ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
    ...(entry.header.cwd !== undefined ? { cwd: entry.header.cwd } : {}),
    status: entry.status,
    hasActivity: entry.hasActivity,
    createdAt: entry.header.createdAt,
    updatedAt: entry.updatedAt,
  }
}

/** Teams + rooms + members + effective grants (the teams tab, read view). */
function teamList(deps: FleetSidebarDeps): {
  ok: true
  teams: Array<{ team: unknown; rooms: Array<{ room: unknown; members: string[]; grants: Record<string, unknown> }> }>
} {
  const service = teams(deps)
  return {
    ok: true,
    teams: service.listTeams().map(team => ({
      team,
      rooms: service.listRooms(team.id).map(room => {
        const grants: Record<string, unknown> = {}
        for (const agentId of room.memberIds) grants[agentId] = service.effectiveGrants(agentId, room.id)
        return { room, members: room.memberIds, grants }
      }),
    })),
  }
}

/** The fleet-agent profile surface (public fields only, like fleet-agent-admin). */
export interface AgentView {
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

function toAgentView(profile: FleetAgentProfile): AgentView {
  return {
    agentId: profile.agentId,
    name: profile.name,
    role: profile.role,
    status: profile.status,
    ...(profile.claimRole !== undefined ? { claimRole: profile.claimRole } : {}),
    ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}),
    ...(profile.tier !== undefined ? { tier: profile.tier } : {}),
    ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.promptFile !== undefined ? { promptFile: profile.promptFile } : {}),
    ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
    enabled: profile.enabled,
    createdAt: profile.createdAt,
    publicKey: profile.publicKey,
  }
}

// ---- budgets / policy body parsing ----

/** Parse the budget scope from a set-budget body (the fleet-settings shape). */
function parseBudgetScope(body: Record<string, unknown> | undefined): { kind: 'global' } | { kind: 'agent'; agentId: string } | { kind: 'task-kind'; taskKind: string } {
  if (body?.scope === undefined) return { kind: 'global' }
  if (typeof body.scope !== 'object' || body.scope === null) throw new Error('fleet-sidebar: budget scope must be an object')
  const scope = body.scope as Record<string, unknown>
  if (scope.kind === 'global') return { kind: 'global' }
  if (scope.kind === 'agent') {
    const agentId = scope.agentId
    if (typeof agentId !== 'string' || agentId.length === 0) throw new Error('fleet-sidebar: agent budget scope requires a string agentId')
    return { kind: 'agent', agentId }
  }
  if (scope.kind === 'task-kind') {
    const taskKind = scope.taskKind
    if (typeof taskKind !== 'string' || taskKind.length === 0) throw new Error('fleet-sidebar: task-kind budget scope requires a string taskKind')
    return { kind: 'task-kind', taskKind }
  }
  throw new Error(`fleet-sidebar: unknown budget scope kind "${String(scope.kind)}"`)
}

// ---- helpers ----

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

function methodNotAllowed(res: ServerResponse, method: string | undefined): void {
  writeJson(res, 405, { ok: false, error: `method not allowed: ${method ?? ''}` })
}

function notFound(res: ServerResponse, what: string): void {
  writeJson(res, 404, { ok: false, error: `not found: ${what}` })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read + parse a small JSON request body. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve(undefined)
        return
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : undefined)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

function requireString(body: Record<string, unknown> | undefined, key: string): string {
  const value = body?.[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`fleet-sidebar: "${key}" must be a non-empty string`)
  }
  return value.trim()
}

function requirePositiveNumber(body: Record<string, unknown> | undefined, key: string): number {
  const value = body?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`fleet-sidebar: "${key}" must be a positive number`)
  }
  return value
}
