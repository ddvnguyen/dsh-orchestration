/**
 * The durable fleet-budget store: a SQLite database via the built-in
 * `node:sqlite` module (`DatabaseSync`, Node 24 — no external dependency),
 * mirroring the fleet-tasks store family (`plugins/fleet-tasks/src/store.ts`).
 *
 * STORE CHOICE: budgets have UPDATE semantics (spend accumulates, caps and
 * thresholds mutate, dedupe flags flip on crossings) plus an append-only cost
 * ledger — SQLite gives both in one file: a `budgets` table keyed by scope
 * (one budget per scope, UPSERT on `setBudget`) and an append-only `costs`
 * ledger. `node:sqlite` is built into Node ≥ 22.5, so it adds zero
 * dependencies (the family's zero-new-deps rule). The file lives at
 * `$DSH_HOME/fleet/fleet-budget.sqlite` by default (configurable `dir`/`file`),
 * matching the family's durable-state layout under `$DSH_HOME/fleet/`.
 * `DatabaseSync` is synchronous — mutations are serialized in-process, so the
 * service's read-modify-write accumulation is race-free.
 * @module @hydra/dsh-fleet-budget/store
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { FleetBudgetEntry, FleetBudgetUnit, FleetCostRecord } from './types.ts'
import { fleetBudgetScopeFromKey, fleetBudgetScopeKey } from './types.ts'

export interface FleetBudgetStoreConfig {
  /** Directory holding the SQLite file. Default `$DSH_HOME/fleet`. */
  dir?: string
  /** Database file name. Default `fleet-budget.sqlite`. */
  file?: string
}

interface BudgetRow {
  id: string
  scope_key: string
  cap: number
  unit: string
  soft_threshold: number
  critical_threshold: number
  spent_tokens: number
  spent_cost: number
  warning_emitted: number
  escalated_emitted: number
  owner: string | null
  created_at: number
  updated_at: number
}

interface CostRow {
  id: string
  agent_id: string
  task_kind: string | null
  tokens: number
  cost: number
  ts: number
}

/**
 * The durable budget store (no Cordis imports — pure, like the family's
 * FleetTaskStore). All helpers are synchronous over `DatabaseSync`.
 */
export class FleetBudgetStore {
  /** Absolute path of the SQLite database file. */
  readonly path: string
  private readonly db: DatabaseSync

  constructor(config: FleetBudgetStoreConfig = {}) {
    const dir = config.dir ?? join(resolveDshHome(), 'fleet')
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, config.file ?? 'fleet-budget.sqlite')
    this.db = new DatabaseSync(this.path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL UNIQUE,
        cap REAL NOT NULL,
        unit TEXT NOT NULL,
        soft_threshold REAL NOT NULL,
        critical_threshold REAL NOT NULL,
        spent_tokens REAL NOT NULL DEFAULT 0,
        spent_cost REAL NOT NULL DEFAULT 0,
        warning_emitted INTEGER NOT NULL DEFAULT 0,
        escalated_emitted INTEGER NOT NULL DEFAULT 0,
        owner TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS costs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_kind TEXT,
        tokens REAL NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_budgets_scope ON budgets(scope_key);
      CREATE INDEX IF NOT EXISTS idx_costs_agent ON costs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_costs_task_kind ON costs(task_kind);
    `)
  }

  /** Close the database (test/teardown hygiene). */
  close(): void {
    this.db.close()
  }

  /** One budget by scope key; `undefined` when absent. */
  getBudget(scopeKey: string): FleetBudgetEntry | undefined {
    const row = this.db.prepare('SELECT * FROM budgets WHERE scope_key = ?').get(scopeKey) as unknown as BudgetRow | undefined
    return row === undefined ? undefined : rowToBudget(row)
  }

  /** All budgets, creation order. */
  listBudgets(): FleetBudgetEntry[] {
    const rows = this.db.prepare('SELECT * FROM budgets ORDER BY created_at ASC, id ASC').all() as unknown as BudgetRow[]
    return rows.map(rowToBudget)
  }

  /** Insert or replace a full budget row (one per scope). */
  putBudget(budget: FleetBudgetEntry): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO budgets (
        id, scope_key, cap, unit, soft_threshold, critical_threshold,
        spent_tokens, spent_cost, warning_emitted, escalated_emitted,
        owner, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      budget.id,
      fleetBudgetScopeKey(budget.scope),
      budget.cap,
      budget.unit,
      budget.softThreshold,
      budget.criticalThreshold,
      budget.spentTokens,
      budget.spentCost,
      budget.warningEmitted ? 1 : 0,
      budget.escalatedEmitted ? 1 : 0,
      budget.owner ?? null,
      budget.createdAt,
      budget.updatedAt,
    )
  }

  /** Append one cost record to the durable ledger. */
  appendCost(record: FleetCostRecord): void {
    this.db.prepare(`
      INSERT INTO costs (id, agent_id, task_kind, tokens, cost, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.id, record.agentId, record.taskKind ?? null, record.tokens, record.cost, record.ts)
  }

  /** Fleet-wide token/cost totals over every cost record. */
  totals(): { tokens: number; cost: number } {
    const row = this.db.prepare('SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM costs').get() as unknown as {
      tokens: number
      cost: number
    }
    return { tokens: row.tokens, cost: row.cost }
  }

  /** All cost records, oldest first (ledger read; used for debugging/tests). */
  listCosts(): FleetCostRecord[] {
    const rows = this.db.prepare('SELECT * FROM costs ORDER BY ts ASC, id ASC').all() as unknown as CostRow[]
    return rows.map(rowToCost)
  }
}

function rowToBudget(row: BudgetRow): FleetBudgetEntry {
  return {
    id: row.id,
    scope: fleetBudgetScopeFromKey(row.scope_key)!,
    cap: row.cap,
    unit: row.unit as FleetBudgetUnit,
    softThreshold: row.soft_threshold,
    criticalThreshold: row.critical_threshold,
    spentTokens: row.spent_tokens,
    spentCost: row.spent_cost,
    warningEmitted: row.warning_emitted === 1,
    escalatedEmitted: row.escalated_emitted === 1,
    ...(row.owner !== null ? { owner: row.owner } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToCost(row: CostRow): FleetCostRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ...(row.task_kind !== null ? { taskKind: row.task_kind } : {}),
    tokens: row.tokens,
    cost: row.cost,
    ts: row.ts,
  }
}
