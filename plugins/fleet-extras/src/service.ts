/**
 * FleetExtrasService — the `ctx.fleetExtras` Cordis service behind the
 * fleet-extras plugin (issue #26, orchestration-v3 §4 P3.3).
 *
 * The hcom borrow: workspace watch + subscribe + collision detection. Agents
 * register watch intents over EXPLICIT paths (`watch`), subscribe to
 * workspace-change events, and the service detects COLLISIONS — two different
 * actors writing the SAME file within `collisionWindowMs` (default 30 s), the
 * shared-worktree protection pattern. A collision fires `fleet/collision` with
 * the actors, the file, and the window so the fleet can reconcile before the
 * edit history diverges.
 *
 * ATTRIBUTION MODEL. Filesystem events carry no actor, so a change is
 * attributed to the actor with the most RECENT active watch on that path (the
 * presumed editor), or explicitly via `noteWrite(path, actor)` (the
 * deterministic seam tests and in-process callers use). Collision detection
 * runs on a per-path write ledger: a write to path P by actor A collides when P
 * was written by a different actor B within the window. A fired (path, pair)
 * collision is deduped for the window (no storm — the family wake-dedupe
 * semantics).
 *
 * WATCH MECHANISM (owner decision): a POLLING scanner (`scan()`), not fs.watch.
 * fs.watch is unreliable cross-platform (recursive support differs), gives no
 * actor, and floods with duplicate events; polling is deterministic, test-safe
 * and cheap for the EXPLICIT path set the plugin watches. The scanner ONLY ever
 * stats the union of registered watch paths — never the repo wholesale. No
 * background timer by default (`pollMs: 0`); a composed plugin may enable one,
 * but tests drive `scan()` directly with an injectable clock.
 *
 * Seams (all optional via `ctx.get`, the AGENTS.md optional-service rule):
 * - `fleetBus`     — event surface (`fleet/workspace-change`,
 *   `fleet/collision`). Absent → events dropped (debug log).
 * - `fleetAgent`— ed25519 signing of published events (best-effort).
 * @module @hydra/dsh-fleet-extras/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { systemClock, type FleetClock } from '../../../src/types.ts'
import type { FleetBusEvent } from '../../fleet-bus/src/types.ts'
import type { FleetSignedEvent } from '../../fleet-agent/src/service.ts'
import {
  changeToPayload,
  collisionToPayload,
  type CollisionRecord,
  type FleetExtrasSubscriptionSpec,
  type FleetExtrasWatchSpec,
  type WorkspaceChangeKind,
  type WorkspaceChangeRecord,
} from './types.ts'

/** Actor + mechanism label for every extras-produced event. */
export const EXTRAS_ACTOR = 'extras'
export const EXTRAS_ORIGIN_KIND = 'extras'
/** Bus event types this plugin owns. */
export const EXTRAS_EVENT_TYPES = {
  workspaceChange: 'fleet/workspace-change',
  collision: 'fleet/collision',
} as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetExtras: FleetExtrasService
  }

  interface Events {
    /**
     * One extras detection occurred (workspace change / collision). Emitted
     * synchronously after the optional fleet-bus publish, so in-process
     * observers get the record even when no bus is composed.
     * @param info - the detection kind + the JSON-safe record.
     * @mode emit
     */
    'fleet-extras/event'(info: { kind: 'workspace-change' | 'collision'; record: JsonValue }): void
  }
}

/** Structural fleet-bus surface (avoids importing the concrete service). */
export interface FleetBusLike {
  publish(input: {
    type: string
    scope: 'agent' | 'team' | 'fleet'
    actor: string
    originKind: string
    payload: JsonValue
    fingerprint?: string
  }): unknown
}

/** Structural fleet-agent surface for optional event signing. */
export interface FleetAgentLike {
  sign(input: { type: string; actor: string; payload: JsonValue; ts?: number }): { sig: string; pubkey: string }
}

/** Minimal live-agent delivery target for in-process subscriptions. */
export interface FleetExtrasDeliveryTarget {
  inject(message: unknown): void
  followup(message: unknown): void
}

export interface FleetExtrasConfig {
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /**
   * The collision window (ms). Two DIFFERENT actors writing the same file
   * within this window is a collision. Default 30 s (the spec).
   */
  collisionWindowMs?: number
  /**
   * Background scan cadence (ms). Default 0 = no timer; scan() is manual
   * (tests + explicit callers). A composed plugin may enable live polling.
   */
  pollMs?: number
  /** Resolve the delivery target for a subscribed agent (tests inject fakes). */
  resolveAgent?: (agentId: string) => FleetExtrasDeliveryTarget | undefined
  /** Hash file content on scan (default false — mtime+size is enough). */
  useHash?: boolean
  /** Max recent-writes kept per path (ledger bound). Default 64. */
  maxWritesPerPath?: number
}

