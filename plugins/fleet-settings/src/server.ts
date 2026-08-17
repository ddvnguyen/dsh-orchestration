/**
 * fleet-settings HTTP surface (issue #26, orchestration-v3 §4.4): the
 * companion /fleet-settings settings page on the fleet HTTP server — the
 * sanctioned settings surface (the dsh settings dialog is NOT extensible:
 * client-side composition slots in the read-only web bundle, verified in
 * orchestration/state/fleet-settings-26.md).
 *
 * Routes are plain `(req, res)` handlers so the SAME handlers serve both dsh's
 * plugin-accessible webServer (via `ctx.webServer.register`, src/index.ts)
 * and the standalone `fleet-settings-server` bin (port 3094). The dsh web
 * server passes the FULL path to a prefix handler, so the api handler is
 * wrapped with the shared `withMountPrefix` helper (src/family-mount.ts) to
 * strip the mount path before routing.
 *
 * Routes (mounted at `/` standalone, `/fleet-settings` on dsh's webServer):
 * ```
 * GET  /                       → the settings page (HTML, tabs)
 * GET  /health                 → liveness + store stats
 * GET  /api/sessions           → ledger entries + derived status + overlay archive flags
 * POST /api/sessions/:id/resume    → the session.prompt seam (executed when a dsh web base URL is set)
 * POST /api/sessions/:id/archive   → overlay marker + the workspace.archiveSession seam
 * GET  /api/agents             → fleet-agent profiles
 * POST /api/agents/:id         → updateProfile
 * POST /api/agents/:id/disable|enable
 * GET  /api/teams              → fleet-teams teams + rooms + members + grants
 * POST /api/teams/:teamId/rooms/:roomId/settings → grants / join / leave (fleet-teams service)
 * GET  /api/budgets            → fleet-budget status (levels + totals)
 * POST /api/budgets            → setBudget (cap/unit/owner)
 * GET  /api/policy             → fleet-policy posture status
 * POST /api/policy             → setPosture (context or per-identity)
 * ```
 * @module @hydra/dsh-fleet-settings/server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withMountPrefix } from '../../../src/family-mount.ts'
import { withRequestLog, type RequestLogTarget } from '../../../src/request-log.ts'
import { settingsPageHtml } from './page.ts'
import { createSettingsDeps, resumeSeam, archiveSeam, executeSeam, type SettingsDeps } from './service.ts'
import type { FleetAgentProfile } from '../../fleet-agent/src/service.ts'
import type { GrantMask } from '../../fleet-teams/src/types.ts'
import type { FleetBudgetScope } from '../../fleet-budget/src/types.ts'

/** The route surfaces the settings page serves (any HTTP carrier can mount). */
export interface SettingsHandlers {
  /** GET / (or /fleet-settings) — the settings page (HTML). */
  index(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** GET /health — liveness + store stats. */
  health(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** /api/* — sessions + the fleet settings sections. */
  api(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/**
 * Build the shared route handlers over one dep set. `mountPath` is the
 * webServer mount prefix (e.g. `/fleet-settings`); the standalone bin passes
 * '' and serves `/api/*` bare. The api handler is wrapped with the shared
 * `withMountPrefix` helper so the dsh webServer's FULL urls arrive stripped —
 * the same handler serves standalone and mounted (family-mount).
 */
export function createSettingsHandlers(
  deps: SettingsDeps,
  pageHtml = settingsPageHtml('/api'),
  mountPath = '',
  log?: RequestLogTarget,
): SettingsHandlers {
  const wrap = <T extends (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>(handler: T): T =>
    log === undefined ? handler : withRequestLog(log.svc, log.storeDir, handler)
  return {
    index: wrap((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pageHtml)
    }),
    health: wrap((_req, res) => {
      writeJson(res, 200, {
        ok: true,
        service: 'fleet-settings',
        sessionsRoot: deps.ledger.sessionsRoot,
        overlay: deps.overlay.path,
        agents: deps.agents.listProfiles().length,
        teams: deps.teams.listTeams().length,
        budgets: deps.budgets.list().length,
        dshWebBaseUrl: deps.dshWebBaseUrl ?? null,
      })
    }),
    api: wrap(withMountPrefix(mountPath, (req, res) => {
      void dispatchApi(req, res, deps)
    })),
  }
}

/** Dispatch one /api/* request to the matching sub-route (pathname already prefix-stripped). */
async function dispatchApi(req: IncomingMessage, res: ServerResponse, deps: SettingsDeps): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  try {
    // ---- sessions ----
    if (pathname === '/api/sessions') {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      writeJson(res, 200, await sessionList(deps))
      return
    }
    const resumeMatch = /^\/api\/sessions\/([^/]+)\/resume$/.exec(pathname)
    if (resumeMatch !== null) {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      const body = await readJsonBody(req)
      writeJson(res, 200, await resume(deps, decodeURIComponent(resumeMatch[1]!), body))
      return
    }
    const archiveMatch = /^\/api\/sessions\/([^/]+)\/archive$/.exec(pathname)
    if (archiveMatch !== null) {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      const body = await readJsonBody(req)
      writeJson(res, 200, await archive(deps, decodeURIComponent(archiveMatch[1]!), body))
      return
    }

    // ---- agents ----
    const agentMatch = /^\/api\/agents(?:\/([^/]+))?(?:\/(disable|enable))?$/.exec(pathname)
    if (agentMatch !== null) {
      if (agentMatch[1] === undefined) {
        if (req.method === 'GET') {
          const profiles = deps.agents.listProfiles()
          writeJson(res, 200, { count: profiles.length, profiles: profiles.map(toAgentView) })
          return
        }
        return methodNotAllowed(res, req.method)
      }
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      const body = await readJsonBody(req)
      const agentId = decodeURIComponent(agentMatch[1])
      const op = agentMatch[2]
      try {
        const profile = op === 'disable'
          ? deps.agents.disable(agentId)
          : op === 'enable' ? deps.agents.enable(agentId) : deps.agents.updateProfile(agentId, pickAgentPatch(body))
        writeJson(res, 200, { ok: true, profile: toAgentView(profile) })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // ---- teams ----
    if (pathname === '/api/teams') {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      writeJson(res, 200, teamList(deps))
      return
    }
    const roomSettingsMatch = /^\/api\/teams\/([^/]+)\/rooms\/([^/]+)\/settings$/.exec(pathname)
    if (roomSettingsMatch !== null) {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      const body = await readJsonBody(req)
      const roomId = decodeURIComponent(roomSettingsMatch[2]!)
      writeJson(res, 200, roomSettings(deps, roomId, body))
      return
    }

    // ---- budgets ----
    if (pathname === '/api/budgets') {
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, ...deps.budgets.status() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        try {
          const scope = parseBudgetScope(body)
          const cap = requirePositiveNumber(body, 'cap')
          const budget = deps.budgets.setBudget({
            scope,
            cap,
            ...(typeof body?.unit === 'string' ? { unit: body.unit as 'tokens' | 'cost' } : {}),
            ...(typeof body?.owner === 'string' && (body.owner as string).length > 0 ? { owner: body.owner as string } : {}),
          }, requireString(body, 'actor'))
          writeJson(res, 200, { ok: true, budget })
          return
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      return methodNotAllowed(res, req.method)
    }

    // ---- policy ----
    if (pathname === '/api/policy') {
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, ...deps.policy.status() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        try {
          const posture = requireString(body, 'posture')
          const scope = body?.scope === 'identity'
            ? { kind: 'identity' as const, agentId: requireString(body, 'agentId') }
            : { kind: 'context' as const }
          const effective = deps.policy.setPosture(scope, posture as never, requireString(body, 'actor'))
          writeJson(res, 200, { ok: true, posture: effective, scope })
          return
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      return methodNotAllowed(res, req.method)
    }

    writeJson(res, 404, { ok: false, error: `not found: ${req.method ?? ''} ${pathname}` })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// ---- sessions views ----

/** The full session list: ledger entries + overlay archive flags. */
async function sessionList(deps: SettingsDeps): Promise<{
  ok: true
  count: number
  running: number
  archived: string[]
  sessions: Array<SessionRow & { archived: boolean }>
}> {
  const entries = await deps.ledger.list()
  const overlay = deps.overlay.all()
  const sessions = entries.map(entry => ({ ...toSessionRow(entry), archived: overlay[entry.id]?.archived === true }))
  return {
    ok: true,
    count: sessions.length,
    running: sessions.filter(session => session.status === 'running').length,
    archived: sessions.filter(session => session.archived).map(session => session.id),
    sessions,
  }
}

/** One session row the page renders (ledger-derived + overlay-aware). */
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

function toSessionRow(entry: Awaited<ReturnType<SettingsDeps['ledger']['list']>>[number]): SessionRow {
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

/** The resume seam: the session.prompt RPC payload + (optionally) execute it. */
async function resume(
  deps: SettingsDeps,
  sessionId: string,
  body: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const entry = await deps.ledger.get(sessionId)
  const text = typeof body?.text === 'string' ? body.text as string : ''
  const baseUrl = pickBaseUrl(deps, body)
  const seam = resumeSeam(baseUrl ?? 'http://localhost', sessionId, text)
  const executed = await executeSeam(seam, baseUrl)
  return {
    ok: true,
    session: entry === undefined ? undefined : toSessionRow(entry),
    seam: seam.method,
    target: { url: seam.url, method: 'POST', contentType: 'application/json', body: seam.body },
    ...executed,
  }
}

/** Archive: the overlay marker (always) + the workspace.archiveSession seam (when a host is reachable). */
async function archive(
  deps: SettingsDeps,
  sessionId: string,
  body: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const archived = body?.archived === undefined ? true : body.archived === true
  const overlay = deps.overlay.setArchived(sessionId, archived)
  const baseUrl = pickBaseUrl(deps, body)
  const seam = archiveSeam(baseUrl ?? 'http://localhost', sessionId)
  const executed = await executeSeam(seam, baseUrl)
  return {
    ok: true,
    sessionId,
    archived,
    overlay,
    seam: seam.method,
    target: { url: seam.url, method: 'POST', contentType: 'application/json', body: seam.body },
    ...executed,
  }
}

// ---- fleet settings views ----

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

/** Teams + rooms + members + effective grants (the teams tab, read view). */
function teamList(deps: SettingsDeps): {
  ok: boolean
  teams: Array<{ team: unknown; rooms: Array<{ room: unknown; members: string[]; grants: Record<string, GrantMask> }> }>
} {
  return {
    ok: true,
    teams: deps.teams.listTeams().map(team => ({
      team,
      rooms: deps.teams.listRooms(team.id).map(room => {
        const grants: Record<string, GrantMask> = {}
        for (const agentId of room.memberIds) grants[agentId] = deps.teams.effectiveGrants(agentId, room.id)
        return { room, members: room.memberIds, grants }
      }),
    })),
  }
}

/** Settings-dialog mutations: grants / join / leave via the fleet-teams service. */
function roomSettings(
  deps: SettingsDeps,
  roomId: string,
  body: Record<string, unknown> | undefined,
): { ok: boolean; room: unknown; grantsUpdated: boolean } {
  const actor = requireString(body, 'actor')
  const room = deps.teams.getRoom(roomId)
  if (room === undefined) throw new Error(`fleet-settings: room "${roomId}" not found`)

  if (body?.grants !== undefined || body?.overrides !== undefined) {
    const mask = body?.grants as Record<string, unknown> | undefined
    const overrides = body?.overrides as Record<string, Record<string, unknown>> | undefined
    const overrideRecord: Record<string, Partial<GrantMask>> = {}
    if (overrides !== null && typeof overrides === 'object') {
      for (const [agentId, entry] of Object.entries(overrides)) {
        if (entry === null || typeof entry !== 'object') continue
        overrideRecord[agentId] = {
          ...(typeof entry.read === 'boolean' ? { read: entry.read } : {}),
          ...(typeof entry.post === 'boolean' ? { post: entry.post } : {}),
          ...(typeof entry.join === 'boolean' ? { join: entry.join } : {}),
        }
      }
    }
    const grants = mask !== undefined && typeof mask === 'object'
      ? { read: mask.read === true, post: mask.post === true, join: mask.join === true }
      : undefined
    deps.teams.setRoomGrants(roomId, { ...(grants !== undefined ? { grants } : {}), overrides: overrideRecord }, actor)
  }
  if (body?.join !== undefined) deps.teams.joinRoom(roomId, requireString(body, 'join'))
  if (body?.leave !== undefined) deps.teams.leaveRoom(roomId, requireString(body, 'leave'))

  return { ok: true, room: deps.teams.getRoom(roomId), grantsUpdated: body?.grants !== undefined || body?.overrides !== undefined }
}

// ---- helpers ----

/** Resolve the dsh web base URL: the request may override the configured one. */
function pickBaseUrl(deps: SettingsDeps, body: Record<string, unknown> | undefined): string | undefined {
  if (typeof body?.dshWebBaseUrl === 'string' && (body.dshWebBaseUrl as string).length > 0) return body.dshWebBaseUrl as string
  return deps.dshWebBaseUrl
}

/** Narrow a JSON body to the updateProfile patch (unknown keys ignored). */
function pickAgentPatch(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const keys = [
    'name', 'role', 'claimRole', 'cwd', 'tier', 'provider', 'model', 'promptFile', 'avatar', 'enabled', 'status',
  ] as const
  const patch: Record<string, unknown> = {}
  for (const key of keys) {
    if (body !== undefined && body[key] !== undefined) patch[key] = body[key]
  }
  return patch
}

/** Parse the budget scope from a set-budget body. */
function parseBudgetScope(body: Record<string, unknown> | undefined): FleetBudgetScope {
  if (body?.scope === undefined) return { kind: 'global' }
  if (typeof body.scope !== 'object' || body.scope === null) throw new Error('fleet-settings: budget scope must be an object')
  const scope = body.scope as Record<string, unknown>
  if (scope.kind === 'global') return { kind: 'global' }
  if (scope.kind === 'agent') {
    const agentId = scope.agentId
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new Error('fleet-settings: an agent budget scope requires a non-empty "agentId"')
    }
    return { kind: 'agent', agentId }
  }
  throw new Error('fleet-settings: unsupported budget scope (global or agent supported)')
}

function requireString(body: Record<string, unknown> | undefined, key: string): string {
  if (body === undefined || typeof body[key] !== 'string' || (body[key] as string).length === 0) {
    throw new Error(`fleet-settings: a non-empty "${key}" is required`)
  }
  return body[key] as string
}

function requirePositiveNumber(body: Record<string, unknown> | undefined, key: string): number {
  const value = body?.[key]
  if (typeof value !== 'number' || !(value > 0)) throw new Error(`fleet-settings: a positive number "${key}" is required`)
  return value
}

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

/** Read + parse a small JSON request body (settings edits are tiny). */
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

/** Standalone server configuration (the `fleet-settings-server` bin). */
export interface FleetSettingsServerConfig {
  /** Listen host. Default `127.0.0.1`. */
  host?: string
  /** Listen port; 0 requests an OS-assigned port. Default 3094. */
  port?: number
  /** Override the resolved DSH_HOME (tests / non-standard $DSH_HOME). */
  home?: string
  /** Base URL of the dsh web gateway (resume/archive execution). */
  dshWebBaseUrl?: string
}

/**
 * Minimal node:http server serving the settings page + API over a live
 * settings dep set. No dsh process required — the services persist to the
 * same durable dirs (the fleet-agent-admin / fleet-teams-ui server pattern).
 */
export class FleetSettingsServer {
  private readonly deps: SettingsDeps
  private readonly handlers: SettingsHandlers
  private readonly server: ReturnType<typeof createServer>
  private listenedPort = 0
  private closed = false

  private readonly configHost: string
  private readonly configPort: number

  constructor(config: FleetSettingsServerConfig = {}) {
    const pageHtml = settingsPageHtml('/api')
    const home = config.home ?? resolveDshHome()
    this.deps = createSettingsDeps({ home, dshWebBaseUrl: config.dshWebBaseUrl })
    this.configHost = config.host ?? process.env.FLEET_SETTINGS_HOST ?? '127.0.0.1'
    const explicit = config.port ?? Number(process.env.FLEET_SETTINGS_PORT ?? '3094')
    this.configPort = Number.isFinite(explicit) ? explicit : 3094
    this.handlers = createSettingsHandlers(this.deps, pageHtml, '', {
      svc: 'fleet-settings',
      storeDir: join(home, 'fleet'),
    })
    this.server = createServer((req, res) => {
      this.dispatch(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } else {
          res.destroy()
        }
      })
    })
    this.server.on('error', (error) => { this.onError(error) })
  }

  /** The live settings dep set backing this server (surface for tests). */
  get service(): SettingsDeps {
    return this.deps
  }

  /** The bind host (surface for tests/status). */
  get host(): string {
    return this.configHost
  }

  /** The bound port (OS-assigned when config.port was 0). */
  get port(): number {
    return this.listenedPort
  }

  /** Bind and start listening. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.configPort, this.configHost, () => {
        this.server.off('error', reject)
        const address = this.server.address()
        this.listenedPort = address !== null && typeof address === 'object' ? address.port : 0
        resolve()
      })
    })
  }

  /** Stop accepting connections and close. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    return new Promise((resolve) => {
      this.server.closeAllConnections()
      this.server.close(() => resolve())
    })
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname === '/health') return this.handlers.health(req, res)
    if (pathname === '/' || pathname === '/fleet-settings' || pathname === '/fleet-settings/') return this.handlers.index(req, res)
    if (pathname.startsWith('/api/')) return this.handlers.api(req, res)
    writeJson(res, 404, { ok: false, error: `not found: ${req.method ?? ''} ${pathname}` })
  }

  private onError(error: Error): void {
    if (this.closed) return
    // eslint-disable-next-line no-console
    console.error(`fleet-settings-server: ${error.message}`)
  }
}
