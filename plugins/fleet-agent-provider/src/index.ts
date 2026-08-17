/**
 * Fleet subagent provider: registers a {@link SubagentProvider} on
 * `ctx.subagents` that creates isolated child agents running in dedicated
 * git worktrees. Each child gets its own filesystem and DSH session while
 * sharing the parent's Cordis context and process.
 *
 * @module @hydra/dsh-fleet-agent-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { FleetAgentProvider } from './provider.ts'

export const name = 'fleet-agent-provider'
export const inject = ['subagents']

export { type Config, Config } from './config.ts'

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new FleetAgentProvider(ctx, config))
}
