/**
 * FleetAgentService — the `ctx.fleetAgent` Cordis service.
 *
 * Per-agent profiles (agentId/name/role/claimRole/cwd/tier/provider/model/
 * promptFile/avatar/enabled/status/publicKey) backed by an ed25519 keypair
 * per profile, ed25519-signed fleet events in OUR OWN format (owner decision
 * #1, docs/orchestration-v3.md: no Nostr/NIP-01 this iteration), and an
 * attribution ledger (who did what when, each record carrying its own signed
 * event).
 *
 * P4.3 (fleet-admin, issue #26 §4.3): the profile is ALSO the agent-config
 * runtime store. The team roster (team/roster.ts) seeds the profiles; admin
 * edits (updateProfile / disable / enable) persist as overrides in
 * `$DSH_HOME/fleet/agent/profiles.json` and win on reload — keys are never
 * touched. `isEnabled(agentId)` is the disabled-agent consult seam the
 * fleet-supervisor's wake scan reads (see supervisor service.ts).
 *
 * Registration follows dsh service plugins: `Service` base class +
 * `super(ctx, 'fleetAgent')` (`vendor/cordis/src/service.ts:35-57`). The
 * profile store and the key store persist under `$DSH_HOME/fleet/agent/`
 * (key store: keys.json, 0600 perms — see src/key-store.ts; the key store
 * migrates a legacy `$DSH_HOME/fleet/identity/` store on first boot after
 * the fleet-identity → fleet-agent rename). The plugin itself (src/index.ts)
 * hooks `agent/created` to auto-register profiles and inject the agent tools,
 * mirroring fleet-inject.
 * @module @hydra/dsh-fleet-agent/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import { join, dirname } from 'node:path'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { canonicalJson } from './canonical-json.ts'
import { Ed25519KeyStore, FLEET_AGENT_DIR } from './key-store.ts'
import { AuditLedger, type FleetAuditRecord, type FleetSignedEvent } from './audit-ledger.ts'
import type {} from '../../../src/types.ts'

export type { FleetSignedEvent } from './audit-ledger.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetAgent: FleetAgentService
  }

  interface Events {
    /**
     * One attribution record was appended to the fleet agent audit ledger.
     * Observers use it for transparency feeds, policies, or digests. Emitted
     * synchronously after the ledger append.
     * @param record - the appended attribution record (carries its signed event).
     * @mode emit
     */
    'fleet/audit'(record: FleetAuditRecord): void
  }
}

export interface FleetProfileInput {
  /** Stable agent identity (dsh SessionId string for dsh agents). */
  agentId: string
  /** Human label; defaults to the agentId. */
  name?: string
  /** Role in the fleet (lead/worker/qa, free-form). */
  role?: string
  /** Org-chart role routed to this agent by fleet-tasks claimWake. */
  claimRole?: string
  /** Workspace the agent works in (wake workspace context). */
  cwd?: string
  /** Provider tier (orchestration/providers.yaml); e.g. 't2'. */
  tier?: string
  /** Provider/model string; e.g. 'opencode/opencode-go/minimax-m3'. */
  provider?: string
  /** Model id within the provider. */
  model?: string
  /** Prompt file for this agent (per-role V3 prompt). */
  promptFile?: string
  /** Avatar hint (free-form; e.g. a color hex or initial). */
  avatar?: string
  /** Whether the agent may be woken / claim work (default true). */
  enabled?: boolean
  /** Profile status; defaults to 'active'. */
  status?: string
}

/**
 * One fleet identity profile (public fields only — never key material).
 * P4.3 adds the runtime agent-config surface: claimRole/cwd/tier/provider/
 * model/promptFile/avatar/enabled are mutable via {@link updateProfile} and
 * persist as overrides in profiles.json.
 */
export interface FleetAgentProfile {
  readonly agentId: string
  name: string
  role: string
  status: string
  /** Org-chart role routed to this agent by fleet-tasks claimWake. */
  claimRole?: string
  /** Workspace the agent works in (wake workspace context). */
  cwd?: string
  /** Provider tier (orchestration/providers.yaml); e.g. 't2'. */
  tier?: string
  /** Provider/model string; e.g. 'opencode/opencode-go/minimax-m3'. */
  provider?: string
  /** Model id within the provider. */
  model?: string
  /** Prompt file for this agent (per-role V3 prompt). */
  promptFile?: string
  /** Avatar hint (free-form; e.g. a color hex or initial). */
  avatar?: string
  /**
   * Whether the agent may be woken / claim work. Defaults true. A disabled
   * agent's wakes are skipped by the fleet-supervisor consult seam
   * (`isEnabled(agentId)`); profile lists mark it as such.
   */
  enabled: boolean
  /** Unix epoch ms of first registration; stable across re-registrations. */
  readonly createdAt: number
  /** base64 SPKI DER ed25519 public key. Public by design. */
  readonly publicKey: string
}

