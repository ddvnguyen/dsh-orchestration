/**
 * fleet-policy vocabulary (issue #26, orchestration-v3 §4 P3.1).
 *
 * The QM posture + command-policy layer: every fleet action (a shell command,
 * a git op, a path mutation) is evaluated against a per-identity / per-context
 * posture and a rule set. The posture ladder maps to the classic QM /
 * permission modes:
 *
 * - `Strict` — deny-by-default: an action is allowed ONLY when it matches an
 *   allowlist rule (and never when it matches a hard denial).
 * - `Auto` — routine-safe by default: hard denials AND soft denials block the
 *   action; everything else is allowed.
 * - `Dangerous` — only the hard denials block (soft denials are permitted);
 *   the operator explicitly opted out of the confirmation layer.
 *
 * **Hard denials** (`strength: 'hard'`, the default for deny rules) apply in
 * EVERY posture — they are the "command policy hard denials" of the brief
 * (destructive commands / protected paths). **Soft denials**
 * (`strength: 'soft'`) apply in Auto (and Strict, which denies everything not
 * allowlisted anyway) but are PERMITTED in Dangerous. Allowlist rules are only
 * consulted under Strict.
 *
 * The acceptance surface: `authorize()` on the service REFUSES a denied action
 * (throws {@link PolicyDeniedError}) AND publishes `fleet/policy-denied` with
 * the rule + actor — a denied action is BLOCKED, with an audit trail.
 * @module @hydra/dsh-fleet-policy/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** The QM posture ladder: deny-by-default → routine-safe → only hard denials. */
export type PolicyPosture = 'Strict' | 'Auto' | 'Dangerous'

/** What a rule matches against. */
export type PolicyRuleKind =
  /** Exact command name (e.g. `rm`, `dd`, `shutdown`). */
  | 'command'
  /** Leading tokens of the command line (e.g. `git push`, `rm`). */
  | 'command-prefix'
  /** A path prefix the action targets (e.g. `/etc`, `/boot`). */
  | 'path-prefix'

/** Whether a rule permits or blocks. */
export type PolicyRuleMode = 'deny' | 'allow'

/**
 * One command-policy rule.
 *
 * `command` / `command-prefix` rules match the command line (built from
 * `command` + `args`); an optional `argPattern` (regex over the FULL line) can
 * narrow them (e.g. `git push` + `-f|--force`). `path-prefix` rules match the
 * resolved target path; an optional `commandPattern` (regex over the command
 * name) scopes them to mutating commands so reads of a protected path are not
 * denied.
 */
export interface PolicyRule {
  /** Stable rule id (surfaced in `fleet/policy-denied` events + denials). */
  readonly id: string
  readonly mode: PolicyRuleMode
  readonly kind: PolicyRuleKind
  /** Match target: command name, command-line prefix, or path prefix. */
  readonly value: string
  /** Regex over the full command line (command / command-prefix rules). */
  readonly argPattern?: string
  /** Regex over the command name (path-prefix rules; only mutating commands). */
  readonly commandPattern?: string
  /**
   * deny rules: `hard` applies in every posture (default); `soft` applies in
   * Auto but is permitted under Dangerous. Irrelevant for allow rules.
   */
  readonly strength?: 'hard' | 'soft'
  /** Human reason, carried into events + denials. */
  readonly reason: string
}

/** Who a posture applies to: the whole context (default) or one identity. */
export type PolicyScope =
  | { kind: 'context' }
  | { kind: 'identity'; agentId: string }

/** The action under evaluation. */
export interface PolicyEvalInput {
  /** The acting agent id (carried into `fleet/policy-denied`). */
  readonly actor: string
  /** The command name (e.g. `rm`, `git`). */
  readonly command: string
  /** Command arguments (e.g. `['push', '--force']`). */
  readonly args?: readonly string[]
  /** Working directory, used to resolve a relative target path. */
  readonly cwd?: string
  /** The path the action targets (for path-prefix rules); else derived from args. */
  readonly path?: string
}

/** The outcome of evaluating one action against the posture + rules. */
export interface PolicyDecision {
  /** True = the action may proceed; false = BLOCKED (service refuses). */
  readonly allowed: boolean
  /** The effective posture the decision was made under. */
  readonly posture: PolicyPosture
  /** The rule that decided the outcome (deny rule, or the allow rule in Strict). */
  readonly rule?: PolicyRule
  /** Why: the rule reason, or a posture-level explanation. */
  readonly reason: string
}

/** The full posture state surfaced by `policy_get_posture`. */
export interface PolicyStatus {
  /** The context-wide (default) posture. */
  readonly context: PolicyPosture
  /** Per-identity posture overrides, keyed by agent id. */
  readonly identities: Record<string, PolicyPosture>
  /** The active rule set. */
  readonly rules: readonly PolicyRule[]
}

/** Thrown by `authorize()` on a denied action — the refusal that BLOCKS it. */
export class PolicyDeniedError extends Error {
  /** The decision that produced the denial (rule + reason for the trail). */
  readonly decision: PolicyDecision

  constructor(decision: PolicyDecision) {
    super(`fleet-policy: ${decision.reason}`)
    this.name = 'PolicyDeniedError'
    this.decision = decision
  }
}

/** JSON-safe view of a rule for events / tool output. */
export function policyRuleToJson(rule: PolicyRule): JsonValue {
  return {
    id: rule.id,
    mode: rule.mode,
    kind: rule.kind,
    value: rule.value,
    reason: rule.reason,
    ...(rule.argPattern !== undefined ? { argPattern: rule.argPattern } : {}),
    ...(rule.commandPattern !== undefined ? { commandPattern: rule.commandPattern } : {}),
    ...(rule.strength !== undefined ? { strength: rule.strength } : {}),
  }
}
