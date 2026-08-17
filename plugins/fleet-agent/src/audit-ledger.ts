/**
 * Fleet-identity attribution ledger: the audit trail of who did what when.
 *
 * Follows the per-agent fleet ledger pattern from fleet-heartbeat
 * (FleetRegistry.append, experiments/dsh-fleet/src/registry.ts:251-263): a
 * monotonic `seq`, a wall time, and an `onAppend` hook the owning service uses
 * to emit a Cordis `fleet/audit` event and mirror the record into a dsh
 * session log. Unlike the fleet heartbeat ledger, every record CARRIES its
 * own ed25519-signed event, so a record's tamper-evidence travels with it.
 *
 * Deliberately free of Cordis/dsh imports so it stays pure and testable.
 * @module @hydra/dsh-fleet-agent/audit-ledger
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** One ed25519-signed event (the fleet-agent wire format). */
export interface FleetSignedEvent {
  /** Event type label (e.g. 'fleet/audit', 'fleet/task/complete'). */
  readonly type: string
  /** The acting agent profile id. */
  readonly actor: string
  /** Arbitrary JSON payload. */
  readonly payload: JsonValue
  /** Unix epoch ms. */
  readonly ts: number
  /** base64 ed25519 signature over canonical({type, actor, payload, ts}). */
  readonly sig: string
  /** base64 SPKI DER ed25519 public key of the actor. */
  readonly pubkey: string
}

/** One attribution record appended to the ledger. */
export interface FleetAuditRecord {
  /** Monotonic global sequence. */
  readonly seq: number
  /** Unix epoch ms (taken from the signed event's ts). */
  readonly time: number
  /** The acting agent profile id. */
  readonly actor: string
  /** What happened (verb, e.g. 'register', 'create_task'). */
  readonly action: string
  /** What it happened to (e.g. agent id, task id, resource). */
  readonly target: string
  /** The signed evidence: tamper-evidence for this exact record. */
  readonly signed: FleetSignedEvent
}

export interface AuditLedgerOptions {
  /** Called synchronously after each append (emit + session mirror). */
  onAppend?: (record: FleetAuditRecord) => void
}

export class AuditLedger {
  private readonly records: FleetAuditRecord[] = []
  private readonly onAppend: ((record: FleetAuditRecord) => void) | undefined

  constructor(options: AuditLedgerOptions = {}) {
    this.onAppend = options.onAppend
  }

  /**
   * Append one attribution record.
   * @param actor - the acting agent profile id.
   * @param action - what happened (verb).
   * @param target - what it happened to.
   * @param signed - the ed25519-signed event carrying tamper evidence.
   * @returns the appended record.
   */
  append(actor: string, action: string, target: string, signed: FleetSignedEvent): FleetAuditRecord {
    const record: FleetAuditRecord = {
      seq: this.records.length,
      time: signed.ts,
      actor,
      action,
      target,
      signed,
    }
    this.records.push(record)
    this.onAppend?.(record)
    return record
  }

  /**
   * Attribution records, most recent last, in seq order.
   * @param agentId - when given, only records for that actor.
   * @returns a copy of the matching records.
   */
  list(agentId?: string): FleetAuditRecord[] {
    if (agentId === undefined) return [...this.records]
    return this.records.filter(record => record.actor === agentId)
  }
}
