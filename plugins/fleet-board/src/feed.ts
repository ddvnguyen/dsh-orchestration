/**
 * fleet-board feed: the read/tail surface over the fleet-bus event store
 * (issue #26, orchestration-v3 §4 P1.1).
 *
 * PURE module — no Cordis imports. It wraps the fleet-bus
 * {@link FleetEventStore} (append-only JSONL under `$DSH_HOME/fleet`,
 * `plugins/fleet-bus/src/store.ts`) and provides everything a feed needs:
 * filtering (type/scope/actor/originKind/since), incremental tailing from a
 * seq watermark, output-first rendering (#28: human intent first, then
 * context, then raw JSON), and a fleet-status summary derived from events.
 *
 * The same module powers the CLI (`fleet log` / `fleet status`), the
 * standalone HTTP server (GET /events, /health, /), and the plugin's
 * `fleet_feed` model-facing tool — so every surface reads the same durable
 * bus and shows the same view.
 * @module @hydra/dsh-fleet-board/feed
 */

import { existsSync, readFileSync } from 'node:fs'
import { FleetEventStore } from '../../fleet-bus/src/store.ts'
import type { FleetBusEvent, FleetBusScope } from '../../fleet-bus/src/types.ts'

/** A feed query: every field is optional; omitted = match any value. */
export interface FleetBoardFilter {
  /** Only events with exactly this type. */
  type?: string
  /** Only events with exactly this scope. */
  scope?: FleetBusScope
  /** Only events produced by exactly this actor. */
  actor?: string
  /** Only events produced by exactly this mechanism. */
  originKind?: string
  /** Only events with `ts >= since` (unix epoch ms). */
  since?: number
  /** Only the most recent N matching events (applied last, in seq order). */
  limit?: number
}

/** One rendered summary of an event for the output-first view (#28). */
export interface FleetBoardEventSummary {
  /** Level 1: one human-readable intent line. */
  intent: string
  /** Level 2: the payload rendered as a flat key/value fact list. */
  checklist: FleetBoardChecklistRow[]
}

/** One payload fact shown at the second disclosure level. */
export interface FleetBoardChecklistRow {
  key: string
  value: string
}

/** The liveness state derived from event recency per actor. */
export type FleetBoardActorState = 'active' | 'quiet' | 'stalled'

/** Per-actor status derived from the event stream (no registry needed). */
export interface FleetBoardActorStatus {
  /** The actor (agent id or `system`). */
  readonly actor: string
  /** The most recent event timestamp for this actor. */
  readonly lastSeen: number
  /** The type of the actor's most recent event. */
  readonly lastType: string
  /** How many events this actor produced. */
  readonly eventCount: number
  /** Derived from recency vs the stall threshold. */
  readonly state: FleetBoardActorState
}

/** The `fleet status` summary, derived purely from stored events. */
export interface FleetBoardStatus {
  /** Store generation time (unix epoch ms). */
  readonly generatedAt: number
  /** The recency threshold separating active/quiet/stalled. */
  readonly stallThresholdMs: number
  /** Total stored events. */
  readonly events: number
  /** The latest stored seq (0 when the store is empty). */
  readonly lastSeq: number
  /** Per-actor rollup, most recently active first. */
  readonly agents: FleetBoardActorStatus[]
  readonly activeCount: number
  readonly quietCount: number
  readonly stalledCount: number
}

/** Whether text rendering should carry ANSI color. */
export interface FleetBoardRenderOptions {
  /** Apply ANSI color when true (plain when false). Default false. */
  color?: boolean
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const

/** Read + tail surface over the fleet-bus store. */
export class FleetBoardFeed {
  /** The underlying fleet-bus store (append-only JSONL). */
  readonly store: FleetEventStore
  /** This process's event view; refreshed from the file via {@link refresh}. */
  private events: FleetBusEvent[]

  constructor(config: { storeDir?: string; storeFile?: string } = {}) {
    this.store = new FleetEventStore({ dir: config.storeDir, file: config.storeFile })
    this.events = [...this.store.list()]
  }

  /** Absolute path of the bus log. */
  get path(): string {
    return this.store.path
  }

