/**
 * The durable fleet-schedule store: the in-memory registry's disk mirror at
 * `$DSH_HOME/fleet/schedules.json`.
 *
 * STORE CHOICE (vs fleet-tasks' SQLite): schedule state is a small document
 * collection (per-schedule records with nested runs) with whole-record update
 * semantics and no cross-record atomicity requirement — a single JSON file is
 * the right fit, mirroring the fleet-agent profiles store
 * (plugins/fleet-agent/src/service.ts `persistProfiles`). Writes are ATOMIC:
 * serialize to `<file>.tmp` then `renameSync` over the target, so a crash can
 * never leave a truncated schedules.json (POSIX rename is atomic on the same
 * filesystem).
 *
 * Deliberately free of Cordis imports — pure, like the family's FleetRegistry
 * (src/registry.ts) and FleetTaskStore (plugins/fleet-tasks/src/store.ts).
 * @module @hydra/dsh-fleet/schedule-store
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ScheduleRecord } from './types.ts'

export interface ScheduleStoreConfig {
  /** Directory holding schedules.json. Default `$DSH_HOME/fleet`. */
  dir?: string
  /** Store file name. Default `schedules.json`. */
  file?: string
}

/** Store file mode: schedule prompts are agent-owned data, owner-writable. */
const STORE_MODE = 0o600

/**
 * The durable schedule store (no Cordis imports). Loads the whole collection
 * on construction; every mutation persists through {@link save} (atomic
 * tmp+rename write of the full record list).
 */
export class ScheduleStore {
  /** Absolute path of the schedules file. */
  readonly path: string

  constructor(config: ScheduleStoreConfig = {}) {
    const dir = config.dir ?? join(resolveDshHome(), 'fleet')
    this.path = join(dir, config.file ?? 'schedules.json')
  }

  /**
   * Read the persisted collection; `[]` when the file is absent or corrupt
   * (a corrupt store must never crash the scheduler — the registry re-seeds).
   */
  load(): ScheduleRecord[] {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return []
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isScheduleRecord)
    } catch {
      return []
    }
  }

  /** Atomically persist the whole collection (write .tmp, then rename). */
  save(records: ScheduleRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: STORE_MODE })
    chmodSync(tmp, STORE_MODE)
    renameSync(tmp, this.path)
    chmodSync(this.path, STORE_MODE)
  }
}

/** Minimal structural guard for a persisted schedule record. */
function isScheduleRecord(value: unknown): value is ScheduleRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<ScheduleRecord>
  return typeof record.id === 'string'
    && typeof record.prompt === 'string'
    && record.target !== undefined && typeof record.target.agentId === 'string'
    && typeof record.runCount === 'number'
    && Array.isArray(record.runs)
}
