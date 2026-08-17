/**
 * @hydra/dsh-fleet-heartbeat — registers `ctx.fleet`.
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`, see `@deepseek-ai/dsh-tool-todo` as
 * the registration template). It constructs the {@link FleetService} which
 * owns the registry, the 30 s tick timer (stall scan), and the optional
 * session-log mirror.
 *
 * ```
 * - id: fleet-heartbeat
 *   name: '@hydra/dsh-fleet-heartbeat'
 *   config:
 *     stallThresholdMs: 600000   # 10 min default
 *     tickMs: 30000              # 30 s default
 * ```
 * @module @hydra/dsh-fleet-heartbeat
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FleetService, type FleetServiceConfig } from '../../../src/service.ts'
import type {} from '../../../src/types.ts'

export const name = 'fleet-heartbeat'
/** No required deps: ctx.sessions is bound optionally inside the service. */
export const inject: string[] = []

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetServiceConfig {}

export const Config: z<Config> = z.object({
  /** No-heartbeat interval (ms) before an active agent flips to `stalled`. */
  stallThresholdMs: z.number().min(1).default(10 * 60 * 1000),
  /** Tick timer cadence (ms). */
  tickMs: z.number().min(1).default(30_000),
  /** Injectable clock (tests only; defaults to Date.now()). */
  clock: z.any(),
})

export function apply(ctx: Context, config: Config): void {
  new FleetService(ctx, config)
}