  /**
   * Re-read the append-only store file and fold in any events not yet seen
   * (seq-based merge, so cross-process appends appear). Cheap at prototype
   * volumes; call it before any read that must be live (`--follow`, every
   * HTTP request, `fleet_feed`).
   */
  refresh(): void {
    try {
      if (!existsSync(this.store.path)) {
        this.events = []
        return
      }
      const lines = readFileSync(this.store.path, 'utf8').split('\n').filter(line => line.length > 0)
      const parsed: FleetBusEvent[] = []
      for (let i = 0; i < lines.length; i++) {
        try {
          parsed.push(JSON.parse(lines[i] as string) as FleetBusEvent)
        } catch {
          // Same tolerance as the fleet-bus store (src/store.ts:61-75): a
          // truncated FINAL line (crash mid-append) is tolerated; any earlier
          // malformed line is store corruption and must fail loud.
          if (i !== lines.length - 1) {
            throw new Error(`fleet-board: corrupt store line ${i + 1} in ${this.store.path}`)
          }
        }
      }
      const maxSeq = this.events.at(-1)?.seq ?? 0
      const fresh = parsed.filter(event => event.seq > maxSeq)
      if (fresh.length > 0) this.events = [...this.events, ...fresh]
    } catch {
      // Keep the current in-memory view on a transient read error (e.g. a
      // concurrent writer mid-append); the next refresh retries.
    }
  }

  /** All stored events matching a filter, in seq order. */
  read(filter: FleetBoardFilter = {}): FleetBusEvent[] {
    return filterFleetBoardEvents(this.events, filter)
  }

  /** The latest seq this process has seen (0 when the store is empty). */
  lastSeq(): number {
    return this.events.at(-1)?.seq ?? 0
  }

  /**
   * Incremental read for tail-following: every event with `seq > afterSeq`.
   * @param afterSeq - the last already-seen seq; the store is append-only, so a
   *   seq watermark is exact (unlike a ts watermark, which can collide).
   */
  tail(afterSeq: number): FleetBusEvent[] {
    return this.events.filter(event => event.seq > afterSeq)
  }

