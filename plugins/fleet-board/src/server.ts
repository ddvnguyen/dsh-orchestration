/**
 * fleet-board HTTP surface (issue #26, orchestration-v3 §4 P1.1): the
 * `/events` feed, `/health`, and the standalone HTML page at `/`.
 *
 * Routes are built as plain `(req, res)` handlers so the SAME handlers serve
 * both dsh's plugin-accessible webServer (via
 * `ctx.webServer.register({ kind, path, handler })` — see src/index.ts and
 * the research note in orchestration/state/fleet-board-26.md) and the
 * standalone `fleet-board-server` bin (a minimal node:http server on port
 * 3090 for headless/no-dsh use). Both read the same fleet-bus store, so the
 * feed is identical on either surface.
 * @module @hydra/dsh-fleet-board/server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { withRequestLog, type RequestLogTarget } from '../../../src/request-log.ts'
import { FLEET_BOARD_PAGE_HTML } from './page.ts'
import {
  summarizeEvent,
  FleetBoardFeed,
  type FleetBoardRenderOptions,
} from './feed.ts'
import type { FleetBusEvent } from '../../fleet-bus/src/types.ts'

/** The three routes the board serves (any HTTP carrier can mount them). */
export interface FleetBoardHandlers {
  /** GET /events — the JSON feed (limit/since/type/scope/actor/originKind). */
  events(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** GET /health — liveness + store stats. */
  health(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** GET / (or /fleet-board) — the standalone HTML page. */
  index(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** Query parameters accepted by the /events route. */
export interface FleetBoardQuery {
  limit?: number
  since?: number
  type?: string
  scope?: string
  actor?: string
  originKind?: string
}

/** Parse `limit`/`since` integers defensively; other params pass through. */
export function parseFleetBoardQuery(raw: string): FleetBoardQuery {
  const query: FleetBoardQuery = {}
  for (const [key, value] of new URLSearchParams(raw)) {
    if (key === 'limit') query.limit = parsePositiveInt(value)
    else if (key === 'since') query.since = parsePositiveInt(value)
    else if (key === 'type') query.type = value
    else if (key === 'scope') query.scope = value
    else if (key === 'actor') query.actor = value
    else if (key === 'originKind') query.originKind = value
  }
  return query
}

/**
 * Build the shared route handlers over one feed. When `log` is given, every
 * request is captured in the fleet access log (`<storeDir>/logs/fleet-board.requests.jsonl`).
 */
export function createBoardHandlers(
  feed: FleetBoardFeed,
  pageHtml = FLEET_BOARD_PAGE_HTML,
  log?: RequestLogTarget,
): FleetBoardHandlers {
  const wrap = <T extends (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>(handler: T): T =>
    log === undefined ? handler : withRequestLog(log.svc, log.storeDir, handler)
  return {
    events: wrap((req, res) => {
      feed.refresh()
      const query = parseFleetBoardQuery(req.url?.split('?')[1] ?? '')
      const events = feed.read({
        type: query.type,
        scope: validScope(query.scope),
        actor: query.actor,
        originKind: query.originKind,
        since: query.since,
        limit: query.limit,
      }).map(withSummary)
      writeJson(res, 200, {
        count: events.length,
        lastSeq: feed.lastSeq(),
        events,
      })
    }),
    health: wrap((_req, res) => {
      feed.refresh()
      writeJson(res, 200, {
        ok: true,
        service: 'fleet-board',
        store: feed.path,
        events: feed.read().length,
        lastSeq: feed.lastSeq(),
      })
    }),
    index: wrap((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pageHtml)
    }),
  }
}

/** A feed event carrying the server-computed output-first summary (#28). */
export interface FleetBoardFeedEvent extends FleetBusEvent {
  /** Level 1 + level 2 render data computed server-side (shared logic). */
  readonly summary: { intent: string; checklist: { key: string; value: string }[] }
}

function withSummary(event: FleetBusEvent): FleetBoardFeedEvent {
  return { ...event, summary: summarizeEvent(event) }
}

function validScope(value: string | undefined): 'agent' | 'team' | 'fleet' | undefined {
  return value === 'agent' || value === 'team' || value === 'fleet' ? value : undefined
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

/** Standalone server configuration (the `fleet-board-server` bin). */
export interface FleetBoardServerConfig {
  /** Listen host. Default `127.0.0.1`. */
  host?: string
  /** Listen port; 0 requests an OS-assigned port. Default 3090. */
  port?: number
  /** Bus store directory override (tests / non-standard $DSH_HOME). */
  storeDir?: string
  /** Bus store file name override. */
  storeFile?: string
}

/**
 * Minimal node:http server serving the board routes. No dsh session
 * dependency — it reads the fleet-bus store directly, so it runs with or
 * without a live dsh process (the transparency requirement).
 */
export class FleetBoardServer {
  private readonly handlers: FleetBoardHandlers
  private readonly feed: FleetBoardFeed
  private readonly server: ReturnType<typeof createServer>
  private listenedPort = 0
  private closed = false

  private readonly configHost: string
  private readonly configPort: number

  constructor(config: FleetBoardServerConfig = {}, renderOptions: FleetBoardRenderOptions = {}) {
    void renderOptions
    this.configHost = config.host ?? process.env.FLEET_BOARD_HOST ?? '127.0.0.1'
    const explicit = config.port ?? Number(process.env.FLEET_BOARD_PORT ?? '3090')
    this.configPort = Number.isFinite(explicit) ? explicit : 3090
    this.feed = new FleetBoardFeed({ storeDir: config.storeDir, storeFile: config.storeFile })
    this.handlers = createBoardHandlers(this.feed, undefined, {
      svc: 'fleet-board',
      storeDir: dirname(this.feed.path),
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

  /** The resolved store path (surface for tests/status). */
  get storePath(): string {
    return this.feed.path
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
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/events') return this.handlers.events(req, res)
      if (pathname === '/health') return this.handlers.health(req, res)
      if (pathname === '/' || pathname === '/fleet-board') return this.handlers.index(req, res)
    }
    writeJson(res, 404, { ok: false, error: `not found: ${req.method ?? ''} ${pathname}` })
  }

  private onError(error: Error): void {
    if (this.closed) return
    // eslint-disable-next-line no-console
    console.error(`fleet-board-server: ${error.message}`)
  }
}
