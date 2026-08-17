/**
 * The durable fleet-tasks store: a SQLite database via the built-in
 * `node:sqlite` module (`DatabaseSync`, Node 24 — no external dependency).
 *
 * STORE CHOICE (vs fleet-bus' append-only JSONL): task state has UPDATE
 * semantics — claim, transition, escalate, accept all mutate an existing row —
 * and claim needs to be ATOMIC (no double-claim). SQLite gives both natively:
 * a single guarded `UPDATE … WHERE assignee IS NULL AND state IN (claimable)`
 * statement whose `changes === 1` is the arbiter, plus a real query surface
 * (state/assignee/goal). fleet-bus' JSONL append-only file would require
 * read-modify-write round-trips for every mutation and would not give atomic
 * single-claim. `node:sqlite` is built into Node >= 22.5, so unlike an npm
 * sqlite package it needs no dependency — the right fit for the prototype
 * family's zero-new-deps rule.
 *
 * The database lives at `$DSH_HOME/fleet/fleet-tasks.sqlite` by default
 * (configurable `dir`/`file`), matching the family's durable-state layout
 * under `$DSH_HOME/fleet/`. `DatabaseSync` is synchronous — mutations are
 * serialized, so a guarded single-statement UPDATE is a safe atomic claim.
 * @module @hydra/dsh-fleet-tasks/store
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {
  FleetTask,
  FleetTaskLock,
  FleetTaskQueryFilter,
  FleetTaskState,
} from './types.ts'
import { FLEET_TASK_CLAIMABLE_STATES } from './types.ts'

export interface FleetTaskStoreConfig {
  /** Directory holding the SQLite file. Default `$DSH_HOME/fleet`. */
  dir?: string
  /** Database file name. Default `fleet-tasks.sqlite`. */
  file?: string
}

interface TaskRow {
  id: string
  title: string
  goal_ancestry: string
  parent_id: string | null
  state: string
  assignee: string | null
  priority: string | null
  severity: string
  escalation: string | null
  artifact_contract: string | null
  claim_role: string | null
  locks: string
  evidence: string | null
  acceptance: string | null
  auto_closed_by: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

const CLAIMABLE_PLACEHOLDERS = FLEET_TASK_CLAIMABLE_STATES.map(() => '?').join(', ')

/**
 * The durable task store (no Cordis imports — pure, like the family's
 * FleetRegistry). All mutation helpers are synchronous over `DatabaseSync`.
 */
export class FleetTaskStore {
  /** Absolute path of the SQLite database file. */
  readonly path: string
  private readonly db: DatabaseSync