/** The last-known on-disk state of one scanned path (change detection). */
interface FileSnapshot {
  mtimeMs: number
  size: number
  hash?: string
}

export class FleetExtrasService extends Service {
  private readonly clock: FleetClock
  /** The collision window (ms) — surfaced by the tools. */
  readonly collisionWindowMs: number
  private readonly pollMs: number
  private readonly resolveAgent: (agentId: string) => FleetExtrasDeliveryTarget | undefined
  private readonly useHash: boolean
  private readonly maxWritesPerPath: number
  /** Registered watch intents, keyed by watch id. */
  private readonly watches = new Map<string, FleetExtrasWatchSpec>()
  /** In-process workspace-change subscriptions, keyed by subscription id. */
  private readonly subscriptions = new Map<string, FleetExtrasSubscriptionSpec>()
  /** Per-path attributed write ledger (collision lookback). */
  private readonly writes = new Map<string, WorkspaceChangeRecord[]>()
  /** Recently fired collisions (bounded; newest-last). */
  private readonly collisions: CollisionRecord[] = []
  /** Dedupe: `path::actorA::actorB` -> last-fired ts (window-scoped). */
  private readonly collisionFiredAt = new Map<string, number>()
  /** Last-known on-disk snapshots (change detection). */
  private readonly snapshots = new Map<string, FileSnapshot>()
  /** Watch/subscription/collision sequence counters. */
  private watchSeq = 0
  private subscriptionSeq = 0
  private collisionSeq = 0
  /** Collision history bound (status tool + tests). */
  private static readonly MAX_COLLISIONS = 50

