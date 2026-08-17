/**
 * fleet-teams-ui overlay store (issue #26, orchestration-v3 §4 P4.2): durable
 * UI-layer state for the team/room settings dialog.
 *
 * WHY IT EXISTS: the fleet-teams service (P4.1) has NO `renameRoom` /
 * `archiveRoom` / `deleteRoom` seam — the constraint is to CONSUME it, never
 * change it, and missing seams are documented follow-ups. So the settings
 * dialog's rename + archive are persisted HERE, in the UI plugin's own
 * durable store, while grants / membership / memory / posts all persist via
 * the fleet-teams service (`teams.json` + the room memory file). The overlay
 * is a presentation layer: `displayName` overrides the room name the page
 * renders, `archived` hides a room from the default list. Canonical
 * rename/archive INSIDE fleet-teams (so agents' `room_list` sees it too) is
 * the documented follow-up.
 *
 * DURABLE STATE: `$DSH_HOME/fleet/teams-ui/overrides.json` keyed by roomId:
 * `{ rooms: { [roomId]: { displayName?, archived? } }, seq }`. Atomic
 * tmp+rename writes; reloaded on boot — so dialog changes survive a restart
 * of the page server.
 * @module @hydra/dsh-fleet-teams-ui/overlay
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The overlay data dir, relative to the DSH_HOME. */
export const TEAMS_UI_DIR = join('fleet', 'teams-ui')
/** The durable overlay store file. */
const OVERLAY_FILE = 'overrides.json'

/** Per-room overlay state (both fields optional; absent = no override). */
export interface RoomOverlay {
  /** Presentation override for the room name (canonical name is fleet-teams'). */
  displayName?: string
  /** Hidden from the default room list (restore = clear the flag). */
  archived?: boolean
}

/** The durable overlay: one entry per room id. */
export interface OverlayStoreData {
  seq: number
  rooms: Record<string, RoomOverlay>
}

/** Load + persist the UI overlay store (presentation layer over fleet-teams). */
export class TeamsUiOverlay {
  private readonly file: string
  private data: OverlayStoreData = { seq: 0, rooms: {} }

  constructor(config: { home?: string } = {}) {
    const home = config.home ?? resolveDshHome()
    this.file = join(home, TEAMS_UI_DIR, OVERLAY_FILE)
    this.load()
  }

  /** Absolute path of the overlay store (surface for tests/status). */
  get path(): string {
    return this.file
  }

  /** The overlay for one room (always a fresh shallow copy). */
  room(roomId: string): RoomOverlay {
    return { ...(this.data.rooms[roomId] ?? {}) }
  }

  /** All overrides, keyed by room id. */
  all(): Record<string, RoomOverlay> {
    return Object.fromEntries(Object.entries(this.data.rooms).map(([id, overlay]) => [id, { ...overlay }]))
  }

  /** Set the presentation display name (empty string clears the override). */
  setDisplayName(roomId: string, displayName: string): RoomOverlay {
    const current = this.data.rooms[roomId] ?? {}
    if (displayName.length === 0) {
      const { displayName: _drop, ...rest } = current
      this.data.rooms[roomId] = rest
    } else {
      this.data.rooms[roomId] = { ...current, displayName }
    }
    this.persist()
    return this.room(roomId)
  }

  /** Archive a room (hidden from the default list) or restore it. */
  setArchived(roomId: string, archived: boolean): RoomOverlay {
    const current = this.data.rooms[roomId] ?? {}
    if (archived) {
      this.data.rooms[roomId] = { ...current, archived: true }
    } else {
      const { archived: _drop, ...rest } = current
      this.data.rooms[roomId] = rest
    }
    this.persist()
    return this.room(roomId)
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
      const rooms: Record<string, RoomOverlay> = {}
      const rawRooms = record.rooms as Record<string, Record<string, unknown>> | undefined
      if (rawRooms !== null && typeof rawRooms === 'object') {
        for (const [roomId, raw] of Object.entries(rawRooms)) {
          if (raw === null || typeof raw !== 'object') continue
          const overlay: RoomOverlay = {
            ...(typeof raw.displayName === 'string' && raw.displayName.length > 0 ? { displayName: raw.displayName } : {}),
            ...(raw.archived === true ? { archived: true } : {}),
          }
          if (Object.keys(overlay).length > 0) rooms[roomId] = overlay
        }
      }
      this.data = { seq, rooms }
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
