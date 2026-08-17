/**
 * @hydra/dsh-fleet-extras — the V3 hcom borrow: workspace watch + subscribe +
 * 30 s collision detection (issue #26, orchestration-v3 §4 P3.3).
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`). It constructs the
 * {@link FleetExtrasService} (registers `ctx.fleetExtras`) and registers three
 * model-facing tools on the global `ctx.tools` registry (the fleet-tasks
 * pattern, plugins/fleet-tasks/src/index.ts:87) so ANY in-process agent can
 * register workspace watch intent, subscribe to workspace-change events, and
 * inspect recent collisions.
 *
 * ```
 * - id: fleet-extras
 *   name: '@hydra/dsh-fleet-extras'
 *   config:
 *     collisionWindowMs: 30000   # two DIFFERENT actors writing the same file within
 *                                # this window = a fleet/collision event (30 s, spec)
 *     pollMs: 0                  # background scan cadence; 0 = scan() is manual
 * ```
 *
 * COLLISION (the shared-worktree protection pattern): a write to path P by
 * actor A collides when P was written by a different actor B within the
 * window → `fleet/collision` with { actors, file, windowMs }. Attribution is
 * the most recent watch holder on the changed path, or the explicit
 * `noteWrite(path, actor)` seam. Events publish with `originKind: 'extras'`
 * (self-trigger guard) and are signed via `ctx.fleetAgent` when an `extras`
 * profile is registered.
 *
 * Deps: none required. `ctx.fleetBus` / `ctx.fleetAgent` are optional seams
 * resolved at event time.
 * @module @hydra/dsh-fleet-extras
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { FleetExtrasService, type FleetExtrasConfig } from './service.ts'

export const name = 'fleet-extras'
/** fleet-bus / fleet-agent are optional seams, never required. */
export const inject: string[] = []

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetExtrasConfig {}

export const Config: z<Config> = z.object({
  /** Injectable clock (tests only). */
  clock: z.any(),
  /** The collision window (ms). Default 30 s (the spec). */
  collisionWindowMs: z.number().min(0).default(30_000),
  /** Background scan cadence (ms). Default 0 = scan() is manual. */
  pollMs: z.number().min(0).default(0),
  /** Delivery-target resolver for subscriptions (tests). */
  resolveAgent: z.any(),
  /** Hash file content on scan (default false — mtime+size is enough). */
  useHash: z.boolean().default(false),
  /** Max recent-writes kept per path (ledger bound). */
  maxWritesPerPath: z.number().min(1).default(64),
})

export function apply(ctx: Context, config: Config): void {
  const extras = new FleetExtrasService(ctx, config)
  registerFleetExtrasTools(ctx, extras)
}

/** Narrow a JSON output value to a record for render-time shaping. */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Scoped tools only run inside an agent; a caller without one has no id. */
function requireAgent(agent: { id: string } | undefined): { id: string } {
  if (agent === undefined) {
    throw new Error('fleet tools require an owning agent session')
  }
  return agent
}

/** Register the three fleet-extras tools on the global tools registry. */
function registerFleetExtrasTools(ctx: Context, extras: FleetExtrasService): void {
  ctx.tools.register(defineTool({
    name: 'extras_watch',
    description: 'Register workspace watch intent over explicit file or directory paths for the calling agent. ' +
      'The fleet-extras scanner then polls ONLY these paths for on-disk changes (fleet/workspace-change) and ' +
      'detects collisions: when two DIFFERENT agents write the SAME file within 30 s, a fleet/collision event ' +
      'fires naming the actors, the file, and the window (the shared-worktree protection pattern). ' +
      'Give it the paths the agent is about to edit. Multiple agents may watch the same path.',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        description: 'File or directory paths to watch (absolute, or relative to the repo root).',
        items: { type: 'string' },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Watching ${(record?.paths as unknown as unknown[] | undefined)?.length ?? 0} path(s) as ${String(record?.actor ?? '?')} (watch ${String(record?.id ?? '?')})` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const watch = extras.watch(args.paths as string[], agent.id)
      return { id: watch.id, actor: watch.actor, paths: watch.paths, createdAt: watch.createdAt } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Watch workspace paths', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'extras_subscribe',
    description: 'Subscribe the calling agent to workspace-change events. With an optional pathPattern, only changes ' +
      'whose path CONTAINS the pattern are delivered; without one, every watched change is delivered. Delivery is an ' +
      'inject (quiet inbox) for in-process agents; every change also publishes fleet/workspace-change on the fleet-bus.',
    parameters: {
      pathPattern: { type: 'string', description: 'Optional substring filter on the changed path.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        return [{ type: 'text', text: `Subscribed ${String(record?.agentId ?? '?')}${record?.pathPattern === undefined ? '' : ` to "${String(record.pathPattern)}"`} (${String(record?.id ?? '?')})` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const subscription = extras.subscribe(agent.id, { pathPattern: (args.pathPattern as string | undefined) ?? undefined })
      return {
        id: subscription.id,
        agentId: subscription.agentId,
        ...(subscription.pathPattern !== undefined ? { pathPattern: subscription.pathPattern } : {}),
      } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Subscribe to workspace changes', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'extras_collisions',
    description: 'Recent fleet collisions: every detected case of two DIFFERENT agents writing the SAME file within the ' +
      'collision window (30 s) — the shared-worktree protection signal. Also reports the active watch intents and ' +
      'subscriptions so the caller can see which paths are under concurrent watch.',
    parameters: {
      limit: { type: 'number', description: 'Max collisions to return (default 20).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const count = (record?.collisions as unknown as unknown[] | undefined)?.length ?? 0
        return [{ type: 'text', text: `Collisions: ${count} recent (window ${String(record?.windowMs ?? '?')}ms), ${(record?.watches as unknown as unknown[] | undefined)?.length ?? 0} active watch(es), ${(record?.subscriptions as unknown as unknown[] | undefined)?.length ?? 0} subscription(s)` }]
      },
    },
    async execute(args) {
      return {
        windowMs: extras.collisionWindowMs,
        collisions: extras.recentCollisions((args.limit as number | undefined) ?? 20).map(collision => ({
          file: collision.file,
          actors: collision.actors,
          windowMs: collision.windowMs,
          firstTs: collision.firstTs,
          secondTs: collision.secondTs,
          ts: collision.ts,
        })),
        watches: extras.listWatches().map(watch => ({ id: watch.id, actor: watch.actor, paths: watch.paths, createdAt: watch.createdAt })),
        subscriptions: extras.listSubscriptions().map(subscription => ({
          id: subscription.id,
          agentId: subscription.agentId,
          ...(subscription.pathPattern !== undefined ? { pathPattern: subscription.pathPattern } : {}),
        })),
      } as unknown as JsonValue
    },
    presentCall: () => ({ card: 'generic', title: 'Fleet extras collisions', kind: 'other', rawInput: null }),
  }))
}
