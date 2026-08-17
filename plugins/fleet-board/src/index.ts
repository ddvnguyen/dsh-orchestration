/**
 * @hydra/dsh-fleet-board — the V3 transparency feed (issue #26,
 * orchestration-v3 §4 P1.1): "everyone knows what's going on".
 *
 * Registers the `fleet_feed` model-facing tool on the global `ctx.tools`
 * registry (the fleet-bus pattern, plugins/fleet-bus/src/index.ts) so ANY
 * agent can see what the fleet is doing, and — when a dsh webServer is
 * composed — mounts the board HTTP surface (feed JSON, health, HTML page)
 * as `/fleet-board` routes. Owner decision #2 ("all things connect to dsh"):
 * plugin-accessible HTTP routes exist on dsh's webServer via
 * `ctx.webServer.register(...)` (external/deepseek-harness/packages/host/
 * webserver/src/index.ts:94); the same handlers also serve standalone through
 * the `fleet-board-server` bin (port 3090) for headless/no-dsh use.
 *
 * ```
 * - id: fleet-board
 *   name: '@hydra/dsh-fleet-board'
 *   config:
 *     storeDir: ''      # default $DSH_HOME/fleet (same store as fleet-bus)
 * ```
 * @module @hydra/dsh-fleet-board
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { dirname } from 'node:path'
import { deriveIntent, FleetBoardFeed } from './feed.ts'
import { createBoardHandlers } from './server.ts'

export const name = 'fleet-board'
/**
 * Required deps: `webServer` is read via `ctx.get` at apply time to mount the
 * /fleet-board routes — Cordis defers apply until the service exists
 * (Lessons.md 2026-08-16: fleet-board/fleet-agent no-mount injection ordering).
 */
export const inject = ['webServer', 'tools']

/** Plugin consumer configuration. */
export interface Config {
  /** Directory holding the bus store. Default `$DSH_HOME/fleet`. */
  storeDir?: string
  /** Store file name. Default `fleet-bus.jsonl`. */
  storeFile?: string
  /** Register the fleet_feed tool on ctx.tools (default true). Host-plane compositions set false. */
  injectTools?: boolean
}

export const Config: z<Config> = z.object({
  /** Directory holding the bus store. Default `$DSH_HOME/fleet`. */
  storeDir: z.string(),
  /** Store file name. Default `fleet-bus.jsonl`. */
  storeFile: z.string(),
  /** Register the fleet_feed tool (default true). Host-plane compositions set false. */
  injectTools: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const feed = new FleetBoardFeed({ storeDir: config.storeDir, storeFile: config.storeFile })

  // Owner decision #2: serve the feed from dsh's HTTP layer when composed.
  // Optional service access (AGENTS.md: optional services use ctx.get) — the
  // webServer is only composed by the web-app bundle, never by headless.
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer !== undefined) {
    const handlers = createBoardHandlers(feed, undefined, { svc: 'fleet-board', storeDir: dirname(feed.path) })
    const disposers: Array<() => void> = [
      webServer.register({ kind: 'exact', path: '/fleet-board/events', handler: handlers.events }),
      webServer.register({ kind: 'exact', path: '/fleet-board/health', handler: handlers.health }),
      webServer.register({ kind: 'prefix', path: '/fleet-board', handler: handlers.index }),
    ]
    ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'fleet-board: webServer routes')
    ctx.logger.info('fleet-board: mounted /fleet-board on dsh webServer')
  } else {
    ctx.logger.info('fleet-board: no dsh webServer composed — serve standalone via fleet-board-server')
  }

  if (config.injectTools) {
    registerFleetFeedTool(ctx, feed)
  }
}

/** Register the `fleet_feed` tool so any agent sees the fleet feed. */
function registerFleetFeedTool(ctx: Context, feed: FleetBoardFeed): void {
  ctx.tools.register(defineTool({
    name: 'fleet_feed',
    description: 'See what the fleet is doing: the most recent fleet-bus events plus a per-agent activity summary. ' +
      'Use it before asking "what is everyone working on?" — transparency is the point.',
    parameters: {
      limit: { type: 'integer', description: 'Most recent N events to return (default 10).' },
      since: { type: 'integer', description: 'Only events with ts >= since (unix epoch ms).' },
      type: { type: 'string', description: 'Only events with exactly this type (omit for any type).' },
      scope: { type: 'string', enum: ['agent', 'team', 'fleet'], description: 'Only events with exactly this scope (omit for any scope).' },
      originKind: { type: 'string', description: 'Only events from exactly this mechanism (e.g. "watchdog", "scheduler").' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = typeof value === 'object' && value !== null ? value as { count?: number } : undefined
        return [{ type: 'text', text: `Fleet feed: ${record?.count ?? 0} events (see structuredContent)` }]
      },
    },
    async execute(args) {
      feed.refresh()
      const events = feed.read({
        type: args.type,
        scope: args.scope,
        originKind: args.originKind,
        since: args.since,
        limit: args.limit ?? 10,
      }).map(event => ({
        id: event.id, type: event.type, scope: event.scope, actor: event.actor,
        originKind: event.originKind, ts: event.ts, seq: event.seq,
        intent: deriveIntent(event),
        payload: event.payload,
      }))
      const status = feed.status()
      return {
        count: events.length,
        lastSeq: feed.lastSeq(),
        status: {
          agents: status.agents.length,
          active: status.activeCount,
          stalled: status.stalledCount,
        },
        events,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Fleet feed', kind: 'other', rawInput: args }),
  }))
}

/** Re-export the feed surface for plugin consumers. */
export type { FleetBoardFeed } from './feed.ts'
