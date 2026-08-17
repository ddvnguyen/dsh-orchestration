/**
 * Trigger-state fingerprinting for fleet-bus wake dedupe (issue #26 + #28).
 *
 * A subscriber that opts into wake dedupe is not re-woken for an identical
 * trigger state within its configured window. The fingerprint is the SHA-256
 * of the canonical JSON serialization of the TRIGGER-RELEVANT fields only —
 * a publisher computes it over the fields that actually produced the wake
 * (e.g. the stopped-leaf set + config), NOT the full payload. When an event
 * carries no explicit fingerprint, the bus falls back to hashing the full
 * payload at delivery time (still deterministic, still dedupes byte-identical
 * publishes).
 * @module @hydra/dsh-fleet-bus/fingerprint
 */

import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'

/**
 * Serialize a JSON value deterministically (objects keyed in byte order, no
 * insignificant whitespace). Deterministic within this implementation, which
 * is all a fingerprint needs: the same trigger state always yields the same
 * canonical form.
 * @param value - any JSON-safe value.
 * @returns the canonical serialization.
 * @throws when a number is non-finite (cannot be hashed deterministically).
 */
export function canonicalJson(value: JsonValue): string {
  return serialize(value)
}

/**
 * Compute the SHA-256 hex fingerprint of a trigger-state value.
 * @param triggerState - the trigger-relevant fields to hash (or a full payload
 *   when the publisher does not scope the fingerprint).
 * @returns lowercase hex SHA-256 digest.
 */
export function computeFingerprint(triggerState: JsonValue): string {
  return createHash('sha256').update(canonicalJson(triggerState), 'utf8').digest('hex')
}

function serialize(value: JsonValue): string {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('fleet-bus: cannot fingerprint a non-finite number')
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
  throw new Error('fleet-bus: cannot fingerprint a non-JSON value')
}
