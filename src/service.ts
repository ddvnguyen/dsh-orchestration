/**
 * FleetService — the `ctx.fleet` Cordis service behind the fleet plugin family.
 *
 * Wraps the pure {@link FleetRegistry}, drives the tick timer (default 30 s,
 * configurable), emits a `fleet/event` Cordis event per ledger record, and —
 * when `ctx.sessions` is composed — mirrors fleet records into the owning
 * agent's session log (see src/session-ledger.ts).
 *
 * Registration pattern follows dsh service plugins (e.g.
 * `@deepseek-ai/dsh-session-title`): `Service` base class + `super(ctx, key)`
 * registers the ctx key (`vendor/cordis/src/service.ts`), and teardown is a
 * `ctx.effect` (timer + any binding).
 * @module @hydra/dsh-fleet/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { FleetRegistry } from './registry.ts'
import { mirrorFleetEventToSession } from './session-ledger.ts'
import type { FleetClock } from './types.ts'
import type { FleetAgentEntry, FleetAgentView, FleetLedgerEvent, FleetMessage, FleetWaitResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleet: FleetService
  }

  interface Events {
    /**
     * One fleet ledger record was appended (heartbeat / stall / resume /
     * message). Observers use it for UIs, alerts, or policies. Emitted
     * synchronously after the ledger append.
     * @param agentId - the owning agent.
     * @param event - the appended ledger record.
     * @mode emit
     */
    'fleet/event'(agentId: string, event: FleetLedgerEvent): void
  }
}

export interface FleetServiceConfig {
  /** No-heartbeat interval before an agent is flagged `stalled`. Default 10 min. */
  stallThresholdMs?: number
  /** Tick timer cadence. Default 30 s. */
  tickMs?: number
  /** Injectable clock for deterministic tests (defaults to Date.now()). */
  clock?: FleetClock
}

/**
 * The structural interface fleet-mcp and fleet-inject consume, so they never
 * import the concrete service (keeps the family decoupled, like dsh seams).
 */
export interface FleetLike {
  list(): FleetAgentEntry[]
  listViews(): FleetAgentView[]
  getStatus(id: string): FleetAgentView | undefined
  sendMessage(from: string, to: string, text: string): FleetMessage
  waitForAgent(id: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<FleetWaitResult>
  ensureAgent(
    id: string,
    kind: FleetAgentEntry['kind'],
    options?: { label?: string; sessionId?: string; onMessage?: (message: FleetMessage) => void },
  ): FleetAgentEntry
  heartbeat(id: string, note?: string): FleetAgentEntry
  markOffline(id: string): void
  runTick(now?: number): { stalled: string[]; resumed: string[] }
}

export class FleetService extends Service implements FleetLike {
  readonly registry: FleetRegistry

  constructor(ctx: Context, config: FleetServiceConfig = {}) {
    super(ctx, 'fleet')
    this.registry = new FleetRegistry({
      stallThresholdMs: config.stallThresholdMs,
      tickMs: config.tickMs,
      clock: config.clock,
      onEvent: (agentId, event) => {
        ctx.emit('fleet/event', agentId, event)
        this.mirrorToSession(agentId, event)
      },
    })

    // The tick timer. `timer.unref()` so an idle process can exit; the effect
    // cleanup clears it on plugin unload (mirrors client/hmr/src/index.ts).
    ctx.effect(() => {
      const timer = setInterval(() => {
        const result = this.registry.runTick()
        for (const id of result.stalled) ctx.logger.warn(`fleet: agent "${id}" stalled`)
      }, this.registry.tickInterval)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'fleet-heartbeat: tick timer')

    // Optional binding: mirror fleet records into real dsh session logs only
    // when a session store is composed (headless assemblies without one are
    // unaffected) — the same optional-child pattern session-title uses for
    // sessionProjections.
    ctx.inject(['sessions'], (sessionsCtx) => {
      this.bindSessions(sessionsCtx.sessions)
    })
  }

  /** Late-bound session store used for the ledger mirror. */
  private bindSessions(sessions: SessionStore): void {
    this.registry.list().forEach((entry) => {
      this.trackSessionBinding(entry)
    })
  }

  private trackSessionBinding(entry: FleetAgentEntry): void {
    if (entry.sessionId === undefined) return
    const sessions = this.ctx.sessions
    if (sessions === undefined) return
    const session = sessions.get(entry.sessionId as never)
    // First mirror flush: register the entry's ledger history into the log so
    // the session reflects fleet records even for agents that predated the
    // session store binding.
    if (session !== undefined) {
      for (const event of this.registry.eventsOf(entry.id)) mirrorFleetEventToSession(session, event)
    }
  }

  private mirrorToSession(agentId: string, event: FleetLedgerEvent): void {
    const entry = this.registry.get(agentId)
    if (entry?.sessionId === undefined) return
    const sessions = this.ctx.sessions
    if (sessions === undefined) return
    const session = sessions.get(entry.sessionId as never)
    if (session !== undefined) mirrorFleetEventToSession(session, event)
  }

  // ---- FleetLike surface (delegates to the registry) ----

  list(): FleetAgentEntry[] { return this.registry.list() }
  listViews(): FleetAgentView[] { return this.registry.listViews() }
  getStatus(id: string): FleetAgentView | undefined { return this.registry.listViews().find(view => view.id === id) }
  sendMessage(from: string, to: string, text: string): FleetMessage { return this.registry.sendMessage(from, to, text) }
  waitForAgent(id: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<FleetWaitResult> {
    return this.registry.waitForAgent(id, options)
  }
  ensureAgent(id: string, kind: FleetAgentEntry['kind'], options?: { label?: string; sessionId?: string; onMessage?: (message: FleetMessage) => void }): FleetAgentEntry {
    const entry = this.registry.ensureAgent(id, kind, options)
    if (entry.sessionId !== undefined) this.trackSessionBinding(entry)
    return entry
  }
  heartbeat(id: string, note?: string): FleetAgentEntry { return this.registry.heartbeat(id, note) }
  markOffline(id: string): void { this.registry.markOffline(id) }
  runTick(now?: number): { stalled: string[]; resumed: string[] } { return this.registry.runTick(now) }

  // ---- extended registry surface (beyond the FleetLike minimum) ----

  registerAgent(id: string, kind: FleetAgentEntry['kind'], options?: { label?: string; sessionId?: string; meta?: import('./types.ts').FleetAgentMeta; onMessage?: (message: FleetMessage) => void }): FleetAgentEntry {
    const entry = this.registry.registerAgent(id, kind, options)
    if (entry.sessionId !== undefined) this.trackSessionBinding(entry)
    return entry
  }

  unregisterAgent(id: string): void { this.registry.unregisterAgent(id) }

  eventsOf(id: string): readonly FleetLedgerEvent[] { return this.registry.eventsOf(id) }
}
