/**
 * fleet-agent admin HTTP surface (issue #26, orchestration-v3 §4.3 fleet-admin):
 * the buzz app-UI management page for agent profiles + the REST-ish API that
 * backs it. Routes are built as plain `(req, res)` handlers so the SAME
 * handlers serve both dsh's plugin-accessible webServer (via
 * `ctx.webServer.register(...)` — see src/index.ts and the research note in
 * orchestration/state/fleet-board-26.md) and the standalone `fleet-agent-admin`
 * bin (a minimal node:http server on port 3091 for headless/no-dsh use).
 *
 * Edits go through the FleetAgentService (updateProfile / register / disable /
 * enable), which persists runtime overrides in
 * `$DSH_HOME/fleet/agent/profiles.json`. Keys are never touched by admin.
 *
 * Routes:
 * ```
 * GET  /                → the admin page (HTML)
 * GET  /health          → liveness + store path + profile count
 * GET  /api/agents      → all profiles (JSON)
 * POST /api/agents      → create a profile (register)
 * POST /api/agents/:id            → update config (updateProfile)
 * POST /api/agents/:id/disable    → disable
 * POST /api/agents/:id/enable     → enable
 * ```
 * @module @hydra/dsh-fleet-agent/server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withRequestLog, type RequestLogTarget } from '../../../src/request-log.ts'
import { FLEET_ADMIN_PAGE_HTML } from './page.ts'
import { FleetAgentService, type FleetAgentProfile } from './service.ts'

/** The agent-config surface the admin page edits (public fields only). */
export interface FleetAdminAgentView {
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

/** The routes the admin surface serves (any HTTP carrier can mount them). */
export interface FleetAdminHandlers {
  /** GET / (or /admin) — the standalone admin page. */
  index(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** GET /health — liveness + store stats. */
  health(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** /api/agents* — the profile list + create/update/disable/enable API. */
  api(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** A parsed agent-id sub-route under /api/agents. */
interface AgentRoute {
  agentId: string
  op: 'update' | 'disable' | 'enable'
}

/** Parse `/api/agents` and `/api/agents/:id[/disable|/enable]` paths. */
function parseAgentApiPath(pathname: string): { list: true } | { list: false; route: AgentRoute } | undefined {
  if (pathname === '/api/agents' || pathname === '/api/agents/') return { list: true }
  const match = /^\/api\/agents\/([^/]+)(?:\/(disable|enable))?$/.exec(pathname)
  if (match === null) return undefined
  const agentId = decodeURIComponent(match[1] ?? '')
  const op = (match[2] ?? 'update') as AgentRoute['op']
  return { list: false, route: { agentId, op } }
}

/** Build the shared route handlers over one service. When `log` is given,
 * every request is captured in the fleet access log (`<storeDir>/logs/fleet-agent.requests.jsonl`). */
export function createAdminHandlers(
  agent: FleetAgentService,
  pageHtml = FLEET_ADMIN_PAGE_HTML,
  log?: RequestLogTarget,
): FleetAdminHandlers {
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
        service: 'fleet-agent-admin',
        profiles: agent.listProfiles().length,
      })
    }),
    api: wrap((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const parsed = parseAgentApiPath(pathname)
      if (parsed === undefined) {
        writeJson(res, 404, { ok: false, error: `not found: ${req.method ?? ''} ${pathname}` })
        return
      }
      if (parsed.list) {
        if (req.method === 'GET') {
          const profiles = agent.listProfiles()
          writeJson(res, 200, { count: profiles.length, profiles: profiles.map(toView) })
          return
        }
        if (req.method === 'POST') {
          void readJsonBody(req).then((body) => {
            const agentId = body?.agentId
            if (typeof agentId !== 'string' || agentId.length === 0) {
              writeJson(res, 400, { ok: false, error: 'POST /api/agents requires a string "agentId"' })
              return
            }
            const profile = agent.register({ agentId, ...body })
            writeJson(res, 201, { ok: true, profile: toView(profile) })
          }).catch((error: unknown) => {
            writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          })
          return
        }
        writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` })
        return
      }
      void readJsonBody(req).then((body) => {
        const { agentId, op } = parsed.route
        let profile: FleetAgentProfile
        if (op === 'disable') profile = agent.disable(agentId)
        else if (op === 'enable') profile = agent.enable(agentId)
        else profile = agent.updateProfile(agentId, pickPatch(body))
        writeJson(res, 200, { ok: true, profile: toView(profile) })
      }).catch((error: unknown) => {
        writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    }),
  }
}

/** Narrow a JSON body to the updateProfile patch (unknown keys ignored). */
function pickPatch(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const keys = [
    'name', 'role', 'claimRole', 'cwd', 'tier', 'provider', 'model', 'promptFile', 'avatar', 'enabled', 'status',
  ] as const
  const patch: Record<string, unknown> = {}
  for (const key of keys) {
    if (body !== undefined && body[key] !== undefined) patch[key] = body[key]
  }
  return patch
}

function toView(profile: FleetAgentProfile): FleetAdminAgentView {
  return {
    agentId: profile.agentId,
    name: profile.name,
    role: profile.role,
    status: profile.status,
    claimRole: profile.claimRole,
    cwd: profile.cwd,
    tier: profile.tier,
    provider: profile.provider,
    model: profile.model,
    promptFile: profile.promptFile,
    avatar: profile.avatar,
    enabled: profile.enabled,
    createdAt: profile.createdAt,
    publicKey: profile.publicKey,
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

/** Read + parse a small JSON request body (admin edits are tiny). */
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

/** Standalone server configuration (the `fleet-agent-admin` bin). */
export interface FleetAdminServerConfig {
  /** Listen host. Default `127.0.0.1`. */
  host?: string
  /** Listen port; 0 requests an OS-assigned port. Default 3093 (3091 is the host fleet-exporter). */
  port?: number
  /** Override the resolved DSH_HOME (tests / non-standard $DSH_HOME). */
  home?: string
}

/**
 * Minimal node:http server serving the admin routes over a live
 * FleetAgentService. No dsh process required — the service persists
 * directly to `$DSH_HOME/fleet/agent/profiles.json`.
 */
export class FleetAdminServer {
  private readonly agent: FleetAgentService
  private readonly handlers: FleetAdminHandlers
  private readonly server: ReturnType<typeof createServer>
  private listenedPort = 0
  private closed = false

  private readonly configHost: string
  private readonly configPort: number

  constructor(config: FleetAdminServerConfig = {}) {
    const ctx = new Context()
    const home = config.home ?? resolveDshHome()
    this.agent = new FleetAgentService(ctx, { home })
    this.configHost = config.host ?? process.env.FLEET_AGENT_ADMIN_HOST ?? '127.0.0.1'
    const explicit = config.port ?? Number(process.env.FLEET_AGENT_ADMIN_PORT ?? '3093')
    this.configPort = Number.isFinite(explicit) ? explicit : 3093
    this.handlers = createAdminHandlers(this.agent, undefined, { svc: 'fleet-agent', storeDir: join(home, 'fleet') })
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

  /** The live service backing this server (surface for tests). */
  get service(): FleetAgentService {
    return this.agent
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
    if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') return this.handlers.index(req, res)
    if (pathname.startsWith('/api/agents')) return this.handlers.api(req, res)
    writeJson(res, 404, { ok: false, error: `not found: ${req.method ?? ''} ${pathname}` })
  }

  private onError(error: Error): void {
    if (this.closed) return
    // eslint-disable-next-line no-console
    console.error(`fleet-agent-admin: ${error.message}`)
  }
}
