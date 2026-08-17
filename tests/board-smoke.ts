/**
 * VERIFY (issue #26, P1.1): fleet-board smoke test.
 * Covers the feed reader (filter + tail correctness), the CLI output
 * (`fleet log` / `fleet status`), the standalone HTTP server (`/events`,
 * `/health`, `/` page 200), and the plugin surface (routes mounted on a dsh
 * webServer + the `fleet_feed` tool). No live LLM.
 *
 * Run: pnpm test:board  (or)  tsx tests/board-smoke.ts
 * @module @hydra/dsh-fleet/tests/board-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertPass, fakeClock } from './harness.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import { FleetBoardFeed, summarizeEvent, computeFleetBoardStatus } from '../plugins/fleet-board/src/feed.ts'
import { runLog, runStatus } from '../plugins/fleet-board/src/cli.ts'
import { FleetBoardServer } from '../plugins/fleet-board/src/server.ts'
import { apply as applyBoard, type Config as BoardConfig } from '../plugins/fleet-board/src/index.ts'

/** Publish a small deterministic event stream into a temp store. */
function seedStore(dir: string): void {
  const clock = fakeClock(1_000_000)
  const ctx = new CordisContext()
  const bus = new FleetBusService(ctx, { storeDir: dir, clock, resolveAgent: () => undefined })
  bus.publish({ type: 'task.done', scope: 'fleet', actor: 'agent-a', payload: { task: 'build', ok: true } })
  clock.advance(100)
  bus.publish({ type: 'heartbeat', scope: 'agent', actor: 'agent-a', payload: { status: 'active' }, originKind: 'heartbeat' })
  clock.advance(100)
  bus.publish({ type: 'watchdog.review', scope: 'team', actor: 'agent-b', payload: { stoppedLeaves: ['x'] }, originKind: 'watchdog' })
  clock.advance(100)
  bus.publish({ type: 'task.done', scope: 'team', actor: 'agent-b', payload: { task: 'docs', ok: true } })
}

interface CliCapture {
  lines: string[]
  ctx: { out: (line: string) => void; color: boolean }
}

function cliCapture(): CliCapture {
  const capture: CliCapture = { lines: [], ctx: { color: false, out: () => undefined } }
  capture.ctx.out = (line: string): void => { capture.lines.push(line) }
  return capture
}

async function fetchText(url: string): Promise<{ status: number; text: string; headers: Record<string, string | undefined> }> {
  const response = await fetch(url)
  const text = await response.text()
  const headers: Record<string, string | undefined> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  return { status: response.status, text, headers }
}

