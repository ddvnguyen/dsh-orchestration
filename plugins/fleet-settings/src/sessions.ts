/**
 * fleet-settings session ledger reader (issue #26, orchestration-v3 §4.4): the
 * SESSIONS tab of the companion settings page reads the dsh session ledger
 * ($DSH_HOME/sessions — zstd JSONL session logs) through the canonical
 * `JsonlSessionPersistence` backend — the SAME reader the dsh host composes
 * (`session-persistence-jsonl`, root `dshHomePath('sessions')` in the base
 * bundle). The durable ledger carries NO status/updatedAt/title in its header:
 *
 * - `list()` returns one `SessionHeader` per materialized session (header line
 *   only — the canonical lightweight listing).
 * - `readRaw(id)` returns the exact decoded JSONL text (no reconstruction), so
 *   the tab derives the per-session presentation fields directly from the log:
 *   `title` from the latest `session/title` event, `status` from the turn
 *   balance (a `turn/start` without a later `turn/end` = the agent was
 *   mid-turn when last written → `running`; at least one turn with the last
 *   turn closed → `done`; no turn ever → `idle`/blank), and `updatedAt` from
 *   the log file's mtime (falling back to the header `createdAt`).
 *
 * PROBE (documented in orchestration/state/fleet-settings-26.md): the web UI's
 * own `session.list` RPC derives `running` host-side from
 * `ctx.agents.get(id)?.status` — a LIVE attached agent, not a durable fact.
 * A page-server process reading the ledger cold cannot observe that, so the
 * open-turn derivation is the standalone-honest status source; when composed
 * in a live host the plugin may overlay `ctx.agents` (see server deps).
 *
 * @module @hydra/dsh-fleet-settings/sessions
 */

import { statSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence, type JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Session status the settings page displays (derived from the ledger log). */
export type SessionStatus = 'running' | 'done' | 'idle'

/** One session row on the fleet-settings Sessions tab. */
export interface SessionLedgerEntry {
  /** The session id (durable ledger identity). */
  id: string
  /** Session header: creation time, cwd, preset, lineage, subagent origin. */
  header: SessionHeader
  /** Presentation fields derived from the log (never in the header). */
  title?: string
  /** The agent preset this session's agent was composed from (header passthrough). */
  agentPreset?: string
  /** Coarse origin ('subagent') from the header. */
  origin?: 'subagent'
  /** Status: open turn → running; any closed turn → done; no turn → idle. */
  status: SessionStatus
  /** Unix epoch ms of the latest activity (log mtime, else createdAt). */
  updatedAt: number
  /** Whether at least one turn has ever run (false = blank session). */
  hasActivity: boolean
}

/**
 * Read the dsh session ledger for the fleet-settings page. Composes its OWN
 * `JsonlSessionPersistence` over the session root (the fleet-family pattern:
 * consume the canonical store over the same durable dirs, never depend on a
 * composed host) so the page works standalone AND in a composed host.
 */
export class SessionLedger {
  /** The persistence backend over the session root. */
  private readonly persistence: JsonlSessionPersistence
  private readonly root: string
  private readonly compression: JsonlCompression

  constructor(config: { home?: string; sessionsRoot?: string; compression?: JsonlCompression } = {}) {
    this.root = config.sessionsRoot ?? join(config.home ?? resolveDshHome(), 'sessions')
    this.compression = config.compression ?? 'zstd'
    // The JSONL backend needs a SessionStore on the ctx for its write-path
    // coordinator; listing/reading never writes, but the constructor registers
    // the listeners unconditionally (the canonical construction).
    const ctx = new Context()
    void new SessionStore(ctx)
    this.persistence = new JsonlSessionPersistence(ctx, { root: this.root, compression: this.compression })
  }

  /** The resolved session root (surface for tests/status). */
  get sessionsRoot(): string {
    return this.root
  }

  /** The configured compression (surface for tests/status). */
  get logCompression(): JsonlCompression {
    return this.compression
  }

  /** List every materialized session with its derived presentation fields. */
  async list(): Promise<SessionLedgerEntry[]> {
    const headers = await this.persistence.list()
    const entries: SessionLedgerEntry[] = []
    for (const header of headers) {
      entries.push(await this.entry(header))
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** One ledger entry by id; `undefined` when the session is not materialized. */
  async get(id: string): Promise<SessionLedgerEntry | undefined> {
    const headers = await this.persistence.list()
    const header = headers.find(candidate => candidate.id === id)
    return header === undefined ? undefined : this.entry(header)
  }

  /** Derive one entry from a ledger header + its raw log. */
  private async entry(header: SessionHeader): Promise<SessionLedgerEntry> {
    const raw = await this.readRaw(header.id)
    const derived = raw === undefined ? deriveFromText('') : deriveFromText(raw.content)
    const location = this.persistence.locate(header)
    const mtime = statMtime(location.path)
    const entry: SessionLedgerEntry = {
      id: header.id,
      header,
      status: derived.status,
      updatedAt: mtime ?? header.createdAt,
      hasActivity: derived.hasActivity,
      ...(derived.title !== undefined ? { title: derived.title } : {}),
      ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
      ...(header.origin !== undefined ? { origin: header.origin } : {}),
    }
    return entry
  }

  /** The raw decoded JSONL text for one session (verbatim ledger bytes). */
  private async readRaw(id: SessionId): Promise<{ content: string } | undefined> {
    try {
      const artifact = await this.persistence.readRaw(id)
      return artifact === undefined ? undefined : { content: artifact.content }
    } catch {
      // A torn/unreadable artifact is skipped from the listing, never fatal.
      return undefined
    }
  }
}

/** Presentation facts folded from a session log's JSONL text. */
interface LogFacts {
  title?: string
  status: SessionStatus
  hasActivity: boolean
}

/**
 * Fold a session log's raw JSONL text into the presentation facts: the latest
 * `session/title`, and the turn balance for status. Event lines are the
 * SessionEvent envelope `{ type, seq, time, data }`; packed chunk rows
 * (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`) never carry
 * turn/title records, so the fold only reads the fields it needs and skips
 * anything else defensively.
 */
export function deriveFromText(content: string): LogFacts {
  let title: string | undefined
  let lastTurnStart: number | undefined
  let lastTurnEnd: number | undefined
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      record = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (record.type === 'session/title') {
      const data = record.data as Record<string, unknown> | undefined
      if (data !== null && typeof data === 'object' && typeof data.title === 'string' && data.title.length > 0) {
        title = data.title
      }
      continue
    }
    if (record.type === 'turn/start') {
      const data = record.data as Record<string, unknown> | undefined
      if (data !== null && typeof data === 'object' && typeof data.turn === 'number') {
        lastTurnStart = data.turn
      }
      continue
    }
    if (record.type === 'turn/end') {
      const data = record.data as Record<string, unknown> | undefined
      if (data !== null && typeof data === 'object' && typeof data.turn === 'number') {
        lastTurnEnd = data.turn
      }
    }
  }
  if (lastTurnStart === undefined) {
    return { ...(title !== undefined ? { title } : {}), status: 'idle', hasActivity: false }
  }
  const running = lastTurnEnd === undefined || lastTurnStart > lastTurnEnd
  return { ...(title !== undefined ? { title } : {}), status: running ? 'running' : 'done', hasActivity: true }
}

/** File mtime in ms, or `undefined` when the log is absent/unstat-able. */
function statMtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}
