/**
 * FleetPolicyService — the `ctx.fleetPolicy` Cordis service behind the
 * fleet-policy plugin (issue #26, orchestration-v3 §4 P3.1).
 *
 * The QM posture + command-policy layer: every fleet action is evaluated
 * against a per-identity / per-context posture (Strict/Auto/Dangerous) and a
 * rule set. The posture ladder (from {@link PolicyPosture}):
 *
 * - `Strict` — deny-by-default: allowed ONLY on an allowlist match.
 * - `Auto` — routine-safe by default: hard + soft denials block; else allowed.
 * - `Dangerous` — only the HARD denials block; soft denials are permitted.
 *
 * **Hard denials** (default deny strength) apply in EVERY posture — destructive
 * commands (force-push, reset --hard, mkfs/dd/shutdown/reboot/…) and mutating
 * commands on protected paths (/etc, /boot, /root). **Soft denials** apply in
 * Auto but are permitted under Dangerous.
 *
 * The acceptance surface (this is the "denied action blocked" contract):
 * - {@link evaluate} — the pure decision (pre-flight; no side effects).
 * - {@link authorize} — the ENFORCEMENT seam: on a denial it REFUSES the
 *   action (throws {@link PolicyDeniedError}, so a caller wired through it
 *   cannot proceed) and publishes `fleet/policy-denied` (rule + actor) so the
 *   refusal is auditable on the bus. On allow it returns the decision.
 *
 * Seams (all optional via `ctx.get`, the AGENTS.md optional-service rule):
 * - `fleetBus`      — the event surface (fleet/policy-denied, fleet/policy-updated).
 *   Absent → events dropped (debug log).
 * - `fleetAgent` — ed25519 signing of published events (best-effort).
 * @module @hydra/dsh-fleet-policy/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute, resolve, sep } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { systemClock, type FleetClock } from '../../../src/types.ts'
import type {
  PolicyDecision,
  PolicyEvalInput,
  PolicyPosture,
  PolicyRule,
  PolicyScope,
  PolicyStatus,
} from './types.ts'
import { PolicyDeniedError } from './types.ts'

/** Actor + mechanism label for every policy-produced event. */
export const POLICY_ACTOR = 'policy'
export const POLICY_ORIGIN_KIND = 'policy'
/** Bus event types the policy layer publishes. */
export const POLICY_EVENT_TYPES = {
  denied: 'fleet/policy-denied',
  updated: 'fleet/policy-updated',
} as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetPolicy: FleetPolicyService
  }

  interface Events {
    /**
     * One policy decision occurred (an action denied / a posture updated).
     * Emitted synchronously after the optional fleet-bus publish, so
     * in-process observers get the decision even when no bus is composed.
     * @param info - the decision type + the acting agent + a JSON-safe payload.
     * @mode emit
     */
    'fleet-policy/event'(info: { type: string; actor: string; payload: JsonValue }): void
  }
}

/** Structural fleet-bus surface (avoids importing the concrete service). */
export interface FleetBusLike {
  publish(input: {
    type: string
    scope: 'agent' | 'team' | 'fleet'
    actor: string
    originKind: string
    payload: JsonValue
  }): unknown
}

/** Structural fleet-agent surface for optional event signing. */
export interface FleetAgentLike {
  sign(input: { type: string; actor: string; payload: JsonValue; ts?: number }): { sig: string; pubkey: string }
}

export interface FleetPolicyConfig {
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock?: FleetClock
  /**
   * The context-wide (default) posture. Default `Auto` — routine-safe, with
   * hard + soft denials enforced.
   */
  defaultPosture?: PolicyPosture
  /**
   * The active rule set. Defaults to {@link DEFAULT_POLICY_RULES} (the hard
   * denials + Strict allowlist the brief names). Callers may replace/extend it.
   */
  rules?: readonly PolicyRule[]
}