  constructor(config: FleetTaskStoreConfig = {}) {
    const dir = config.dir ?? join(resolveDshHome(), 'fleet')
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, config.file ?? 'fleet-tasks.sqlite')
    this.db = new DatabaseSync(this.path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal_ancestry TEXT NOT NULL DEFAULT '[]',
        parent_id TEXT,
        state TEXT NOT NULL,
        assignee TEXT,
        priority TEXT,
        severity TEXT NOT NULL,
        escalation TEXT,
        artifact_contract TEXT,
        claim_role TEXT,
        locks TEXT NOT NULL DEFAULT '[]',
        evidence TEXT,
        acceptance TEXT,
        auto_closed_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
    `)
  }

  /** Close the database (test/teardown hygiene). */
  close(): void {
    this.db.close()
  }

  /** Read one task by id; `undefined` when absent. */
  get(id: string): FleetTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined
    return row === undefined ? undefined : rowToTask(row)
  }

  /** All tasks, insertion order. */
  list(): FleetTask[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, id ASC').all() as unknown as TaskRow[]
    return rows.map(rowToTask)
  }

  /**
   * Query tasks by state/assignee/goal/severity. `goal` matches tasks whose
   * goal ancestry contains the goal id (JSON array containment via LIKE).
   */
  query(filter: FleetTaskQueryFilter = {}): FleetTask[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter.state !== undefined) {
      clauses.push('state = ?')
      params.push(filter.state)
    }
    if (filter.assignee !== undefined) {
      clauses.push('assignee = ?')
      params.push(filter.assignee)
    }
    if (filter.goal !== undefined) {
      clauses.push("goal_ancestry LIKE '%' || ? || '%'")
      params.push(JSON.stringify(filter.goal))
    }
    if (filter.severity !== undefined) {
      clauses.push('severity = ?')
      params.push(filter.severity)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = this.db
      .prepare(`SELECT * FROM tasks${where} ORDER BY created_at ASC, id ASC`)
      .all(...params) as unknown as TaskRow[]
    return rows.map(rowToTask)
  }

  /** Insert or replace a full task row. */
  put(task: FleetTask): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, title, goal_ancestry, parent_id, state, assignee, priority, severity,
        escalation, artifact_contract, claim_role, locks, evidence, acceptance,
        auto_closed_by, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.title,
      JSON.stringify([...task.goalAncestry]),
      task.parentId ?? null,
      task.state,
      task.assignee ?? null,
      task.priority ?? null,
      task.severity,
      task.escalation === undefined ? null : JSON.stringify(task.escalation),
      task.artifactContract === undefined ? null : JSON.stringify(task.artifactContract),
      task.claimRole ?? null,
      JSON.stringify(task.locks.map(lock => ({ ...lock }))),
      task.evidence === undefined ? null : JSON.stringify(task.evidence),
      task.acceptance === undefined ? null : JSON.stringify(task.acceptance),
      task.autoClosedBy ?? null,
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? null,
    )
  }

  /**
   * ATOMIC claim: single guarded UPDATE acquires the execution lock for one
   * agent. The guard (`state IN (claimable) AND assignee IS NULL`) plus
   * `changes === 1` means exactly one claimant can ever win — a second claim
   * matches zero rows. This is the no-double-claim guarantee.
   * @returns the winning claim's assigned `locks` JSON, or `null` when the
   *   task was already claimed or is not claimable.
   */
  atomicClaim(id: string, assignee: string, lock: FleetTaskLock, updatedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE tasks SET assignee = ?, state = 'Started', locks = ?, updated_at = ?
      WHERE id = ? AND state IN (${CLAIMABLE_PLACEHOLDERS}) AND assignee IS NULL
    `).run(assignee, JSON.stringify([{ ...lock }]), updatedAt, id, ...FLEET_TASK_CLAIMABLE_STATES)
    return Number(result.changes) === 1
  }

  /** Release any execution lock (cancel / reopen-on-rejection): clear assignee + locks. */
  releaseLock(id: string, updatedAt: number): void {
    this.db.prepare('UPDATE tasks SET assignee = NULL, locks = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify([]), updatedAt, id)
  }
}

function rowToTask(row: TaskRow): FleetTask {
  const task: FleetTask = {
    id: row.id,
    title: row.title,
    goalAncestry: parseJsonArray(row.goal_ancestry),
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    state: row.state as FleetTaskState,
    ...(row.assignee !== null ? { assignee: row.assignee } : {}),
    ...(row.priority !== null ? { priority: row.priority } : {}),
    severity: row.severity as FleetTask['severity'],
    ...(row.escalation !== null ? { escalation: JSON.parse(row.escalation) as FleetTask['escalation'] } : {}),
    ...(row.artifact_contract !== null ? { artifactContract: JSON.parse(row.artifact_contract) as FleetTask['artifactContract'] } : {}),
    ...(row.claim_role !== null ? { claimRole: row.claim_role } : {}),
    locks: parseJsonArray(row.locks) as FleetTaskLock[],
    ...(row.evidence !== null ? { evidence: JSON.parse(row.evidence) as FleetTask['evidence'] } : {}),
    ...(row.acceptance !== null ? { acceptance: JSON.parse(row.acceptance) as FleetTask['acceptance'] } : {}),
    ...(row.auto_closed_by !== null ? { autoClosedBy: row.auto_closed_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  }
  return task
}

function parseJsonArray<T>(raw: string): T[] {
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed as T[] : []
}