/** The mutable agent-config fields `updateProfile` accepts (any subset). */
export interface FleetProfilePatch {
  name?: string
  role?: string
  claimRole?: string
  cwd?: string
  tier?: string
  provider?: string
  model?: string
  promptFile?: string
  avatar?: string
  enabled?: boolean
  status?: string
}

/** The payload shape `sign` accepts; `ts` defaults to now. */
export interface FleetSignInput {
  /** Event type label. */
  type: string
  /** The acting agent profile id. */
  actor: string
  /** Arbitrary JSON payload. */
  payload: JsonValue
  /** Unix epoch ms (defaults to Date.now()). */
  ts?: number
}

/** Result of a signature check. */
export interface FleetVerifyResult {
  ok: boolean
  /** Why verification failed, when it did. */
  reason?: string
}

export interface FleetAgentConfig {
  /** Override the resolved DSH_HOME (test seam; defaults to resolveDshHome()). */
  home?: string
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  clock?: () => number
}

/** File name of the profile store inside the agent dir. */
const PROFILE_STORE_FILE = 'profiles.json'

/** Profile store mode: agent metadata is not secret, but owner-writable. */
const PROFILE_STORE_MODE = 0o600

export class FleetAgentService extends Service {
  readonly keyStore: Ed25519KeyStore
  private readonly ledger: AuditLedger
  private readonly profiles = new Map<string, FleetAgentProfile>()
  private readonly profilesFile: string
  private readonly clock: () => number

  constructor(ctx: Context, config: FleetAgentConfig = {}) {
    super(ctx, 'fleetAgent')
    const home = config.home ?? resolveDshHome()
    this.keyStore = new Ed25519KeyStore({ home })
    this.profilesFile = join(home, FLEET_AGENT_DIR, PROFILE_STORE_FILE)
    this.clock = config.clock ?? Date.now
    this.loadProfiles()
    this.ledger = new AuditLedger({
      onAppend: (record) => {
        ctx.emit('fleet/audit', record)
        this.mirrorAuditToSession(record)
      },
    })
  }

  // ---- profiles ----

  /** One profile; `undefined` when the agent is not registered. */
  getProfile(agentId: string): FleetAgentProfile | undefined {
    return this.profiles.get(agentId)
  }

  /** All registered profiles, in registration order. */
  listProfiles(): FleetAgentProfile[] {
    return [...this.profiles.values()]
  }

  /**
   * Register (or re-register) an agent profile. The first registration mints
   * and persists an ed25519 keypair (idempotent thereafter — keys are never
   * rotated by re-registration). Missing fields fall back to the existing
   * profile, then to defaults. A disabled profile re-registering (e.g. an
   * `agent/created` hook) STAYS disabled — re-registration is never a
   * back-door enable.
   * @param input - profile identity and optional metadata.
   * @returns the resulting profile (public key only).
   */
  register(input: FleetProfileInput): FleetAgentProfile {
    if (input.agentId.length === 0) throw new Error('fleet-agent: agentId must be non-empty')
    const existing = this.profiles.get(input.agentId)
    const stored = this.keyStore.ensure(input.agentId)
    const profile: FleetAgentProfile = {
      agentId: input.agentId,
      name: input.name ?? existing?.name ?? input.agentId,
      role: input.role ?? existing?.role ?? 'agent',
      claimRole: input.claimRole ?? existing?.claimRole,
      cwd: input.cwd ?? existing?.cwd,
      tier: input.tier ?? existing?.tier,
      provider: input.provider ?? existing?.provider,
      model: input.model ?? existing?.model,
      promptFile: input.promptFile ?? existing?.promptFile,
      avatar: input.avatar ?? existing?.avatar,
      enabled: input.enabled ?? existing?.enabled ?? true,
      status: input.status ?? existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? this.clock(),
      publicKey: stored.publicKey,
    }
    this.profiles.set(input.agentId, profile)
    this.persistProfiles()
    return profile
  }