/**
 * The default command policy: hard denials (destructive commands + protected
 * paths, applied in EVERY posture), one soft denial (`rm -rf`, Auto-only), and
 * a small Strict allowlist. Customize via `config.rules`; ids are stable so
 * `fleet/policy-denied` events are greppable.
 */
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = [
  // ---- hard denials: destructive command lines (every posture) ----
  { id: 'deny-git-force-push', mode: 'deny', kind: 'command-prefix', value: 'git push', argPattern: '(^|\\s)(-f|--force)\\b|--force-with-lease', reason: 'force-push rewrites shared history — irreversible' },
  { id: 'deny-git-reset-hard', mode: 'deny', kind: 'command-prefix', value: 'git reset --hard', reason: 'discards committed work without a trace' },
  { id: 'deny-git-clean', mode: 'deny', kind: 'command-prefix', value: 'git clean', reason: 'permanently deletes untracked files' },
  { id: 'deny-git-checkout-overwrite', mode: 'deny', kind: 'command-prefix', value: 'git checkout --', reason: 'overwrites working-tree changes' },
  { id: 'deny-destructive-mkfs', mode: 'deny', kind: 'command', value: 'mkfs', reason: 'destructive system command (filesystem format)' },
  { id: 'deny-destructive-dd', mode: 'deny', kind: 'command', value: 'dd', reason: 'raw device copy — can wipe disks' },
  { id: 'deny-destructive-shutdown', mode: 'deny', kind: 'command', value: 'shutdown', reason: 'halts the host' },
  { id: 'deny-destructive-reboot', mode: 'deny', kind: 'command', value: 'reboot', reason: 'reboots the host' },
  { id: 'deny-destructive-poweroff', mode: 'deny', kind: 'command', value: 'poweroff', reason: 'powers off the host' },
  { id: 'deny-destructive-halt', mode: 'deny', kind: 'command', value: 'halt', reason: 'halts the host' },
  // ---- hard denials: mutating commands on protected system paths ----
  { id: 'deny-write-etc', mode: 'deny', kind: 'path-prefix', value: '/etc', commandPattern: '^(rm|mv|chmod|chown|mkfs|dd|shred|tee)', reason: 'system configuration paths are off-limits to fleet agents' },
  { id: 'deny-write-boot', mode: 'deny', kind: 'path-prefix', value: '/boot', commandPattern: '^(rm|mv|chmod|chown|mkfs|dd|shred|tee)', reason: 'the boot partition is off-limits' },
  { id: 'deny-write-root-home', mode: 'deny', kind: 'path-prefix', value: '/root', commandPattern: '^(rm|mv|chmod|chown|mkfs|dd|shred|tee)', reason: 'the root home is off-limits' },
  // ---- soft denial (Auto only; permitted under Dangerous) ----
  { id: 'deny-rm-recursive', mode: 'deny', kind: 'command-prefix', value: 'rm', argPattern: '\\s(-rf|-r -f|-f -r)\\b', strength: 'soft', reason: 'recursive force delete — verify the target path' },
  // ---- Strict allowlist (consulted ONLY under Strict; deny-by-default) ----
  { id: 'allow-readonly-ls', mode: 'allow', kind: 'command', value: 'ls', reason: 'list a directory (read-only)' },
  { id: 'allow-readonly-cat', mode: 'allow', kind: 'command', value: 'cat', reason: 'read a file (read-only)' },
  { id: 'allow-readonly-pwd', mode: 'allow', kind: 'command', value: 'pwd', reason: 'print the working directory (read-only)' },
  { id: 'allow-git-status', mode: 'allow', kind: 'command-prefix', value: 'git status', reason: 'inspect repository state (read-only)' },
  { id: 'allow-git-log', mode: 'allow', kind: 'command-prefix', value: 'git log', reason: 'inspect history (read-only)' },
  { id: 'allow-git-diff', mode: 'allow', kind: 'command-prefix', value: 'git diff', reason: 'inspect changes (read-only)' },
]

/** The posture ladder: hard denials are the constant; the rest follow posture. */
function softDeniesApply(posture: PolicyPosture): boolean {
  return posture === 'Auto'
}

export class FleetPolicyService extends Service {
  private readonly clock: FleetClock
  private readonly rules: readonly PolicyRule[]
  private readonly defaultPosture: PolicyPosture
  /** Scope → posture overrides (context default + per-identity). */
  private readonly postures = new Map<string, PolicyPosture>()
  /** Compiled rule regexes (argPattern / commandPattern), cached per pattern. */
  private readonly regexCache = new Map<string, RegExp>()

  constructor(ctx: Context, config: FleetPolicyConfig = {}) {
    super(ctx, 'fleetPolicy')
    this.clock = config.clock ?? systemClock
    this.defaultPosture = config.defaultPosture ?? 'Auto'
    this.rules = config.rules ?? DEFAULT_POLICY_RULES
  }

  // ---- posture ----

  /**
   * Set the posture for a scope (context default, or one identity). Publish
   * `fleet/policy-updated` (originKind 'policy') when a bus is composed.
   * @returns the newly effective posture.
   * @throws on an unknown posture.
   */
  setPosture(scope: PolicyScope, posture: PolicyPosture, actor: string): PolicyPosture {
    if (!isPolicyPosture(posture)) {
      throw new Error(`fleet-policy: unknown posture "${String(posture)}" (expected Strict | Auto | Dangerous)`)
    }
    const key = scopeKey(scope)
    if (scope.kind === 'context') this.postures.set('context', posture)
    else this.postures.set(key, posture)

    const payload: Record<string, JsonValue> = {
      scope: scope.kind === 'context' ? 'context' : 'identity',
      posture,
      changedBy: actor,
    }
    if (scope.kind === 'identity') payload.agentId = scope.agentId
    this.publishEvent(POLICY_EVENT_TYPES.updated, payload, actor)
    return posture
  }