async function main(): Promise<void> {
  console.log('board-smoke: fleet-board feed + CLI + HTTP + plugin surface')

  // ---- 1. feed: read/filter/tail over the fleet-bus store ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-board-'))
    seedStore(dir)
    const feed = new FleetBoardFeed({ storeDir: dir })

    const all = feed.read()
    assertPass('feed reads all stored events', all.length === 4, `got ${all.length}`)
    assertPass('feed preserves seq order', all.every((e, i) => e.seq === i + 1))

    const byType = feed.read({ type: 'task.done' })
    assertPass('feed filters by type', byType.length === 2 && byType.every(e => e.type === 'task.done'))

    const byScope = feed.read({ scope: 'team' })
    assertPass('feed filters by scope', byScope.length === 2 && byScope.every(e => e.scope === 'team'))

    const byActor = feed.read({ actor: 'agent-b' })
    assertPass('feed filters by actor', byActor.length === 2 && byActor.every(e => e.actor === 'agent-b'))

    const byOrigin = feed.read({ originKind: 'watchdog' })
    assertPass('feed filters by originKind', byOrigin.length === 1 && byOrigin[0]!.type === 'watchdog.review')

    const bySince = feed.read({ since: 1_000_250 })
    assertPass('feed filters by since (ts cutoff)', bySince.length === 1 && bySince[0]!.seq === 4, JSON.stringify(bySince.map(e => e.seq)))

    const limited = feed.read({ limit: 2 })
    assertPass('feed limit keeps the most recent N', limited.length === 2 && limited[0]!.seq === 3 && limited[1]!.seq === 4)

    const tailed = feed.tail(2)
    assertPass('feed tail returns only events after the watermark',
      tailed.length === 2 && tailed.every(e => e.seq > 2), JSON.stringify(tailed.map(e => e.seq)))
    assertPass('feed lastSeq matches the store', feed.lastSeq() === 4)
  }

  // ---- 1b. refresh folds cross-process appends (tail -f correctness) ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-board-'))
    seedStore(dir)
    const feed = new FleetBoardFeed({ storeDir: dir })
    assertPass('initial snapshot has 4 events', feed.read().length === 4)

    seedStore(dir) // a second process appends 4 more events (seq 5-8)
    assertPass('before refresh the snapshot is unchanged', feed.read().length === 4)

    feed.refresh()
    assertPass('refresh folds cross-process appends', feed.read().length === 8, JSON.stringify(feed.read().map(e => e.seq)))
    assertPass('tail after refresh sees only the new events', feed.tail(4).length === 4)
  }

  // ---- 2. output-first summaries (#28) ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-board-'))
    seedStore(dir)
    const feed = new FleetBoardFeed({ storeDir: dir })
    const events = feed.read()
    const taskDone = events[0]!
    const summary = summarizeEvent(taskDone)
    assertPass('summary has an intent line', summary.intent.includes('Task') || summary.intent.includes('task.done'), summary.intent)
    assertPass('summary has payload facts (checklist)', summary.checklist.some(row => row.key === 'task'), JSON.stringify(summary.checklist))
    const heartbeat = events[1]!
    assertPass('heartbeat intent names the actor', summarizeEvent(heartbeat).intent === 'Heartbeat from agent-a')

    const status = computeFleetBoardStatus(feed.read(), { stallThresholdMs: 10 * 60 * 1000, now: 1_000_500 })
    assertPass('status lists every actor', status.agents.length === 2)
    const b = status.agents.find(a => a.actor === 'agent-b')!
    assertPass('status derives recency state', b.state === 'active', b.state)
    assertPass('status counts roll up', status.activeCount + status.quietCount + status.stalledCount === status.agents.length)
  }

  // ---- 3. CLI: `fleet log` and `fleet status` ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-board-'))
    seedStore(dir)
    const feed = new FleetBoardFeed({ storeDir: dir })

    const logCapture = cliCapture()
    runLog(feed, ['--limit', '2'], logCapture.ctx)
    assertPass('fleet log prints event lines', logCapture.lines.length === 2, JSON.stringify(logCapture.lines))
    assertPass('fleet log line carries type + actor + intent',
      logCapture.lines[1]!.includes('task.done') && logCapture.lines[1]!.includes('agent-b') && logCapture.lines[1]!.includes('—'),
      logCapture.lines[1])
    assertPass('fleet log honors --limit', logCapture.lines.length === 2)

    const jsonCapture = cliCapture()
    runLog(feed, ['--json'], jsonCapture.ctx)
    const parsed = jsonCapture.lines.map(line => JSON.parse(line) as { seq: number; type: string })
    assertPass('fleet log --json emits parseable NDJSON', parsed.length === 4 && parsed[0]!.seq === 1)

    const filterCapture = cliCapture()
    runLog(feed, ['--type', 'task.done', '--json'], filterCapture.ctx)
    const filtered = filterCapture.lines.map(line => JSON.parse(line) as { type: string })
    assertPass('fleet log --type filters', filtered.length === 2 && filtered.every(e => e.type === 'task.done'))

    const statusCapture = cliCapture()
    runStatus(feed, ['--stall-threshold-ms', '200', '--json'], statusCapture.ctx)
    const status = JSON.parse(statusCapture.lines[0]!) as { agents: unknown[]; events: number; activeCount: number }
    assertPass('fleet status --json reports store + actors',
      status.events === 4 && status.agents.length === 2, JSON.stringify(status))
  }

  // ---- 4. HTTP server: /events, /health, / (page) ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-board-'))
    seedStore(dir)
    const server = new FleetBoardServer({ port: 0, storeDir: dir })
    await server.listen()
    try {
      const base = `http://127.0.0.1:${server.port}`

      const eventsRes = await fetchText(`${base}/events?limit=3&scope=team`)
      const body = JSON.parse(eventsRes.text) as { count: number; events: Array<{ summary: { intent: string } }>; lastSeq: number }
      assertPass('GET /events → 200 with the feed', eventsRes.status === 200 && body.count === 2 && body.lastSeq === 4, eventsRes.text.slice(0, 120))
      assertPass('GET /events events carry the intent summary', typeof body.events[0]!.summary.intent === 'string')

      const healthRes = await fetchText(`${base}/health`)
      const health = JSON.parse(healthRes.text) as { ok: boolean; events: number; store: string }
      assertPass('GET /health → 200 ok', healthRes.status === 200 && health.ok === true && health.events === 4)

      const pageRes = await fetchText(base)
      assertPass('GET / → 200 serves the page', pageRes.status === 200 && pageRes.headers['content-type']?.includes('text/html') === true)
      assertPass('page is the output-first board HTML', pageRes.text.includes('fleet-board') && pageRes.text.includes('auto-refresh'))
      assertPass('page embeds the three disclosure levels', pageRes.text.includes('Context') && pageRes.text.includes('Raw'))
    } finally {
      await server.close()
    }
  }

  // ---- 5. plugin surface: webServer routes + fleet_feed tool ----
  {
    const ctx = new CordisContext()
    const registered = new Map<string, ToolDefinition>()
    ctx.reflect.provide('tools', {
      register(def: ToolDefinition): () => void {
        registered.set(def.name, def)
        return () => { registered.delete(def.name) }
      },
    } as never)

    const mountedRoutes: Array<{ kind: string; path: string }> = []
    const fakeWebServer = {
      register(route: { kind: 'exact' | 'prefix'; path: string }): () => void {
        mountedRoutes.push({ kind: route.kind, path: route.path })
        return () => { /* no-op test disposer */ }
      },
    }
    ctx.reflect.provide('webServer', fakeWebServer as never)

    const toolDir = mkdtempSync(join(tmpdir(), 'fleet-board-'))
    seedStore(toolDir)
    applyBoard(ctx, {
      storeDir: toolDir,
      injectTools: true,
    } as unknown as BoardConfig)

    assertPass('plugin mounts /fleet-board routes on the dsh webServer',
      mountedRoutes.some(r => r.path === '/fleet-board/events' && r.kind === 'exact')
      && mountedRoutes.some(r => r.path === '/fleet-board/health' && r.kind === 'exact')
      && mountedRoutes.some(r => r.path === '/fleet-board' && r.kind === 'prefix'),
      JSON.stringify(mountedRoutes))

    assertPass('plugin registers the fleet_feed tool', registered.has('fleet_feed'), JSON.stringify([...registered.keys()]))

    const feed = new FleetBoardFeed({ storeDir: toolDir })
    const tool = registered.get('fleet_feed')!
    const exec = { agent: { id: 'agent-a', session: { id: 'agent-a' } } }
    const result = await tool.execute!({ limit: 2 }, exec as never) as {
      count: number; lastSeq: number; status: { agents: number; active: number }; events: Array<{ intent: string; type: string }>
    }
    assertPass('fleet_feed returns recent events with intents', result.count === 2 && result.events.every(e => typeof e.intent === 'string'), JSON.stringify(result))
    assertPass('fleet_feed reports the fleet status rollup', result.status.agents === 2 && result.lastSeq === 4, JSON.stringify(result.status))
  }

  console.log('board-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`board-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
