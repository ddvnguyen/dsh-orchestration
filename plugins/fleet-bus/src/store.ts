/**
 * The durable fleet-bus event store: an append-only JSONL file under the
 * dsh home (`$DSH_HOME/fleet/fleet-bus.jsonl` by default). The in-memory log
 * is the read surface; every append is flushed synchronously to disk, so the
 * store survives restarts and replays exactly the persisted event stream.
 *
 * STORE CHOICE (why not session-query / dsh SQLite persistence): fleet-bus
 * event types are out-of-repo and therefore absent from the dsh persistence
 * catalog — `KNOWN_SESSION_EVENT_TYPES`
 * (external/deepseek-harness/packages/core/session/src/known-event-types.ts:20-29)
 * has no registration surface for plugin events, and a durable persistence
 * backend refuses to re-read a log containing unrecognized types
 * (packages/core/session/src/types.ts:415-423). Routing fleet-bus events
 * through the session ledger would make durable replay impossible today. A
 * plain append-only JSONL store has no such dependency, is trivially
 * verifiable, and mirrors the family's decision to keep the prototype's own
 * durable state out of dsh's session-log contract (see src/types.ts in
 * experiments/dsh-fleet and dsh-fleet-20.md §Open questions #2).
 *
 * Tradeoff: appends are synchronous filesystem I/O (acceptable at prototype
 * event volumes; keeps publish/delivery synchronous like FleetRegistry).
 * @module @hydra/dsh-fleet-bus/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { FleetBusEvent } from './types.ts'

export interface FleetEventStoreConfig {
  /** Directory holding the bus log. Default `$DSH_HOME/fleet`. */
  dir?: string
  /** Log file name. Default `fleet-bus.jsonl`. */
  file?: string
}

/** One line per event; read into memory on construction. */
export class FleetEventStore {
  /** Absolute path of the log file. */
  readonly path: string
  private readonly events: FleetBusEvent[] = []

  constructor(config: FleetEventStoreConfig = {}) {
    const dir = config.dir ?? join(resolveDshHome(), 'fleet')
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, config.file ?? 'fleet-bus.jsonl')
    this.load()
  }

  /** All stored events in seq order (the replay surface). */
  list(): readonly FleetBusEvent[] {
    return this.events
  }

  /** Append one event to memory and durably to disk. */
  append(event: FleetBusEvent): void {
    this.events.push(event)
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8')
  }

  private load(): void {
    if (!existsSync(this.path)) return
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(line => line.length > 0)
    for (let i = 0; i < lines.length; i++) {
      try {
        this.events.push(JSON.parse(lines[i] as string) as FleetBusEvent)
      } catch {
        // Tolerate a truncated FINAL line (crash mid-append); any earlier
        // malformed line is store corruption and must fail loud.
        if (i !== lines.length - 1) {
          throw new Error(`fleet-bus: corrupt store line ${i + 1} in ${this.path}`)
        }
      }
    }
  }
}
