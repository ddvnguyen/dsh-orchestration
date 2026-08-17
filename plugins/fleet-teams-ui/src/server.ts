/**
 * fleet-teams-ui HTTP surface (issue #26, orchestration-v3 §4 P4.2): the
 * rooms page — a fleet-hosted companion page (board-server pattern) that
 * renders each room's chat thread with sender name/avatar/role badges
 * resolved from the fleet-agent profile registry, plus the team menu → room
 * settings dialog. The dsh web app itself is NEVER touched (owner
 * constraint); everything rides on the fleet HTTP surface.
 *
 * Routes are built as plain `(req, res)` handlers so the SAME handlers serve
 * both dsh's plugin-accessible webServer (via `ctx.webServer.register` — see
 * src/index.ts) and the standalone `fleet-teams-ui-server` bin. The handlers
 * consume the fleet-teams service (ctx.fleetTeams when composed; a fresh
 * service over the same durable dirs standalone) + the durable overlay
 * (src/overlay.ts) + the profile registry (src/identity.ts) + the fleet-bus
 * store (via the board feed, for the live thread tail).
 *
 * Routes (mounted at `/` standalone, `/fleet-teams-ui` on dsh's webServer):
 * ```
 * GET  /                          → the rooms page (HTML)
 * GET  /health                    → liveness + store stats
 * GET  /api/profiles              → registered fleet-agent profiles
 * GET  /api/rooms                 → teams + rooms + members + overlay
 * GET  /api/rooms/:id             → room detail (memory, grants, scope, linked tasks)
 * GET  /api/rooms/:id/messages?since= → chat thread (team-post events + memory timeline)
 * POST /api/rooms/:id/post        → composer (grant-checked via fleet-teams)
 * POST /api/rooms/:id/settings    → settings-dialog mutations (grants/members/rename/archive)
 * ```
 * @module @hydra/dsh-fleet-teams-ui/server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withMountPrefix } from '../../../src/family-mount.ts'
import { withRequestLog, type RequestLogTarget } from '../../../src/request-log.ts'
import { teamsUiPageHtml } from './page.ts'
import { ProfileStore, senderBadge, type SenderBadge } from './identity.ts'
import { TeamsUiOverlay, type RoomOverlay } from './overlay.ts'
import { FleetTeamsService } from '../../fleet-teams/src/service.ts'
import { FleetBusService } from '../../fleet-bus/src/service.ts'
import type { FleetRoom, FleetTeam, GrantMask, RoomPost } from '../../fleet-teams/src/types.ts'
import { FleetBoardFeed } from '../../fleet-board/src/feed.ts'

/** The service + store deps the handlers need (any HTTP carrier can mount). */
export interface TeamsUiDeps {
  /** The fleet-teams service (grant authority + durable teams/memory state). */
  teams: FleetTeamsService
  /** The durable UI overlay (rename/archive presentation state). */
  overlay: TeamsUiOverlay
  /** The fleet-agent profile registry reader (sender identity). */
  profiles: ProfileStore
  /** Directory holding the fleet-bus store (the live thread tail). */
  storeDir?: string
}

/** The three route surfaces (mirrors the fleet-board/agent handler shape). */
export interface TeamsUiHandlers {
  /** GET / — the rooms page (HTML). */
  index(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** GET /health — liveness + store stats. */
  health(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** /api/* — profiles + rooms + thread + composer + settings. */
  api(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** One thread message rendered with its sender badge. */
export interface ThreadMessageView {
  /** Durable identity (the timeline post id, or `event-<seq>`). */
  id: string
  /** The posting agent id. */
  actor: string
  /** The rendered sender badge (name/avatar/role). */
  sender: SenderBadge
  /** The message body. */
  body: string
  /** Unix epoch ms. */
  ts: number
  /** Origin: the durable memory timeline, or a live team-post bus event. */
  origin: 'timeline' | 'event'
}

/** The room list view: one room + its team + overlay + member badges. */
export interface RoomListView {
  room: FleetRoom
  team: FleetTeam | undefined
  /** Effective grants per room member (the read/post/join model). */
  memberGrants: Record<string, GrantMask>
  overlay: RoomOverlay
  /** Resolved sender badges for the room members (name/avatar/role). */
  senders: Record<string, SenderBadge>
}

/**
 * Build the shared route handlers over one dep set. `apiBase` is the webServer
 * mount prefix (e.g. `/fleet-teams-ui`); the standalone bin passes '' and
 * serves `/api/*` bare. The api handler is wrapped with the shared
 * `withMountPrefix` helper so the dsh webServer's FULL urls arrive stripped —
 * the same handler serves standalone and mounted (family-mount).
 */
export function createTeamsUiHandlers(
  deps: TeamsUiDeps,
  pageHtml = teamsUiPageHtml(''),
  apiBase = '',
  log?: RequestLogTarget,
): TeamsUiHandlers {
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
        service: 'fleet-teams-ui',
        overlay: deps.overlay.path,
        profiles: deps.profiles.path,
        rooms: deps.teams.listRooms().length,
        teams: deps.teams.listTeams().length,
      })
    }),
    api: wrap(withMountPrefix(apiBase, (req, res) => {
      void dispatchApi(req, res, deps)
    })),
  }
}

