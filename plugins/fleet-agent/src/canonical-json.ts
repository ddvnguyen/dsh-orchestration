/**
 * Deterministic canonical JSON serialization for fleet-agent signing.
 *
 * The signing format is OUR OWN (owner decision #1 in docs/orchestration-v3.md:
 * own ed25519-signed events now, Nostr export bridge deferred to P3.4). The
 * serialized form follows the JSON Canonicalization Scheme (RFC 8785) intent —
 * objects keyed in byte order, no insignificant whitespace, no key
 * reordering surprises — WITHOUT claiming RFC 8785 compliance for unicode
 * (string escaping uses the host `JSON.stringify`, which keeps non-ASCII
 * literal; that is deterministic within this implementation, which is all the
 * verifier requires: signer and verifier share this function).
 *
 * Non-finite numbers are rejected rather than coerced (JSON.stringify would
 * silently emit `null`), so a payload that cannot be signed deterministically
 * fails loudly at sign time instead of verifying against a different form.
 * @module @hydra/dsh-fleet-agent/canonical-json
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/**
 * Serialize a JSON value into its canonical string form.
 * @param value - any JSON-safe value.
 * @returns the canonical serialization.
 * @throws when a value is not JSON-safe (undefined / function / symbol) or a
 * number is non-finite.
 */
export function canonicalJson(value: JsonValue): string {
  return serialize(value)
}

function serialize(value: JsonValue): string {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('fleet-agent: cannot canonicalize a non-finite number')
    }
    return String(value)
  }
  if (type === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  if (type === 'object') {
    const record = value as Record<string, JsonValue>
    const keys = Object.keys(record).sort()
    const entries = keys.map(key => `${JSON.stringify(key)}:${serialize(record[key])}`)
    return `{${entries.join(',')}}`
  }
  throw new Error('fleet-agent: cannot canonicalize a non-JSON value')
}
