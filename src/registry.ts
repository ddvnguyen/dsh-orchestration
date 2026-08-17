/**
 * The pure in-memory fleet registry: per-agent state, heartbeats, stall
 * detection, cross-agent messages, and wait-for-agent. Deliberately free of
 * Cordis/dsh imports so the standalone `dsh-fleet-mcp` bin can reuse it in a
 * fresh process. The Cordis service (src/service.ts) binds it to ctx.fleet,
 * drives the tick timer, and mirrors ledger events into dsh sessions.
 * @module @hydra/dsh-fleet/registry
 */

import {
  systemClock,
  type FleetAgentEntry,
  type FleetAgentKind,
  type FleetAgentMeta,
  type FleetAgentView,
  type FleetClock,
  type FleetLedgerData,
  type FleetLedgerEvent,
  type FleetMessage,
  type FleetMessageState,
  type FleetTickResult,
  type FleetWaitResult,
} from './types.ts'

export interface FleetRegistryOptions {
  /**
   * No-heartbeat interval after which an active agent flips to `stalled`.
   * Default 10 minutes (600000 ms).
   */
  stallThresholdMs?: number
  /** Timer cadence; used only for the tick timer, never for stall math. Default 30 s. */
  tickMs?: number
  /** Injectable clock; defaults to `Date.now()`. */
  clock?: FleetClock
  /** Called synchronously after each ledger append (mirror + cordis emit). */
  onEvent?: (agentId: string, event: FleetLedgerEvent) => void
}

export interface RegisterOptions {
  label?: string
  sessionId?: string
  meta?: FleetAgentMeta
  onMessage?: (message: FleetMessage) => void
}

export class FleetRegistry {
  private readonly agents = new Map<string, FleetAgentEntry>()
  private readonly ledgers = new Map<string, FleetLedgerEvent[]>()
  private readonly stallThresholdMs: number
  private readonly tickMs: number
  private readonly clock: FleetClock
  private readonly onEvent: ((agentId: string, event: FleetLedgerEvent) => void) | undefined
  private messageCounter = 0

  constructor(options: FleetRegistryOptions = {}) {
    this.stallThresholdMs = options.stallThresholdMs ?? 10 * 60 * 1000
    this.tickMs = options.tickMs ?? 30_000
    this.clock = options.clock ?? systemClock
    this.onEvent = options.onEvent
  }

  get stallThreshold(): number {
    return this.stallThresholdMs
  }

  get tickInterval(): number {
    return this.tickMs
  }

  /** True when an agent with this id exists. */
  has(id: string): boolean {
    return this.agents.has(id)
  }