  /**
   * Resolve the effective posture: the identity override when set, else the
   * context override, else the configured default (`Auto`).
   */
  getPosture(scope: PolicyScope): PolicyPosture {
    if (scope.kind === 'identity') {
      const identity = this.postures.get(scopeKey(scope))
      if (identity !== undefined) return identity
    }
    return this.postures.get('context') ?? this.defaultPosture
  }

  /** The posture state (context default + identity overrides + rules). */
  status(): PolicyStatus {
    const identities: Record<string, PolicyPosture> = {}
    for (const [key, posture] of this.postures) {
      if (key.startsWith('identity:')) identities[key.slice('identity:'.length)] = posture
    }
    return { context: this.getPosture({ kind: 'context' }), identities, rules: this.rules }
  }

  /** The active rule set (tool + tests). */
  listRules(): readonly PolicyRule[] {
    return this.rules
  }

  // ---- decision ----

  /**
   * The pure decision for one action — no side effects (pre-flight).
   *
   * Hard denials decide first (every posture); under `Strict` the action must
   * additionally match an allowlist rule; under `Auto` soft denials block too;
   * under `Dangerous` only hard denials block. Returns `{ allowed: true }` or
   * `{ allowed: false, rule, reason }` — callers use {@link authorize} to
   * actually ENFORCE (refuse + event) a denial.
   */
  evaluate(input: PolicyEvalInput): PolicyDecision {
    const posture = this.getPosture({ kind: 'identity', agentId: input.actor })
    const line = buildCommandLine(input.command, input.args)
    const target = resolveTargetPath(input)

    let hardDeny: PolicyRule | undefined
    let softDeny: PolicyRule | undefined
    let allow: PolicyRule | undefined
    for (const rule of this.rules) {
      if (!this.matchesRule(rule, input, line, target)) continue
      if (rule.mode === 'deny') {
        if (rule.strength === 'soft') {
          if (softDeny === undefined) softDeny = rule
        } else if (hardDeny === undefined) {
          hardDeny = rule
        }
      } else if (allow === undefined) {
        allow = rule
      }
    }

    if (hardDeny !== undefined) {
      return { allowed: false, posture, rule: hardDeny, reason: hardDeny.reason }
    }
    if (posture === 'Strict') {
      if (allow !== undefined) {
        return { allowed: true, posture, rule: allow, reason: `allowed under Strict by "${allow.id}"` }
      }
      return { allowed: false, posture, reason: 'Strict posture: the command is not on the allowlist' }
    }
    if (softDeniesApply(posture) && softDeny !== undefined) {
      return { allowed: false, posture, rule: softDeny, reason: softDeny.reason }
    }
    const mode = posture === 'Dangerous' ? 'Dangerous posture: only hard denials apply' : 'Auto posture: routine-safe by default'
    return { allowed: true, posture, reason: `allowed under ${mode}` }
  }

  /**
   * The ENFORCEMENT seam (the "denied action blocked" acceptance): the pure
   * decision PLUS — on a denial — the refusal. `fleet/policy-denied` (rule +
   * actor) is published and a {@link PolicyDeniedError} is thrown, so a caller
   * that routes an action through `authorize` CANNOT proceed past a denial.
   * @returns the decision when the action is allowed.
   * @throws {PolicyDeniedError} when the action is denied (BLOCKED).
   */
  authorize(input: PolicyEvalInput): PolicyDecision {
    const decision = this.evaluate(input)
    if (decision.allowed) return decision
    this.emitDenied(input, decision)
    throw new PolicyDeniedError(decision)
  }

  // ---- internals ----

  /** Does a rule fire against this action? */
  private matchesRule(rule: PolicyRule, input: PolicyEvalInput, line: string, target: string | undefined): boolean {
    switch (rule.kind) {
      case 'command':
        if (input.command !== rule.value) return false
        return rule.argPattern === undefined || this.regex(rule.argPattern).test(line)
      case 'command-prefix':
        if (line !== rule.value && !line.startsWith(`${rule.value} `)) return false
        return rule.argPattern === undefined || this.regex(rule.argPattern).test(line)
      case 'path-prefix': {
        if (rule.commandPattern !== undefined && !this.regex(rule.commandPattern).test(input.command)) return false
        return target !== undefined && isPathUnder(target, rule.value)
      }
    }
  }