  // ---- P4.3 fleet-admin: runtime agent-config CRUD ----

  /**
   * Apply a partial update to one agent's config and persist the override.
   * Absent patch fields are unchanged (`undefined` = no edit); keys are never
   * touched. Throws when the agent has no profile.
   * @param agentId - the profile to update (must be registered).
   * @param patch - the fields to change (any subset of the config surface).
   * @returns the resulting profile.
   */
  updateProfile(agentId: string, patch: FleetProfilePatch): FleetAgentProfile {
    const existing = this.profiles.get(agentId)
    if (existing === undefined) {
      throw new Error(`fleet-agent: no profile for "${agentId}"; register() it first`)
    }
    const updated: FleetAgentProfile = {
      ...existing,
      name: patch.name ?? existing.name,
      role: patch.role ?? existing.role,
      claimRole: patch.claimRole ?? existing.claimRole,
      cwd: patch.cwd ?? existing.cwd,
      tier: patch.tier ?? existing.tier,
      provider: patch.provider ?? existing.provider,
      model: patch.model ?? existing.model,
      promptFile: patch.promptFile ?? existing.promptFile,
      avatar: patch.avatar ?? existing.avatar,
      enabled: patch.enabled ?? existing.enabled,
      status: patch.status ?? existing.status,
    }
    this.profiles.set(agentId, updated)
    this.persistProfiles()
    return updated
  }

  /** Disable an agent: wakes skipped, no claimWake, marked in profile lists. */
  disable(agentId: string): FleetAgentProfile {
    return this.updateProfile(agentId, { enabled: false, status: 'offline' })
  }

  /** Enable a previously-disabled agent (re-opens wake delivery + claims). */
  enable(agentId: string): FleetAgentProfile {
    return this.updateProfile(agentId, { enabled: true, status: 'active' })
  }

  /**
   * The disabled-agent consult seam: `true` for every registered profile
   * unless it was explicitly disabled. Unregistered agents are NOT gated
   * (only explicitly-disabled agents stop receiving wakes).
   */
  isEnabled(agentId: string): boolean {
    return this.profiles.get(agentId)?.enabled ?? true
  }

  // ---- signing ----

  /**
   * Sign a fleet event with the actor's ed25519 private key. The signature
   * covers the canonical serialization of `{type, actor, payload, ts}`
   * (src/canonical-json.ts); `sig` and `pubkey` are envelope fields carried
   * outside the signed bytes.
   * @param event - the event to sign (actor must have a registered profile).
   * @returns the full signed event: envelope + sig + pubkey (public key only).
   */
  sign(event: FleetSignInput): FleetSignedEvent {
    if (!this.profiles.has(event.actor)) {
      throw new Error(`fleet-agent: actor "${event.actor}" has no profile; call register() first`)
    }
    const ts = event.ts ?? this.clock()
    const core = { type: event.type, actor: event.actor, payload: event.payload, ts }
    const signature = this.keyStore.sign(event.actor, Buffer.from(canonicalJson(core), 'utf8'))
    return {
      ...core,
      sig: signature.toString('base64'),
      pubkey: this.profiles.get(event.actor)!.publicKey,
    }
  }

  /**
   * Verify a signed fleet event: structural check, ed25519 signature against
   * the embedded pubkey, and — when the actor has a registered profile — that
   * the embedded pubkey matches the profile's key (tampering with the pubkey
   * field is caught even if an attacker re-signs with their own key).
   * @param signed - the event to check.
   * @returns `{ ok: true }` or `{ ok: false, reason }`.
   */
  verify(signed: FleetSignedEvent): FleetVerifyResult {
    if (
      signed === null || typeof signed !== 'object'
      || typeof signed.type !== 'string' || typeof signed.actor !== 'string'
      || typeof signed.ts !== 'number' || typeof signed.sig !== 'string'
      || typeof signed.pubkey !== 'string'
    ) {
      return { ok: false, reason: 'malformed signed event' }
    }
    const core = { type: signed.type, actor: signed.actor, payload: signed.payload, ts: signed.ts }
    const valid = this.keyStore.verify(
      signed.pubkey,
      Buffer.from(canonicalJson(core), 'utf8'),
      Buffer.from(signed.sig, 'base64'),
    )
    if (!valid) return { ok: false, reason: 'signature does not match the event bytes' }
    const profile = this.profiles.get(signed.actor)
    if (profile !== undefined && profile.publicKey !== signed.pubkey) {
      return { ok: false, reason: 'pubkey does not match the actor\'s registered profile' }
    }
    return { ok: true }
  }

