/**
 * Fleet-agent key store: one ed25519 keypair per agent profile, persisted
 * under `$DSH_HOME/fleet/agent/keys.json` with 0600 permissions.
 *
 * Location follows dsh's harness-home convention (resolveDshHome:
 * `$DSH_HOME` > `~/.dsh`, packages/util/home-paths/src/index.ts:87-91), the
 * same root anonymous-user-id persists under — but scoped to a `fleet/`
 * directory so the fleet plugin family owns its data. Private keys are
 * stored as base64 PKCS8 DER, public keys as base64 SPKI DER.
 *
 * SECURITY: the key store never logs, emits, or exposes private keys — the
 * public surface (`publicKeyOf`, `sign`, `verify`) returns only public key
 * material and signatures. Key material is loaded once per process and kept
 * in memory as node KeyObjects.
 *
 * Generated with node:crypto only (`generateKeyPairSync('ed25519')`), per the
 * issue #26 constraint: no external crypto dependencies.
 *
 * BOOT MIGRATION (owner decision 2026-08-16): the plugin was renamed
 * fleet-identity → fleet-agent and its store moved from `$DSH_HOME/fleet/identity/`
 * to `$DSH_HOME/fleet/agent/`. On construction, when the legacy `fleet/identity/`
 * directory exists and `fleet/agent/` does not, the directory is moved (keys
 * and profiles preserved). When both exist the legacy dir is left untouched.
 * @module @hydra/dsh-fleet-agent/key-store
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** One persisted keypair, base64 DER encodings. Private key is never exported. */
export interface StoredKeyPair {
  /** base64 SPKI DER ed25519 public key. */
  publicKey: string
  /** base64 PKCS8 DER ed25519 private key. */
  privateKey: string
}

export interface KeyStoreOptions {
  /** Override the resolved DSH_HOME (test seam; defaults to resolveDshHome()). */
  home?: string
  /** Environment consulted for DSH_HOME; defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

/** Filesystem mode for the private key store: owner read/write only. */
export const KEY_STORE_MODE = 0o600

/** Subdirectory below the harness home holding fleet data. */
export const FLEET_DATA_DIR = 'fleet'

/** Current agent store dir below the fleet data dir. */
export const FLEET_AGENT_DIR = join(FLEET_DATA_DIR, 'agent')

/**
 * Legacy fleet-identity store dir. The 2026-08-16 rename (fleet-identity →
 * fleet-agent) moved the store from `fleet/identity/` to `fleet/agent/`; this
 * constant drives the one-time boot migration in {@link Ed25519KeyStore}.
 */
export const LEGACY_FLEET_IDENTITY_DIR = join(FLEET_DATA_DIR, 'identity')

/** File name of the private key store inside the agent dir. */
export const KEY_STORE_FILE = 'keys.json'

export class Ed25519KeyStore {
  private readonly file: string
  private readonly keys = new Map<string, StoredKeyPair>()
  private readonly objects = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>()

  constructor(options: KeyStoreOptions = {}) {
    const home = options.home ?? resolveDshHome(undefined, options.env ?? process.env)
    migrateLegacyIdentityDir(home)
    this.file = join(home, FLEET_AGENT_DIR, KEY_STORE_FILE)
    this.load()
  }

  /** Whether a keypair exists for the agent. */
  has(agentId: string): boolean {
    return this.keys.has(agentId)
  }

  /** The stored pair (public key only use); `undefined` when absent. */
  get(agentId: string): StoredKeyPair | undefined {
    return this.keys.get(agentId)
  }

  /** Public key (base64 SPKI DER) for an agent; `undefined` when absent. */
  publicKeyOf(agentId: string): string | undefined {
    return this.keys.get(agentId)?.publicKey
  }

  /**
   * Return the stored keypair or generate + persist a fresh ed25519 one.
   * Idempotent: repeated calls never rotate an existing key.
   * @param agentId - the owning agent profile id.
   * @returns the stored keypair.
   */
  ensure(agentId: string): StoredKeyPair {
    const existing = this.keys.get(agentId)
    if (existing !== undefined) return existing
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const stored: StoredKeyPair = {
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    }
    this.keys.set(agentId, stored)
    this.objects.set(agentId, {
      privateKey: createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: Buffer.from(stored.publicKey, 'base64'), format: 'der', type: 'spki' }),
    })
    this.persist()
    return stored
  }

  /**
   * Sign data with an agent's private key.
   *
   * Ed25519 is an internally-hashing algorithm, so node's streaming Sign API
   * rejects a digest (`Invalid digest`); the `null` algorithm form of
   * `crypto.sign` is the documented Ed25519 path.
   * @param agentId - the owning agent (must have a keypair).
   * @param data - the bytes to sign (already canonicalized).
   * @returns the raw ed25519 signature.
   */
  sign(agentId: string, data: Buffer): Buffer {
    const key = this.keyObject(agentId).privateKey
    return ed25519Sign(null, data, key)
  }

  /**
   * Verify an ed25519 signature against a supplied public key.
   * @param publicKey - base64 SPKI DER public key (from the signed event).
   * @param data - the bytes that were signed.
   * @param signature - the raw signature bytes.
   * @returns whether the signature is valid for the key and data.
   */
  verify(publicKey: string, data: Buffer, signature: Buffer): boolean {
    try {
      const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
      return ed25519Verify(null, data, key, signature)
    } catch {
      // An unparseable public key is treated as an invalid signature.
      return false
    }
  }

  private keyObject(agentId: string): { privateKey: KeyObject; publicKey: KeyObject } {
    const existing = this.objects.get(agentId)
    if (existing !== undefined) return existing
    const stored = this.keys.get(agentId)
    if (stored === undefined) throw new Error(`fleet-agent: no keypair for agent "${agentId}"`)
    const objects = {
      privateKey: createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: Buffer.from(stored.publicKey, 'base64'), format: 'der', type: 'spki' }),
    }
    this.objects.set(agentId, objects)
    return objects
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      // Absent store: start empty; the first ensure() creates + persists it.
      return
    }
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const [agentId, raw] of Object.entries(parsed)) {
      const pair = raw as { publicKey?: unknown; privateKey?: unknown }
      if (typeof pair?.publicKey === 'string' && typeof pair?.privateKey === 'string') {
        this.keys.set(agentId, { publicKey: pair.publicKey, privateKey: pair.privateKey })
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.keys), null, 2)}\n`, { encoding: 'utf8', mode: KEY_STORE_MODE })
    chmodSync(tmp, KEY_STORE_MODE)
    renameSync(tmp, this.file)
    chmodSync(this.file, KEY_STORE_MODE)
  }
}

/**
 * One-time backward-compat migration (owner decision 2026-08-16): move the
 * legacy `$DSH_HOME/fleet/identity/` store (keys.json + profiles.json) to
 * `$DSH_HOME/fleet/agent/` so existing keys survive the fleet-identity →
 * fleet-agent rename. Runs only when the legacy dir exists AND the new dir
 * does not — both present is treated as an already-migrated deployment and
 * the legacy dir is left untouched. A failed move (e.g. cross-device rename)
 * logs nothing but is re-attempted on the next boot.
 */
export function migrateLegacyIdentityDir(home: string): void {
  const legacy = join(home, LEGACY_FLEET_IDENTITY_DIR)
  const current = join(home, FLEET_AGENT_DIR)
  if (!existsSync(legacy) || existsSync(current)) return
  try {
    renameSync(legacy, current)
  } catch {
    // Leave the legacy dir in place; a later boot will retry the migration.
  }
}