  /**
   * Register an agent and open its ledger. The first heartbeat is recorded
   * immediately (lastSeen = now, status = active).
   */
  registerAgent(id: string, kind: FleetAgentKind, options: RegisterOptions = {}): FleetAgentEntry {
    if (this.agents.has(id)) throw new Error(`fleet: agent "${id}" is already registered`)
    const now = this.clock.now()
    const entry: FleetAgentEntry = {
      id,
      kind,
      label: options.label ?? id,
      lastSeen: now,
      status: 'active',
      heartbeatCount: 1,
      registeredAt: now,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.meta !== undefined ? { meta: options.meta } : {}),
      ...(options.onMessage !== undefined ? { onMessage: options.onMessage } : {}),
    }
    this.agents.set(id, entry)
    this.ledgers.set(id, [])
    this.append(entry, { kind: 'heartbeat', heartbeatCount: entry.heartbeatCount })
    return entry
  }

  /**
   * Register if absent (used by tools / MCP so a first call self-announces);
   * otherwise just heartbeats.
   */
  ensureAgent(id: string, kind: FleetAgentKind, options: RegisterOptions = {}): FleetAgentEntry {
    const existing = this.agents.get(id)
    if (existing !== undefined) {
      this.heartbeat(id)
      return existing
    }
    return this.registerAgent(id, kind, options)
  }

  /** Remove an agent and its ledger entirely. */
  unregisterAgent(id: string): void {
    this.agents.delete(id)
    this.ledgers.delete(id)
  }

  /** Keep the entry but flip to `offline` (e.g. agent/disposed); ledger stays. */
  markOffline(id: string): void {
    const entry = this.agents.get(id)
    if (entry === undefined) return
    entry.status = 'offline'
  }

  get(id: string): FleetAgentEntry | undefined {
    return this.agents.get(id)
  }

  /** Live agents in registration order. */
  list(): FleetAgentEntry[] {
    return [...this.agents.values()]
  }

  listViews(): FleetAgentView[] {
    return this.list().map(entry => toView(entry))
  }

  /** Record a heartbeat: bump lastSeen, resume a stalled agent. */
  heartbeat(id: string, note?: string): FleetAgentEntry {
    const entry = this.agents.get(id)
    if (entry === undefined) throw new Error(`fleet: unknown agent "${id}"`)
    const now = this.clock.now()
    const wasStalled = entry.status === 'stalled'
    const stalledForMs = wasStalled ? now - entry.lastSeen : 0
    entry.lastSeen = now
    entry.heartbeatCount += 1
    if (entry.status !== 'offline') entry.status = 'active'
    if (wasStalled) this.append(entry, { kind: 'resume', stalledForMs })
    this.append(entry, { kind: 'heartbeat', note, heartbeatCount: entry.heartbeatCount })
    return entry
  }

  /**
   * Stall scan, run on the tick timer. Flips `active` → `stalled` for agents
   * whose lastSeen is older than the threshold, and `stalled` → `active` for
   * agents that heartbeated back within the window (recovery without an
   * explicit resume). Resumed entries are reported for observability.
   */
  runTick(now: number = this.clock.now()): FleetTickResult {
    const stalled: string[] = []
    const resumed: string[] = []
    for (const entry of this.agents.values()) {
      if (entry.status === 'offline') continue
      const age = now - entry.lastSeen
      if (entry.status === 'active' && age > this.stallThresholdMs) {
        entry.status = 'stalled'
        stalled.push(entry.id)
        this.append(entry, { kind: 'stall', stalledMs: age })
      } else if (entry.status === 'stalled' && age <= this.stallThresholdMs) {
        entry.status = 'active'
        resumed.push(entry.id)
        this.append(entry, { kind: 'resume', stalledForMs: age })
      }
    }
    return { stalled, resumed }
  }

  /**
   * Send a message from one agent to another. Both must be registered; the
   * message is recorded in both ledgers (out on the sender, in on the
   * receiver) and delivered to the receiver's onMessage hook when present.
   */
  sendMessage(from: string, to: string, text: string): FleetMessage {
    const sender = this.agents.get(from)
    const receiver = this.agents.get(to)
    if (sender === undefined) throw new Error(`fleet: sender "${from}" is not registered`)
    if (receiver === undefined) throw new Error(`fleet: receiver "${to}" is not registered`)
    if (text.length === 0) throw new Error('fleet: message text must be non-empty')
    const messageId = `msg-${++this.messageCounter}-${this.clock.now()}`
    const message: FleetMessage = {
      messageId,
      from,
      to,
      text,
      time: this.clock.now(),
      state: 'queued',
    }
    this.append(sender, { kind: 'message', direction: 'out', from, to, text, messageId, state: 'queued' })
    this.append(receiver, { kind: 'message', direction: 'in', from, to, text, messageId, state: 'queued' })
    try {
      receiver.onMessage?.(message)
      message.state = 'delivered'
      this.append(sender, { kind: 'message', direction: 'out', from, to, text, messageId, state: 'delivered' })
      this.append(receiver, { kind: 'message', direction: 'in', from, to, text, messageId, state: 'delivered' })
    } catch (error) {
      message.state = 'rejected'
    }
    return message
  }

  /**
   * Resolve when the target agent shows progress: its lastSeen advances past
   * the baseline observed at call time, or its status leaves `stalled`.
   * Polls every `pollMs` until `timeoutMs` elapses. Progress is judged on the
   * injected clock (fleet time); the wait BUDGET is wall-clock time so a
   * frozen test clock can never hang a caller.
   */
  async waitForAgent(
    id: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<FleetWaitResult> {
    const timeoutMs = options.timeoutMs ?? 60_000
    const pollMs = options.pollMs ?? 500
    const baseline = this.agents.get(id)?.lastSeen ?? 0
    const deadline = Date.now() + timeoutMs
    // Accept an entry whose lastSeen already moved or that is no longer stalled.
    const progressed = (): boolean => {
      const entry = this.agents.get(id)
      if (entry === undefined) return true // disappeared counts as settled (caller reads the result)
      return entry.lastSeen > baseline && entry.status !== 'stalled'
    }
    while (Date.now() < deadline) {
      if (progressed()) return { ok: true, reason: 'progress', agent: viewOrUndefined(this.agents.get(id)) }
      await sleep(pollMs)
    }
    if (progressed()) return { ok: true, reason: 'progress', agent: viewOrUndefined(this.agents.get(id)) }
    return { ok: false, reason: 'timeout', agent: viewOrUndefined(this.agents.get(id)) }
  }

  /** Per-agent ledger, in seq order. */
  eventsOf(id: string): readonly FleetLedgerEvent[] {
    return this.ledgers.get(id) ?? []
  }

  /** All ledgers, keyed by agent id. */
  allEvents(): ReadonlyMap<string, readonly FleetLedgerEvent[]> {
    return this.ledgers
  }

  private append(entry: FleetAgentEntry, data: FleetLedgerData): FleetLedgerEvent {
    const ledger = this.ledgers.get(entry.id) ?? []
    const event: FleetLedgerEvent = {
      seq: ledger.length,
      time: this.clock.now(),
      kind: data.kind,
      agentId: entry.id,
      data,
    }
    ledger.push(event)
    this.onEvent?.(entry.id, event)
    return event
  }
}

function toView(entry: FleetAgentEntry): FleetAgentView {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    status: entry.status,
    lastSeen: entry.lastSeen,
    heartbeatCount: entry.heartbeatCount,
    registeredAt: entry.registeredAt,
    ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
  }
}

function viewOrUndefined(entry: FleetAgentEntry | undefined): FleetAgentView | undefined {
  return entry === undefined ? undefined : toView(entry)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
