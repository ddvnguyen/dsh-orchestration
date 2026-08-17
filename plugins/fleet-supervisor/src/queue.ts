/**
 * The durable wake queue store: one JSONL file per entry, rewritten atomically
 * on every mutation (tmp + rename, the same atomic pattern fleet-agent's
 * profile store uses — plugins/fleet-agent/src/service.ts:269-277).
 *
 * STORE CHOICE (why not dsh SQLite / session-query): the wake queue needs
 * DUE-STATE UPDATES (pending → woken → completed, re-due on orphan/takeover,
 * budget retryAt), so an append-only log is not enough. dsh's SQLite replay
 * machinery (session-query) is gated on the session-event catalog exactly like
 * fleet-bus documented
 * (orchestration/state/fleet-bus-26.md §Design decisions; the family decided a
 * plain file store for the same reason). A single JSONL file with atomic
 * rewrite is the simplest correct store at prototype volumes (a handful to a
 * few dozen entries; a rewrite is < 100 KB of fsync'd writes), is trivially
 * verifiable, and matches the family's "keep prototype durable state out of
 * dsh's session-log contract" decision (experiments/dsh-fleet/src/types.ts).
 * SQLite is deferred until volumes require it — documented as an open question.
 *
 * Durability caveat: a crash mid-mutation can only lose the single in-flight
 * write (the previous file remains readable until rename); a truncated final
 * line on load is tolerated the same way fleet-bus tolerates it
 * (plugins/fleet-bus/src/store.ts:61-75).
 * @module @hydra/dsh-fleet-supervisor/queue
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WakeEntry } from './types.ts'

export interface WakeQueueStoreConfig {
  /** Directory holding the queue file. Default `$DSH_HOME/fleet`. */
  dir?: string
  /** Queue file name. Default `fleet-wake-queue.jsonl`. */
  file?: string
}

/** One line per entry; mutations rewrite the whole file atomically. */
export class WakeQueueStore {
  /** Absolute path of the queue file. */
  readonly path: string
  private readonly entries = new Map<string, WakeEntry>()

  constructor(config: WakeQueueStoreConfig = {}) {
    const dir = config.dir ?? join(resolveDshHome(), 'fleet')
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, config.file ?? 'fleet-wake-queue.jsonl')
    this.load()
  }

  /** All entries, in enqueue order. */
  list(): WakeEntry[] {
    return [...this.entries.values()]
  }

  /** One entry by id. */
  get(id: string): WakeEntry | undefined {
    return this.entries.get(id)
  }

  /** Insert or replace one entry (by id) and persist. */
  upsert(entry: WakeEntry): void {
    this.entries.set(entry.id, entry)
    this.persist()
  }

  /** Remove one entry and persist. */
  remove(id: string): void {
    if (this.entries.delete(id)) this.persist()
  }

  /**
   * Rewrite the whole file atomically (tmp + rename). Synchronous so every
   * mutation is durably ordered, like the family's FleetEventStore appends.
   */
  persist(): void {
    const body = [...this.entries.values()].map(entry => `${JSON.stringify(entry)}\n`).join('')
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, this.path)
  }

  private load(): void {
    if (!existsSync(this.path)) return
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(line => line.length > 0)
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i] as string) as WakeEntry
        this.entries.set(entry.id, entry)
      } catch {
        // Tolerate a truncated FINAL line (crash mid-append); any earlier
        // malformed line is store corruption and must fail loud.
        if (i !== lines.length - 1) {
          throw new Error(`fleet-supervisor: corrupt wake queue line ${i + 1} in ${this.path}`)
        }
      }
    }
  }
}