  /** Derive the fleet status summary from stored events alone. */
  status(stallThresholdMs = 10 * 60 * 1000, now = Date.now()): FleetBoardStatus {
    return computeFleetBoardStatus(this.events, { stallThresholdMs, now })
  }
}

/** Pure filter over an event list (shared by read and replay-style queries). */
export function filterFleetBoardEvents(events: readonly FleetBusEvent[], filter: FleetBoardFilter): FleetBusEvent[] {
  let result = events.filter(event => {
    if (filter.type !== undefined && event.type !== filter.type) return false
    if (filter.scope !== undefined && event.scope !== filter.scope) return false
    if (filter.actor !== undefined && event.actor !== filter.actor) return false
    if (filter.originKind !== undefined && event.originKind !== filter.originKind) return false
    if (filter.since !== undefined && event.ts < filter.since) return false
    return true
  })
  if (filter.limit !== undefined && filter.limit > 0 && result.length > filter.limit) {
    result = result.slice(result.length - filter.limit)
  }
  return result
}

/** Output-first summary of one event (#28): intent first, facts second. */
export function summarizeEvent(event: FleetBusEvent): FleetBoardEventSummary {
  return {
    intent: deriveIntent(event),
    checklist: payloadChecklist(event.payload),
  }
}

/** Level 1 intent line — the human-readable one-liner for the event. */
export function deriveIntent(event: FleetBusEvent): string {
  const payload = asRecord(event.payload)
  const message = payload?.message
  if (typeof message === 'string' && message.length > 0) return message

  const type = event.type
  const lower = type.toLowerCase()
  if (lower.includes('heartbeat')) return `Heartbeat from ${event.actor}`
  if (lower.includes('stall')) return `${event.actor} stalled`
  if (lower.includes('resume')) return `${event.actor} resumed`
  const task = payload?.task
  if (lower.includes('task') && typeof task === 'string' && task.length > 0) return `Task ${task}`
  const status = payload?.status
  if (typeof status === 'string' && status.length > 0) return `${type}: ${status}`
  return `${type} by ${event.actor}`
}

/** Level 2 context facts: the payload flattened into key/value rows. */
export function payloadChecklist(payload: FleetBusEvent['payload']): FleetBoardChecklistRow[] {
  const record = asRecord(payload)
  if (record === undefined) {
    return [{ key: 'payload', value: jsonOrString(payload) }]
  }
  const entries = Object.entries(record)
  if (entries.length === 0) return []
  return entries.map(([key, value]) => ({ key, value: truncate(jsonOrString(value), 140) }))
}

/** Render one event as a single colored-ish text line for the CLI. */
export function renderEventText(event: FleetBusEvent, options: FleetBoardRenderOptions = {}): string {
  const c = options.color === true ? ANSI : noColorAnsi
  const time = formatTs(event.ts)
  const summary = summarizeEvent(event)
  const origin = event.originKind !== 'agent' ? ` ${c.magenta}(${event.originKind})${c.reset}` : ''
  return `${c.gray}${time}${c.reset} ${c.cyan}${event.type}${c.reset} ${c.blue}[${event.scope}]${c.reset} ${c.yellow}${event.actor}${c.reset}${origin} — ${summary.intent}`
}

/** Render the fleet status summary as text for the CLI. */
export function renderStatusText(status: FleetBoardStatus, options: FleetBoardRenderOptions = {}): string {
  const c = options.color === true ? ANSI : noColorAnsi
  const lines: string[] = []
  lines.push(`fleet status — ${status.events} events (seq ${status.lastSeq}), generated ${formatTs(status.generatedAt)}`)
  lines.push(`agents: ${status.agents.length} total — ${c.green}${status.activeCount} active${c.reset} / ${c.yellow}${status.quietCount} quiet${c.reset} / ${c.red}${status.stalledCount} stalled${c.reset} (stall threshold ${Math.round(status.stallThresholdMs / 1000)}s)`)
  for (const agent of status.agents) {
    lines.push(
      `  ${stateDot(agent.state, c)} ${c.yellow}${agent.actor}${c.reset} — ${c.gray}last ${formatTs(agent.lastSeen)} (${agent.lastType}, ${agent.eventCount} events)${c.reset}`,
    )
  }
  return lines.join('\n')
}

/** Derive the per-actor status summary from the stored event stream. */
export function computeFleetBoardStatus(
  events: readonly FleetBusEvent[],
  options: { stallThresholdMs?: number; now?: number } = {},
): FleetBoardStatus {
  const stallThresholdMs = options.stallThresholdMs ?? 10 * 60 * 1000
  const now = options.now ?? Date.now()
  const byActor = new Map<string, FleetBoardActorStatus>()
  for (const event of events) {
    const current = byActor.get(event.actor)
    if (current === undefined || event.ts > current.lastSeen) {
      byActor.set(event.actor, {
        actor: event.actor,
        lastSeen: event.ts,
        lastType: event.type,
        eventCount: (current?.eventCount ?? 0) + 1,
        state: deriveActorState(event.ts, now, stallThresholdMs),
      })
    } else {
      byActor.set(event.actor, { ...current, eventCount: current.eventCount + 1 })
    }
  }
  const agents = [...byActor.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  const counts = { active: 0, quiet: 0, stalled: 0 }
  for (const agent of agents) counts[agent.state] += 1
  return {
    generatedAt: now,
    stallThresholdMs,
    events: events.length,
    lastSeq: events.at(-1)?.seq ?? 0,
    agents,
    activeCount: counts.active,
    quietCount: counts.quiet,
    stalledCount: counts.stalled,
  }
}

function deriveActorState(lastSeen: number, now: number, stallThresholdMs: number): FleetBoardActorState {
  const age = now - lastSeen
  if (age <= stallThresholdMs) return 'active'
  if (age <= stallThresholdMs * 2) return 'quiet'
  return 'stalled'
}

function stateDot(state: FleetBoardActorState, c: Record<keyof typeof ANSI, string>): string {
  if (state === 'active') return `${c.green}●${c.reset}`
  if (state === 'quiet') return `${c.yellow}◐${c.reset}`
  return `${c.red}○${c.reset}`
}

function asRecord(payload: FleetBusEvent['payload']): Record<string, unknown> | undefined {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined
}

function jsonOrString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Compact local clock time for feed lines: `HH:MM:SS`. */
export function formatTs(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19)
}

/** Identity ANSI palette so `color:false` renders plain without branching. */
const noColorAnsi: Record<keyof typeof ANSI, string> = {
  reset: '',
  dim: '',
  gray: '',
  red: '',
  green: '',
  yellow: '',
  blue: '',
  magenta: '',
  cyan: '',
}
