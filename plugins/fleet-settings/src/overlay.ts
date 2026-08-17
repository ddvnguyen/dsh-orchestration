/**
 * fleet-settings UI overlay store (issue #26, orchestration-v3 §4.4): durable
 * UI-layer state for the Sessions tab.
 *
 * WHY IT EXISTS: the canonical archive seam is the dsh host's
 * `workspace.archiveSession` RPC — it adds a session to the registry-global
 * archive set (a presentation set, not a deletion). That RPC only works when a
 * dsh web host is reachable, and its effect is host-process-global. So the
 * page persists its OWN archive marker here, in the settings plugin's durable
 * store (the fleet-teams-ui overlay pattern), while the archive action ALSO
 * fires the host RPC when a dsh web base URL is configured. The overlay keeps
 * an archived session hidden from the default list across a restart of the
 * page server even when no dsh host is running.
 *
 * DURABLE STATE: `$DSH_HOME/fleet/settings/overrides.json` keyed by sessionId:
 * `{ sessions: { [id]: { archived?: boolean } }, seq }`. Atomic tmp+rename
 * writes; reloaded on boot.
 * @module @hydra/dsh-fleet-settings/overlay
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The overlay data dir, relative to the DSH_HOME. */
export const SETTINGS_UI_DIR = join('fleet', 'settings')
/** The durable overlay store file. */
const OVERLAY_FILE = 'overrides.json'

/** Per-session overlay state (both fields optional; absent = no override). */
export interface SessionOverlay {
  /** Hidden from the default session list (restore = clear the flag). */
  archived?: boolean
}

/** The durable overlay: one entry per session id. */
export interface OverlayStoreData {
  seq: number
  sessions: Record<string, SessionOverlay>
}

/** Load + persist the fleet-settings UI overlay store. */
export class SettingsOverlay {
  private readonly file: string
  private data: OverlayStoreData = { seq: 0, sessions: {} }

  constructor(config: { home?: string } = {}) {
    const home = config.home ?? resolveDshHome()
    this.file = join(home, SETTINGS_UI_DIR, OVERLAY_FILE)
    this.load()
  }

  /** Absolute path of the overlay store (surface for tests/status). */
  get path(): string {
    return this.file
  }

  /** The overlay for one session (always a fresh shallow copy). */
  session(sessionId: string): SessionOverlay {
    return { ...(this.data.sessions[sessionId] ?? {}) }
  }

  /** All overrides, keyed by session id. */
  all(): Record<string, SessionOverlay> {
    return Object.fromEntries(Object.entries(this.data.sessions).map(([id, overlay]) => [id, { ...overlay }]))
  }

  /** Archive a session (hidden from the default list) or restore it. */
  setArchived(sessionId: string, archived: boolean): SessionOverlay {
    const current = this.data.sessions[sessionId] ?? {}
    if (archived) {
      this.data.sessions[sessionId] = { ...current, archived: true }
    } else {
      const { archived: _drop, ...rest } = current
      this.data.sessions[sessionId] = rest
    }
    this.persist()
    return this.session(sessionId)
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const record = parsed as Record<string, unknown>
      const seq = typeof record.seq === 'number' ? record.seq : 0
      const sessions: Record<string, SessionOverlay> = {}
      const rawSessions = record.sessions as Record<string, Record<string, unknown>> | undefined
      if (rawSessions !== null && typeof rawSessions === 'object') {
        for (const [sessionId, raw] of Object.entries(rawSessions)) {
          if (raw === null || typeof raw !== 'object') continue
          const overlay: SessionOverlay = {
            ...(raw.archived === true ? { archived: true } : {}),
          }
          if (Object.keys(overlay).length > 0) sessions[sessionId] = overlay
        }
      }
      this.data = { seq, sessions }
    } catch {
      // Malformed overlay: keep the empty store (the UI degrades gracefully).
    }
  }

  private persist(): void {
    this.data.seq += 1
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8' })
    renameSync(tmp, this.file)
  }
}
