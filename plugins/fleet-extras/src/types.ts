/**
 * fleet-extras vocabulary (issue #26, orchestration-v3 §4 P3.3).
 *
 * The hcom borrow: workspace watch + subscribe + collision detection. Agents
 * register workspace watch intents over explicit paths (`watch`), subscribe to
 * workspace-change events, and the service detects COLLISIONS — two DIFFERENT
 * actors writing the SAME file within a `collisionWindowMs` window (default
 * 30 s) — the shared-worktree protection pattern: concurrent edits to one file
 * are a code-loss risk and must surface as a `fleet/collision` event naming
 * the actors, the file, and the window.
 *
 * Attribution: filesystem events carry no actor, so a change is attributed to
 * the actor with the most recent ACTIVE watch on that path (the presumed
 * editor), or explicitly via `noteWrite(path, actor)`. Collision detection runs
 * on the per-path write ledger: a write to path P by actor A collides when P
 * was written by a different actor B within the window.
 * @module @hydra/dsh-fleet-extras/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** What kind of on-disk change a workspace-change record describes. */
export type WorkspaceChangeKind = 'create' | 'change' | 'delete'

/** One agent's registered watch intent over a set of paths (files or dirs). */
export interface FleetExtrasWatchSpec {
  /** Watch identity (the unwatch key). */
  readonly id: string
  /** The agent that declared the intent. */
  readonly actor: string
  /** Explicitly-registered paths. The scanner NEVER touches anything else. */
  readonly paths: readonly string[]
  /** Unix epoch ms (service clock) the watch was registered. */
  readonly createdAt: number
}

/** An in-process workspace-change subscription. */
export interface FleetExtrasSubscriptionSpec {
  readonly id: string
  /** Receiving agent id (resolved for delivery via the configured resolver). */
  readonly agentId: string
  /** Optional substring filter on the changed path. */
  readonly pathPattern?: string
  readonly createdAt: number
}

/** One attributed workspace change (the write-ledger entry + event body). */
export interface WorkspaceChangeRecord {
  /** Repository-relative or absolute path that changed. */
  readonly path: string
  /** The presumed writing actor. */
  readonly actor: string
  readonly kind: WorkspaceChangeKind
  /** Unix epoch ms (service clock). */
  readonly ts: number
  /** Optional SHA-256 of the file content (config `useHash`). */
  readonly hash?: string
}

/** One detected collision: two actors wrote the same file within the window. */
export interface CollisionRecord {
  readonly id: string
  /** The shared file path. */
  readonly file: string
  /** First writer, then the colliding (second) writer. */
  readonly actors: readonly [string, string]
  /** The collision window (ms) that was applied. */
  readonly windowMs: number
  /** Unix epoch ms of the first write. */
  readonly firstTs: number
  /** Unix epoch ms of the colliding write. */
  readonly secondTs: number
  /** Unix epoch ms the collision was fired. */
  readonly ts: number
}

/** JSON-safe payload of the `fleet/collision` bus event. */
export interface CollisionPayload {
  file: string
  actors: [string, string]
  windowMs: number
  firstTs: number
  secondTs: number
  id: string
}

/** JSON-safe payload of the `fleet/workspace-change` bus event. */
export interface WorkspaceChangePayload {
  path: string
  actor: string
  kind: WorkspaceChangeKind
  ts: number
  hash?: string
}

/** Narrow a write to the JSON view the status tool exposes. */
export function collisionToPayload(record: CollisionRecord): JsonValue {
  const payload: CollisionPayload = {
    file: record.file,
    actors: [record.actors[0], record.actors[1]],
    windowMs: record.windowMs,
    firstTs: record.firstTs,
    secondTs: record.secondTs,
    id: record.id,
  }
  return payload as unknown as JsonValue
}

/** Narrow a change to the JSON view published / delivered. */
export function changeToPayload(record: WorkspaceChangeRecord): JsonValue {
  const payload: WorkspaceChangePayload = {
    path: record.path,
    actor: record.actor,
    kind: record.kind,
    ts: record.ts,
  }
  if (record.hash !== undefined) payload.hash = record.hash
  return payload as unknown as JsonValue
}