  // ---- attribution ----

  /**
   * Record who did what when: appends a signed audit record to the ledger,
   * emits a `fleet/audit` Cordis event, and mirrors the record into the
   * actor's dsh session log (when one is composed).
   * @param actor - the acting agent profile id (must be registered).
   * @param action - what happened (verb).
   * @param target - what it happened to.
   * @returns the appended attribution record.
   */
  attribute(actor: string, action: string, target: string): FleetAuditRecord {
    if (!this.profiles.has(actor)) {
      throw new Error(`fleet-agent: cannot attribute an action to unregistered actor "${actor}"`)
    }
    const signed = this.sign({ type: 'fleet/audit', actor, payload: { action, target } })
    return this.ledger.append(actor, action, target, signed)
  }

  /**
   * Attribution records, most recent last.
   * @param agentId - when given, only records for that actor.
   * @returns matching records.
   */
  audit(agentId?: string): FleetAuditRecord[] {
    return this.ledger.list(agentId)
  }

  private loadProfiles(): void {
    let text: string
    try {
      text = readFileSync(this.profilesFile, 'utf8')
    } catch {
      return
    }
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const [agentId, raw] of Object.entries(parsed)) {
      const record = raw as Record<string, unknown>
      if (typeof record?.publicKey === 'string' && typeof record?.name === 'string') {
        this.profiles.set(agentId, {
          agentId,
          name: record.name,
          role: typeof record.role === 'string' ? record.role : 'agent',
          claimRole: stringOrUndefined(record.claimRole),
          cwd: stringOrUndefined(record.cwd),
          tier: stringOrUndefined(record.tier),
          provider: stringOrUndefined(record.provider),
          model: stringOrUndefined(record.model),
          promptFile: stringOrUndefined(record.promptFile),
          avatar: stringOrUndefined(record.avatar),
          enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
          status: typeof record.status === 'string' ? record.status : 'active',
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
          publicKey: record.publicKey,
        })
      }
    }
  }

  private persistProfiles(): void {
    mkdirSync(dirname(this.profilesFile), { recursive: true })
    const payload = Object.fromEntries([...this.profiles].map(([agentId, profile]) => [agentId, profile]))
    const tmp = `${this.profilesFile}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: PROFILE_STORE_MODE })
    chmodSync(tmp, PROFILE_STORE_MODE)
    renameSync(tmp, this.profilesFile)
    chmodSync(this.profilesFile, PROFILE_STORE_MODE)
  }

  private mirrorAuditToSession(record: FleetAuditRecord): void {
    const sessions = this.ctx.sessions
    if (sessions === undefined) return
    const session = sessions.get(SessionId(record.actor))
    if (session === undefined) return
    session.append('fleet/audit', {
      seq: record.seq,
      actor: record.actor,
      action: record.action,
      target: record.target,
      sig: record.signed.sig,
      pubkey: record.signed.pubkey,
    })
  }
}

/** A persisted string field that may be absent (the "no override" signal). */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Resolve the agent preset from the scope chain (composedPreset) — available at
 * agent/created time because the preset mount happens in setup before publication.
 * Falls back to session header for backward compatibility. Returns undefined
 * when no preset service is composed or the agent joined none.
 *
 * This helper lives in service.ts (not index.ts) to satisfy the inject lint:
 * ctx.get in non-apply-entry files is the sanctioned optional-service pattern.
 */
export function resolveAgentPreset(agentCtx: Context, sessionHeader: { agentPreset?: string } | undefined): string | undefined {
  // Guard: some test contexts (mock objects) may not have get().
  const getter = (agentCtx as unknown as { get?: (name: string) => unknown }).get
  if (getter === undefined) return sessionHeader?.agentPreset
  const presets = getter.call(agentCtx, 'agentPresets') as
    | { composedPreset: (ctx: Context) => string | undefined }
    | undefined
  return presets?.composedPreset(agentCtx) ?? sessionHeader?.agentPreset
}
