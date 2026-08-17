/**
 * fleet-watchdog vocabulary (issue #26, orchestration-v3 §4 P2.4, #28).
 *
 * The verification gate on stopped work (paperclip Task Watchdog): when every
 * leaf of a watched task tree rests (Completed/Cancelled), the watchdog
 * verifies the stop against evidence — structurally, with NO LLM calls:
 * contract present? evidence non-empty? metric in passRange? A false "done"
 * is REJECTED: the leaf reopens, a marked review task is created under it, and
 * it is reassigned (org-chart role routing) so a live path is restored.
 *
 * Self-trigger guard (#28): the watchdog review task is created via
 * fleet-tasks with the `watchdog-review` claimRole marker, which flows through
 * its goal ancestry — any task whose ancestry contains a review task is
 * excluded from the watched subtree, the task-space analog of the bus's
 * `excludeOriginKinds` mechanism separation.
 *
 * Stop-fingerprint reuse (#28): when a tree rests, a fingerprint over the
 * stopped leaf set + contracts is computed and published with the
 * `fleet/watchdog-stopped` event; an identical stopped state within
 * `reverifyWindowMs` is not re-verified (fleet-bus wake-dedupe semantics).
 * @module @hydra/dsh-fleet-watchdog/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { FleetTaskArtifactContract } from '../../fleet-tasks/src/types.ts'

/** Lifecycle of one watched task tree. */
export type WatchdogWatchStatus = 'watching' | 'verifying' | 'verified' | 'rejected'

/**
 * Per-leaf verification verdict. `PASS` = genuine done (or a legitimate
 * cancellation / no-contract stop); `REJECT` = false "done" (contract present
 * but evidence missing or the metric is out of the pass range); `SKIP` = the
 * leaf left the terminal set mid-verification.
 */
export type WatchdogVerdict = 'PASS' | 'REJECT' | 'SKIP'

/** One leaf of a watched tree as the watchdog sees it (state + contract). */
export interface WatchdogLeafView {
  readonly taskId: string
  readonly state: string
  readonly assignee?: string
  readonly claimRole?: string
  readonly artifactContract?: FleetTaskArtifactContract
  readonly verdict?: WatchdogVerdict
  readonly reason?: string
}

/**
 * One watched task tree: the `treeRootId` (top-level goal), its lifecycle
 * status, and the fingerprint / timestamps that implement the #28
 * stop-fingerprint re-verification dedupe.
 */
export interface WatchRecord {
  /** The top-level goal id of the watched tree. */
  readonly treeRootId: string
  status: WatchdogWatchStatus
  /** Unix epoch ms (service clock) the tree was put under watch. */
  readonly createdAt: number
  /**
   * Stop-fingerprint (#28): SHA-256 over the stopped leaf set + contracts.
   * An identical stopped state within `reverifyWindowMs` is not re-verified.
   */
  stoppedFingerprint?: string
  /** Unix epoch ms the tree was last observed at rest. */
  lastStoppedAt?: number
  /** Unix epoch ms the tree last passed verification. */
  lastVerifiedAt?: number
  verifiedAt?: number
  rejectedAt?: number
  /** Leaf views from the most recent verification pass. */
  leaves?: WatchdogLeafView[]
  lastVerdict?: 'PASS' | 'REJECT'
  lastReason?: string
}

/** One leaf verdict from a verification pass. */
export interface WatchdogLeafResult {
  readonly taskId: string
  readonly state: string
  readonly verdict: WatchdogVerdict
  readonly reason?: string
}

/** The outcome of `watch(treeRootId)` / `verify(treeRootId)`. */
export interface WatchdogVerifyResult {
  readonly treeRootId: string
  /** True when every (non-review) leaf of the tree is terminal. */
  readonly rested: boolean
  /** True when an identical stopped state was skipped within the window. */
  readonly suppressed?: boolean
  /** Why nothing happened (e.g. suppressed / not watched). */
  readonly reason?: string
  /** The stop-fingerprint of the resting tree, when rested. */
  readonly stoppedFingerprint?: string
  /** Per-leaf views + verdicts from the pass. */
  readonly leaves: WatchdogLeafView[]
  /** PASS when every leaf verified; REJECT when any leaf was false-done. */
  readonly verdict?: 'PASS' | 'REJECT'
  /** The false-done leaves this pass reopened + reassigned. */
  readonly rejected?: Array<{ taskId: string; reason: string }>
}

/** JSON-safe summary of a leaf's artifact evidence (for events/feeds). */
export function watchdogEvidenceSummary(contract: FleetTaskArtifactContract | undefined, evidence: { result: string | number | boolean } | undefined): JsonValue {
  const summary: Record<string, JsonValue> = {}
  if (contract !== undefined) {
    summary.metric = contract.metric
    summary.passRange = contract.passRange
    summary.expectedResult = contract.expectedResult
  }
  if (evidence !== undefined) summary.actual = evidence.result
  return summary
}