  /** Compile (and cache) one rule regex. */
  private regex(pattern: string): RegExp {
    let compiled = this.regexCache.get(pattern)
    if (compiled === undefined) {
      compiled = new RegExp(pattern)
      this.regexCache.set(pattern, compiled)
    }
    return compiled
  }

  /** Publish `fleet/policy-denied` (rule + actor) + the in-process event. */
  private emitDenied(input: PolicyEvalInput, decision: PolicyDecision): void {
    const rule = decision.rule
    const payload: Record<string, JsonValue> = {
      command: input.command,
      posture: decision.posture,
      reason: decision.reason,
      ...(input.args !== undefined && input.args.length > 0 ? { args: input.args as unknown as JsonValue } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(rule !== undefined
        ? { rule: { id: rule.id, kind: rule.kind, value: rule.value, reason: rule.reason } }
        : {}),
    }
    this.publishEvent(POLICY_EVENT_TYPES.denied, payload, input.actor)
  }

  /**
   * Publish a policy event on the fleet-bus (when composed), with
   * `originKind: 'policy'` and `actor` = the acting agent (the one whose action
   * was denied / who changed a posture), plus a `fleet-policy/event` Cordis
   * emit for in-process observers. When a fleetAgent is composed the payload
   * embeds a signed envelope (best-effort; the policy itself never signs).
   */
  private publishEvent(type: string, payload: Record<string, JsonValue>, actor: string): void {
    let body: JsonValue = payload
    const bus = this.ctx.get('fleetBus') as FleetBusLike | undefined
    if (bus !== undefined && typeof bus.publish === 'function') {
      const identity = this.ctx.get('fleetAgent') as FleetAgentLike | undefined
      if (identity !== undefined && typeof identity.sign === 'function') {
        try {
          const signed = identity.sign({ type, actor, payload, ts: this.clock.now() })
          body = { ...payload, signed: signed as unknown as JsonValue }
        } catch (error) {
          this.ctx.logger.debug(
            `fleet-policy: signing ${type} skipped — ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      bus.publish({ type, scope: 'fleet', actor, originKind: POLICY_ORIGIN_KIND, payload: body })
    } else {
      this.ctx.logger.debug(`fleet-policy: no fleet-bus composed; ${type} not published`)
    }
    this.ctx.emit('fleet-policy/event', { type, actor, payload })
  }
}

/** Stable store key for a scope. */
function scopeKey(scope: PolicyScope): string {
  return scope.kind === 'context' ? 'context' : `identity:${scope.agentId}`
}

/** The command line a `command` + `args` list forms. */
function buildCommandLine(command: string, args: readonly string[] | undefined): string {
  if (args === undefined || args.length === 0) return command
  return `${command} ${args.join(' ')}`
}

/**
 * The path an action targets, for path-prefix rules: the explicit `path` when
 * given, else the last non-flag argument (e.g. the directory of `rm -rf dir`),
 * resolved against `cwd` (relative args) and normalized.
 */
function resolveTargetPath(input: PolicyEvalInput): string | undefined {
  const raw = input.path ?? lastNonFlagArg(input.args)
  if (raw === undefined || raw.length === 0) return undefined
  if (raw === '~') return expandTilde('~')
  if (raw.startsWith('~/')) return expandTilde(raw)
  if (isAbsolute(raw)) return normalizePath(raw)
  if (input.cwd !== undefined && input.cwd.length > 0) return normalizePath(resolve(input.cwd, raw))
  return normalizePath(raw)
}

/** The last argument that is not a flag (best-effort mutation target). */
function lastNonFlagArg(args: readonly string[] | undefined): string | undefined {
  if (args === undefined) return undefined
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index]!
    if (arg.startsWith('-')) continue
    return arg
  }
  return undefined
}

function expandTilde(path: string): string {
  const home = process.env.HOME ?? process.env.HOMEDRIVE ?? ''
  if (home.length === 0) return normalizePath(path)
  return normalizePath(path === '~' ? home : `${home}${path.slice(1)}`)
}

/** Normalize separators (no trailing slash except for the root; preserves absolute-ness). */
function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const cleaned = path.split('/').filter(segment => segment.length > 0 && segment !== '.').join('/')
  if (cleaned.length === 0) return sep
  return absolute ? `/${cleaned}` : cleaned
}

/** Segment-aware prefix check: `/etc` matches `/etc/foo`, never `/etcetera`. */
function isPathUnder(target: string, prefix: string): boolean {
  if (target === prefix) return true
  return target.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

function isPolicyPosture(value: unknown): value is PolicyPosture {
  return value === 'Strict' || value === 'Auto' || value === 'Dangerous'
}
