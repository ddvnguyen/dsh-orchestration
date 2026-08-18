/**
 * @hydra/dsh-fleet-schedule — API-based heartbeat management.
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`, see `@deepseek-ai/dsh-tool-todo` as
 * the registration template). It constructs the {@link ScheduleService}
 * (registers `ctx.fleetSchedule`, src/schedule-service.ts) which owns the
 * in-memory registry + `$DSH_HOME/fleet/schedules.json` persistence, the 1 s
 * tick timer (configurable `tickMs`), and the `fleet_heartbeat_*` motion
 * surface (injected by the fleet-agent plugin).
 *
 * ```
 * - id: fleet-schedule
 *   name: '@hydra/dsh-fleet-schedule'
 *   config:
 *     home: ''        # default $DSH_HOME/fleet (schedules.json)
 *     tickMs: 1000    # tick cadence (requirement §2: default 1000)
 * ```
 *
 * Deps: self-contained — `ctx.fleet` (delivery) and `ctx.fleetBus` / `ctx.
 * fleetAgent` (events) are resolved optionally at runtime (`ctx.get`), so the
 * plugin is safe in any composition; without `ctx.fleet` a due schedule's run
 * is recorded as failed and skipped with a warning (requirement §1).
 * @module @hydra/dsh-fleet-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FleetClock } from '../../../src/types.ts'
import { ScheduleService } from '../../../src/schedule-service.ts'

export const name = 'fleet-schedule'
/** Self-contained: ctx.fleet / ctx.fleetBus / ctx.fleetAgent are optional. */
export const inject: string[] = []

/** Schemastery configuration schema for the plugin consumer. */
export interface Config {
  /** Directory holding schedules.json. Default `$DSH_HOME/fleet`. */
  home: string
  /** Store file name. Default `schedules.json`. */
  file: string
  /** Tick timer cadence. Default 1000 ms (1 s per requirement §1). */
  tickMs: number
  /** Injectable clock (tests only). */
  clock: unknown
}

export const Config: z<Config> = z.object({
  home: z.string(),
  file: z.string().default('schedules.json'),
  tickMs: z.number().min(1).default(1000),
  clock: z.any(),
})

export function apply(ctx: Context, config: Config): void {
  new ScheduleService(ctx, {
    dir: config.home,
    file: config.file,
    tickMs: config.tickMs,
    clock: config.clock as FleetClock | undefined,
  })
}
