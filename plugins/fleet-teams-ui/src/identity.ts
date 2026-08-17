/**
 * fleet-teams-ui identity resolution (issue #26, orchestration-v3 §4 P4.2):
 * a fleet-hosted rooms page renders every chat message with WHO sent it —
 * fleet-agent name + avatar (initial/color) + role badge — resolved from the
 * fleet-agent profile registry (`$DSH_HOME/fleet/agent/profiles.json`), not a
 * bare session id. This module owns that resolution:
 *
 * - `readProfileStore` — read the durable profile registry file (the same
 *   store fleet-agent's `FleetAgentService` persists, so the page and the
 *   agents agree on identity). Absent/malformed store → empty registry (the
 *   page still works, senders fall back to their agentId).
 * - `profileFor(agentId)` — one profile by id.
 * - `senderBadge(agentId, profile)` — the rendered sender badge: display name
 *   (profile.name, else the agentId), an avatar (profile.avatar if the profile
 *   carries one — P4.3 — else a deterministic initial + color derived from the
 *   agentId), and the role badge (profile.role, default `agent`).
 *
 * The dsh web app itself is NEVER touched (owner constraint): identity rides
 * on the fleet HTTP surface only.
 * @module @hydra/dsh-fleet-teams-ui/identity
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The profile registry file, relative to the fleet agent dir. */
export const PROFILE_STORE_FILE = 'profiles.json'
/** The fleet agent data dir, relative to the DSH_HOME (matches fleet-agent). */
export const FLEET_AGENT_DIR = join('fleet', 'agent')

/** One profile as read from the durable registry (the renderable subset). */
export interface ProfileRecord {
  readonly agentId: string
  readonly name: string
  readonly role: string
  /** Avatar hint (free-form: color/initial, P4.3); optional. */
  readonly avatar?: string
  readonly enabled: boolean
}

/** A rendered sender badge — what every chat message shows. */
export interface SenderBadge {
  readonly agentId: string
  readonly name: string
  readonly role: string
  /** Avatar text (an initial by default). */
  readonly avatar: string
  /** Background color for the avatar chip (deterministic per agent). */
  readonly color: string
}

/** The fleet-agent profile registry reader (pure store access). */
export class ProfileStore {
  private readonly file: string

  constructor(config: { home?: string; env?: NodeJS.ProcessEnv } = {}) {
    const home = config.home ?? resolveDshHome(undefined, config.env ?? process.env)
    this.file = join(home, FLEET_AGENT_DIR, PROFILE_STORE_FILE)
  }

  /** Absolute path of the profile registry file (surface for tests/status). */
  get path(): string {
    return this.file
  }

  /** All profiles in the registry, in file order. */
  list(): ProfileRecord[] {
    const record = this.read()
    const profiles: ProfileRecord[] = []
    for (const [agentId, raw] of Object.entries(record)) {
      const entry = raw as Record<string, unknown>
      if (typeof entry?.name !== 'string') continue
      profiles.push({
        agentId,
        name: entry.name,
        role: typeof entry.role === 'string' ? entry.role : 'agent',
        ...(typeof entry.avatar === 'string' && entry.avatar.length > 0 ? { avatar: entry.avatar } : {}),
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
      })
    }
    return profiles
  }

  /** One profile by agentId; `undefined` when not registered. */
  get(agentId: string): ProfileRecord | undefined {
    return this.list().find(profile => profile.agentId === agentId)
  }

  /** Re-read the registry file (best-effort; absent store → empty). */
  private read(): Record<string, unknown> {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return {}
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
}

/** Resolve the sender badge for one actor (fallback = bare id, neutral chip). */
export function senderBadge(agentId: string, profile: ProfileRecord | undefined): SenderBadge {
  const name = profile?.name ?? agentId
  return {
    agentId,
    name,
    role: profile?.role ?? 'agent',
    avatar: profile?.avatar ?? initialOf(name),
    color: profile?.avatar ?? colorOf(agentId),
  }
}

/** First rune of a name, uppercased (a deterministic avatar when no hint). */
function initialOf(name: string): string {
  const rune = [...name.trim()][0]
  return rune === undefined ? '?' : rune.toUpperCase()
}

/** A stable per-agent color from a tiny FNV-1a hash of the agentId. */
function colorOf(agentId: string): string {
  const palette = [
    '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
    '#06b6d4', '#ef4444', '#84cc16', '#f97316', '#14b8a6',
  ]
  let hash = 0x811c9dc5
  for (let i = 0; i < agentId.length; i++) {
    hash ^= agentId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return palette[Math.abs(hash) % palette.length]!
}

export { dirname }