  constructor(ctx: Context, config: FleetExtrasConfig = {}) {
    super(ctx, 'fleetExtras')
    this.clock = config.clock ?? systemClock
    this.collisionWindowMs = config.collisionWindowMs ?? 30_000
    this.pollMs = config.pollMs ?? 0
    this.resolveAgent = config.resolveAgent ?? (() => undefined)
    this.useHash = config.useHash ?? false
    this.maxWritesPerPath = config.maxWritesPerPath ?? 64

    // Optional live polling: scan the registered watch set on a timer. Tests
    // and explicit callers use scan() directly (pollMs stays 0 by default).
    if (this.pollMs > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => this.scan(), this.pollMs)
        return () => clearInterval(timer)
      })
    }
  }

  // ---- watch intent ----

  /**
   * Register an agent's watch intent over explicit paths (files or dirs).
   * Multiple actors may watch the same path — that is the precondition for a
   * collision. The scanner never touches anything outside this set.
   * @param paths - file or directory paths to watch (absolute or cwd-relative).
   * @param actor - the agent declaring the intent.
   * @returns the watch spec (id is the unwatch key).
   */
  watch(paths: string[], actor: string): FleetExtrasWatchSpec {
    if (paths.length === 0) throw new Error('fleet-extras: watch requires at least one path')
    if (actor.length === 0) throw new Error('fleet-extras: watch requires an actor')
    const spec: FleetExtrasWatchSpec = {
      id: `extras-watch-${++this.watchSeq}`,
      actor,
      paths: [...paths],
      createdAt: this.clock.now(),
    }
    this.watches.set(spec.id, spec)
    return spec
  }

  /** Remove a watch intent. Returns true when one existed. */
  unwatch(watchId: string): boolean {
    return this.watches.delete(watchId)
  }

  /** Registered watch intents, in registration order. */
  listWatches(): readonly FleetExtrasWatchSpec[] {
    return [...this.watches.values()]
  }

  // ---- subscribe ----

  /**
   * Subscribe an agent to workspace-change events. A change matches when its
   * path contains the subscription's `pathPattern` (when given); delivery goes
   * through the configured `resolveAgent` (inject), and the Cordis
   * `fleet-extras/event` fires regardless for in-process observers.
   */
  subscribe(agentId: string, filter: { pathPattern?: string } = {}): FleetExtrasSubscriptionSpec {
    const spec: FleetExtrasSubscriptionSpec = {
      id: `extras-sub-${++this.subscriptionSeq}`,
      agentId,
      ...(filter.pathPattern !== undefined && filter.pathPattern.length > 0 ? { pathPattern: filter.pathPattern } : {}),
      createdAt: this.clock.now(),
    }
    this.subscriptions.set(spec.id, spec)
    return spec
  }

  /** Remove a subscription. Returns true when one existed. */
  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId)
  }

  /** In-process subscriptions, in registration order. */
  listSubscriptions(): readonly FleetExtrasSubscriptionSpec[] {
    return [...this.subscriptions.values()]
  }

  // ---- attribution + collision core ----

  /**
   * The deterministic attribution seam: record that `actor` wrote `path` now,
   * WITHOUT touching the filesystem. This drives the collision detector
   * exactly like a scanner-detected write, but with clean attribution — the
   * tool/scripted path (two watchers, same file) the smoke test uses.
   */
  noteWrite(path: string, actor: string, kind: WorkspaceChangeKind = 'change'): WorkspaceChangeRecord {
    return this.recordWrite(path, actor, kind, this.clock.now())
  }

  /**
   * The live seam: poll the registered watch set for on-disk changes and
   * produce attributed workspace-change records. Returns every detected change
   * (create/change/delete); each is fed through the same write ledger so
   * collisions fire identically. Attribution = the most recent watch holder
   * covering the changed path (the presumed editor).
   */
  scan(): WorkspaceChangeRecord[] {
    const rootPaths = new Set<string>()
    for (const watch of this.watches.values()) {
      for (const path of watch.paths) rootPaths.add(resolve(path))
    }
    const detected: WorkspaceChangeRecord[] = []
    const seen = new Set<string>()
    for (const root of rootPaths) {
      this.scanPath(root, detected, seen)
    }
    // Paths that were known but are no longer covered by any watched root were
    // deleted: emit a delete for any watched file that has vanished.
    for (const [path, snapshot] of this.snapshots) {
      if (!seen.has(path)) {
        if (!this.pathExists(path)) {
          this.snapshots.delete(path)
          const actor = this.attributedActor(path)
          detected.push(this.recordWrite(path, actor, 'delete', this.clock.now()))
        }
      }
    }
    return detected
  }

  // ---- collision surface ----

  /** Recently fired collisions, newest-last (bounded). */
  recentCollisions(limit = 20): readonly CollisionRecord[] {
    return this.collisions.slice(-Math.max(1, limit))
  }

  // ---- internals ----

  /** The single write path: ledger + collision check + events + delivery. */
  private recordWrite(path: string, actor: string, kind: WorkspaceChangeKind, ts: number): WorkspaceChangeRecord {
    const record: WorkspaceChangeRecord = { path, actor, kind, ts }
    this.appendWrite(path, record)

    // Collision: a prior write to the same path by a DIFFERENT actor within
    // the window. Dedupe the (path, UNORDERED pair) for the window (no storm) —
    // (a,b) and (b,a) are the SAME two actors colliding on the same file, so
    // both directions share one dedupe key while the record keeps write order.
    const prior = (this.writes.get(path) ?? []).filter(entry =>
      entry.actor !== actor && entry.actor !== EXTRAS_ACTOR && ts - entry.ts <= this.collisionWindowMs && entry.ts < ts)
    for (const other of prior) {
      const pairKey = `${path}::${[other.actor, actor].sort().join('::')}`
      const lastFired = this.collisionFiredAt.get(pairKey)
      if (lastFired !== undefined && ts - lastFired < this.collisionWindowMs) continue
      this.collisionFiredAt.set(pairKey, ts)
      this.fireCollision(path, [other.actor, actor], other.ts, ts)
    }

    this.publishEvent(EXTRAS_EVENT_TYPES.workspaceChange, changeToPayload(record) as Record<string, JsonValue>, { path })
    this.deliverToSubscriptions(record)
    this.ctx.emit('fleet-extras/event', { kind: 'workspace-change', record: changeToPayload(record) })
    return record
  }

  private appendWrite(path: string, record: WorkspaceChangeRecord): void {
    const ledger = this.writes.get(path) ?? []
    ledger.push(record)
    // Prune entries older than the window (lazy) + enforce the bound.
    const cutoff = this.clock.now() - this.collisionWindowMs
    const pruned = ledger.filter(entry => entry.ts >= cutoff)
    while (pruned.length > this.maxWritesPerPath) pruned.shift()
    this.writes.set(path, pruned)
  }

  private fireCollision(file: string, actors: [string, string], firstTs: number, secondTs: number): void {
    const record: CollisionRecord = {
      id: `extras-collision-${++this.collisionSeq}`,
      file,
      actors,
      windowMs: this.collisionWindowMs,
      firstTs,
      secondTs,
      ts: this.clock.now(),
    }
    this.collisions.push(record)
    while (this.collisions.length > FleetExtrasService.MAX_COLLISIONS) this.collisions.shift()
    const payload = collisionToPayload(record) as Record<string, JsonValue>
    this.publishEvent(EXTRAS_EVENT_TYPES.collision, payload, { path: file })
    this.ctx.emit('fleet-extras/event', { kind: 'collision', record: collisionToPayload(record) })
  }

  private deliverToSubscriptions(record: WorkspaceChangeRecord): void {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.pathPattern !== undefined && !record.path.includes(subscription.pathPattern)) continue
      const target = this.resolveAgent(subscription.agentId)
      if (target === undefined) continue
      target.inject({
        role: 'user',
        content: `[fleet-extras workspace-change] ${record.actor} ${record.kind} ${record.path}`,
      })
    }
  }

  /**
   * Attribute an on-disk change to the most recent watch holder whose paths
   * cover the changed file (the presumed editor). No watch → the mechanism
   * label (unattributed; cannot collide).
   */
  private attributedActor(path: string): string {
    let best: FleetExtrasWatchSpec | undefined
    for (const watch of this.watches.values()) {
      if (!this.covering(watch, path)) continue
      if (best === undefined || watch.createdAt > best.createdAt) best = watch
    }
    return best?.actor ?? EXTRAS_ACTOR
  }

  /** True when a watch's paths cover the given path (file match or dir prefix). */
  private covering(watch: FleetExtrasWatchSpec, path: string): boolean {
    return watch.paths.some(watchPath => {
      const root = resolve(watchPath)
      if (path === root) return true
      const prefix = root.endsWith('/') ? root : `${root}/`
      return path.startsWith(prefix)
    })
  }

  /** Scan one watched root (file or dir) into the snapshot ledger. */
  private scanPath(root: string, detected: WorkspaceChangeRecord[], seen: Set<string>): void {
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(root)
    } catch {
      return // path gone or not yet created; the delete sweep handles knowns
    }
    if (stat.isFile()) {
      this.scanFile(root, detected, seen)
      return
    }
    if (stat.isDirectory()) {
      for (const child of walkDirectory(root)) {
        this.scanFile(child, detected, seen)
      }
    }
  }

  private scanFile(path: string, detected: WorkspaceChangeRecord[], seen: Set<string>): void {
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path)
    } catch {
      return
    }
    seen.add(path)
    const previous = this.snapshots.get(path)
    const hash = this.useHash ? fileHash(path) : undefined
    const current: FileSnapshot = { mtimeMs: stat.mtimeMs, size: stat.size, ...(hash !== undefined ? { hash } : {}) }
    if (previous === undefined) {
      this.snapshots.set(path, current)
      const actor = this.attributedActor(path)
      detected.push(this.recordWrite(path, actor, 'create', this.clock.now()))
      return
    }
    if (previous.mtimeMs !== current.mtimeMs || previous.size !== current.size || previous.hash !== current.hash) {
      this.snapshots.set(path, current)
      const actor = this.attributedActor(path)
      detected.push(this.recordWrite(path, actor, 'change', this.clock.now()))
    }
  }

  private pathExists(path: string): boolean {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  }

  private publishEvent(type: string, payload: Record<string, JsonValue>, context: { path: string }): void {
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus === undefined || typeof bus.publish !== 'function') {
      this.ctx.logger.debug(`fleet-extras: no fleet-bus composed; ${type} not published`)
      return
    }
    let body: JsonValue = payload
    const identity = this.ctx.get('fleetAgent') as FleetAgentLike | undefined
    if (identity !== undefined && typeof identity.sign === 'function') {
      try {
        const signed = identity.sign({ type, actor: EXTRAS_ACTOR, payload, ts: this.clock.now() })
        body = { ...payload, signed: signed as unknown as JsonValue }
      } catch (error) {
        this.ctx.logger.debug(`fleet-extras: signing ${type} skipped — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    bus.publish({ type, scope: 'fleet', actor: EXTRAS_ACTOR, originKind: EXTRAS_ORIGIN_KIND, payload: body })
  }
}

/** Recursively walk a directory (bounded depth) returning file paths. */
function walkDirectory(root: string, depth = 0, maxDepth = 8): string[] {
  if (depth > maxDepth) return []
  const files: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return files
  }
  for (const entry of entries) {
    if (entry === '.git' || entry === 'node_modules') continue
    const full = join(root, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isFile()) files.push(full)
    else if (stat.isDirectory()) files.push(...walkDirectory(full, depth + 1, maxDepth))
  }
  return files
}

/** SHA-256 of a file's bytes (change detection when useHash is set). */
function fileHash(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}