/** Dispatch one /api/* request to the matching sub-route (pathname already prefix-stripped). */
async function dispatchApi(req: IncomingMessage, res: ServerResponse, deps: TeamsUiDeps): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  try {
    if (pathname === '/api/profiles') {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      const profiles = deps.profiles.list()
      writeJson(res, 200, { count: profiles.length, profiles })
      return
    }
    if (pathname === '/api/rooms') {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      writeJson(res, 200, roomList(deps))
      return
    }
    const roomMatch = /^\/api\/rooms\/([^/]+)(\/messages|\/post|\/settings)?$/.exec(pathname)
    if (roomMatch !== null) {
      const roomId = decodeURIComponent(roomMatch[1] ?? '')
      const sub = roomMatch[2] ?? ''
      if (sub === '') {
        if (req.method !== 'GET') return methodNotAllowed(res, req.method)
        writeJson(res, 200, roomDetail(deps, roomId))
        return
      }
      if (sub === '/messages') {
        if (req.method !== 'GET') return methodNotAllowed(res, req.method)
        const since = parsePositiveInt(new URL(req.url ?? '/', 'http://x').searchParams.get('since'))
        writeJson(res, 200, thread(deps, roomId, since))
        return
      }
      if (sub === '/post') {
        if (req.method !== 'POST') return methodNotAllowed(res, req.method)
        const body = await readJsonBody(req)
        const result = compose(deps, roomId, body)
        writeJson(res, 200, result)
        return
      }
      if (sub === '/settings') {
        if (req.method !== 'POST') return methodNotAllowed(res, req.method)
        const body = await readJsonBody(req)
        writeJson(res, 200, applySettings(deps, roomId, body))
        return
      }
    }
    writeJson(res, 404, { ok: false, error: `not found: ${req.method ?? ''} ${pathname}` })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// ---- views ----

/** The full room list: every team + its rooms with members + overlays. */
function roomList(deps: TeamsUiDeps): {
  ok: boolean
  teams: Array<{ team: FleetTeam; rooms: RoomListView[] }>
} {
  return {
    ok: true,
    teams: deps.teams.listTeams().map(team => ({
      team,
      rooms: deps.teams.listRooms(team.id).map(room => roomListRow(deps, room, team)),
    })),
  }
}

/** One room row (no memory content — the list stays lean). */
function roomListRow(deps: TeamsUiDeps, room: FleetRoom, team: FleetTeam | undefined): RoomListView {
  const memberGrants: Record<string, GrantMask> = {}
  const senders: Record<string, SenderBadge> = {}
  for (const agentId of room.memberIds) {
    memberGrants[agentId] = deps.teams.effectiveGrants(agentId, room.id)
    senders[agentId] = senderBadge(agentId, deps.profiles.get(agentId))
  }
  return { room, team, memberGrants, overlay: deps.overlay.room(room.id), senders }
}

/** Room detail for the settings dialog: memory, grants, scope, linked tasks. */
function roomDetail(
  deps: TeamsUiDeps,
  roomId: string,
): {
  ok: boolean
  room: FleetRoom
  team: FleetTeam
  memoryFile: string
  memoryContent: string
  scope: string
  memberGrants: Record<string, GrantMask>
  memberBadges: Record<string, SenderBadge>
  roomGrants: GrantMask | undefined
  teamDefaultGrants: GrantMask
  linkedTasks: string[]
  overlay: RoomOverlay
} {
  const room = deps.teams.getRoom(roomId)
  if (room === undefined) throw new Error(`fleet-teams-ui: room "${roomId}" not found`)
  const team = deps.teams.getTeam(room.teamId)
  if (team === undefined) throw new Error(`fleet-teams-ui: team "${room.teamId}" not found`)
  const briefing = deps.teams.roomBriefing(roomId)
  const memberGrants: Record<string, GrantMask> = {}
  const memberBadges: Record<string, SenderBadge> = {}
  for (const agentId of room.memberIds) {
    memberGrants[agentId] = deps.teams.effectiveGrants(agentId, room.id)
    memberBadges[agentId] = senderBadge(agentId, deps.profiles.get(agentId))
  }
  return {
    ok: true,
    room,
    team,
    memoryFile: briefing.memoryFile,
    memoryContent: briefing.content,
    scope: deps.teams.roomScope(roomId),
    memberGrants,
    memberBadges,
    roomGrants: room.grants,
    teamDefaultGrants: team.defaultGrants,
    linkedTasks: linkedTasksFromMemory(briefing.content),
    overlay: deps.overlay.room(room.id),
  }
}

/** The chat thread: the durable memory timeline + live team-post events. */
function thread(
  deps: TeamsUiDeps,
  roomId: string,
  since?: number,
): { ok: boolean; roomId: string; briefing: string; messages: ThreadMessageView[]; lastSeq: number } {
  const room = deps.teams.getRoom(roomId)
  if (room === undefined) throw new Error(`fleet-teams-ui: room "${roomId}" not found`)
  const briefing = deps.teams.roomBriefing(roomId)

  // Live tail: recent fleet/team-post events for this room from the bus store
  // (the board feed pattern — cross-process appends appear on refresh).
  const feed = new FleetBoardFeed({ storeDir: deps.storeDir })
  feed.refresh()
  const events = feed
    .read({ type: 'fleet/team-post' })
    .filter(event => (event.payload as { room?: string })?.room === roomId && event.seq > (since ?? 0))

  const byKey = new Map<string, ThreadMessageView>()
  // Timeline posts (durable, in memory-file order = oldest first).
  for (const post of briefing.recentPosts) {
    byKey.set(timelineKey(post), {
      id: post.id,
      actor: post.actor,
      sender: senderBadge(post.actor, deps.profiles.get(post.actor)),
      body: post.body,
      ts: post.ts,
      origin: 'timeline',
    })
  }
  // Live events (newest-last from the bus store; dedupe against the timeline).
  for (const event of events) {
    const payload = event.payload as { actor?: string; body?: string; ts?: number } | undefined
    if (typeof payload?.actor !== 'string' || typeof payload.body !== 'string') continue
    const key = `evt:${payload.actor}:${payload.ts ?? event.ts}:${payload.body}`
    byKey.set(key, {
      id: `event-${event.seq}`,
      actor: payload.actor,
      sender: senderBadge(payload.actor, deps.profiles.get(payload.actor)),
      body: payload.body,
      ts: payload.ts ?? event.ts,
      origin: 'event',
    })
  }
  const messages = [...byKey.values()].sort((a, b) => a.ts - b.ts)
  return {
    ok: true,
    roomId,
    briefing: briefing.content,
    messages,
    lastSeq: feed.lastSeq(),
  }
}

/** The composer: grant-checked post via the fleet-teams service. */
function compose(deps: TeamsUiDeps, roomId: string, body: Record<string, unknown> | undefined): {
  ok: boolean
  post: RoomPost
  sender: SenderBadge
} {
  const actor = requireActor(body)
  const text = requireString(body, 'body')
  const post = deps.teams.post(roomId, text, actor)
  return { ok: true, post, sender: senderBadge(actor, deps.profiles.get(actor)) }
}

/** Settings-dialog mutations: grants/membership (fleet-teams) + rename/archive (overlay). */
function applySettings(
  deps: TeamsUiDeps,
  roomId: string,
  body: Record<string, unknown> | undefined,
): {
  ok: boolean
  room: FleetRoom
  overlay: RoomOverlay
  grantsUpdated: boolean
} {
  const actor = requireActor(body)
  const room = deps.teams.getRoom(roomId)
  if (room === undefined) throw new Error(`fleet-teams-ui: room "${roomId}" not found`)

  // Grants: room-wide mask and/or per-agent overrides (the read/post/join model).
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

  // Membership: join / leave the room (grant-checked by fleet-teams).
  if (body?.join !== undefined) deps.teams.joinRoom(roomId, requireString(body, 'join'))
  if (body?.leave !== undefined) deps.teams.leaveRoom(roomId, requireString(body, 'leave'))

  // Rename / archive: the UI-layer overlay (fleet-teams has no seam; follow-up).
  if (body?.displayName !== undefined) deps.overlay.setDisplayName(roomId, requireString(body, 'displayName'))
  if (body?.archived !== undefined) deps.overlay.setArchived(roomId, body.archived === true)

  const updated = deps.teams.getRoom(roomId)!
  return { ok: true, room: updated, overlay: deps.overlay.room(roomId), grantsUpdated: body?.grants !== undefined || body?.overrides !== undefined }
}

// ---- helpers ----

/** Parse the memory file's "Task refs" section into a read-only task list. */
function linkedTasksFromMemory(content: string): string[] {
  const tasks: string[] = []
  let inRefs = false
  for (const line of content.split('\n')) {
    if (line === '## Task refs') { inRefs = true; continue }
    if (inRefs && line.startsWith('## ')) break
    if (!inRefs || line.trim().length === 0 || line.startsWith('(nothing yet)')) continue
    const taskMatch = /(?:task[\/:]([A-Za-z0-9._/-]+)|#(\d+))/g
    const refs: string[] = []
    let match: RegExpExecArray | null
    while ((match = taskMatch.exec(line)) !== null) {
      refs.push(match[1] !== undefined ? `task/${match[1]}` : `#${match[2]}`)
    }
    if (refs.length > 0) tasks.push(...refs)
  }
  return [...new Set(tasks)]
}

/** A dedupe key for a durable timeline post. */
function timelineKey(post: RoomPost): string {
  return `tl:${post.actor}:${post.ts}:${post.body}`
}

function requireActor(body: Record<string, unknown> | undefined): string {
  if (body === undefined || typeof body.actor !== 'string' || body.actor.length === 0) {
    throw new Error('fleet-teams-ui: a non-empty "actor" is required')
  }
  return body.actor
}

function requireString(body: Record<string, unknown> | undefined, key: string): string {
  if (body === undefined || typeof body[key] !== 'string' || (body[key] as string).length === 0) {
    throw new Error(`fleet-teams-ui: a non-empty "${key}" is required`)
  }
  return body[key] as string
}

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
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

/** Read + parse a small JSON request body (composer/settings posts are tiny). */
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

/** Standalone server configuration (the `fleet-teams-ui-server` bin). */
export interface FleetTeamsUiServerConfig {
  /** Listen host. Default `127.0.0.1`. */
  host?: string
  /** Listen port; 0 requests an OS-assigned port. Default 3092. */
  port?: number
  /** Override the resolved DSH_HOME (tests / non-standard $DSH_HOME). */
  home?: string
}

/**
 * Minimal node:http server serving the rooms page + API over a live
 * FleetTeamsService + the overlay + the profile registry. No dsh process
 * required — the service persists to the same durable dirs, so the page works
 * standalone (the fleet-agent admin server pattern).
 */
export class FleetTeamsUiServer {
  private readonly teams: FleetTeamsService
  private readonly handlers: TeamsUiHandlers
  private readonly server: ReturnType<typeof createServer>
  private listenedPort = 0
  private closed = false

  private readonly configHost: string
  private readonly configPort: number

  constructor(config: FleetTeamsUiServerConfig = {}) {
    const ctx = new Context()
    const storeDir = config.home === undefined ? undefined : joinStore(config.home)
    // Compose the bus + teams services on the same durable dirs (the smoke
    // harness pattern) so grant-checks + persistence work standalone.
    void new FleetBusService(ctx, { ...(storeDir !== undefined ? { storeDir } : {}), resolveAgent: () => undefined })
    this.teams = new FleetTeamsService(ctx, {
      ...(config.home !== undefined ? { home: config.home, storeDir: teamsStore(config.home) } : {}),
    })
    const deps: TeamsUiDeps = {
      teams: this.teams,
      overlay: new TeamsUiOverlay({ home: config.home }),
      profiles: new ProfileStore({ home: config.home }),
      ...(config.home !== undefined ? { storeDir } : {}),
    }
    this.configHost = config.host ?? process.env.FLEET_TEAMS_UI_HOST ?? '127.0.0.1'
    const explicit = config.port ?? Number(process.env.FLEET_TEAMS_UI_PORT ?? '3092')
    this.configPort = Number.isFinite(explicit) ? explicit : 3092
    this.handlers = createTeamsUiHandlers(deps, undefined, '', {
      svc: 'fleet-teams-ui',
      storeDir: join(config.home ?? resolveDshHome(), 'fleet'),
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

  /** The live teams service backing this server (surface for tests). */
  get service(): FleetTeamsService {
    return this.teams
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
    if (pathname === '/' || pathname === '/fleet-teams-ui' || pathname === '/fleet-teams-ui/') return this.handlers.index(req, res)
    if (pathname.startsWith('/api/')) return this.handlers.api(req, res)
    writeJson(res, 404, { ok: false, error: `not found: ${req.method ?? ''} ${pathname}` })
  }

  private onError(error: Error): void {
    if (this.closed) return
    // eslint-disable-next-line no-console
    console.error(`fleet-teams-ui-server: ${error.message}`)
  }
}

/** `<home>/fleet` — the fleet-bus store dir (matches the family default). */
function joinStore(home: string): string {
  return join(home, 'fleet')
}

/** `<home>/fleet/teams` — the fleet-teams durable dir. */
function teamsStore(home: string): string {
  return join(home, 'fleet', 'teams')
}
