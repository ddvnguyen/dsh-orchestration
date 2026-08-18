/**
 * @hydra/dsh-fleet-ui-overrides — server half, intentionally minimal: every
 * override this plugin ships is client-side (slot registrations + global
 * CSS injection in src/client). The package still declares a server half so
 * the dsh web host treats it as a regular two-side plugin and loads the
 * client entry from the same package manifest.
 *
 * ```
 * - id: ui-fleet-ui-overrides
 *   name: '@hydra/dsh-fleet-ui-overrides'
 * ```
 * @module @hydra/dsh-fleet-ui-overrides
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin identity (server half). */
export const name = 'ui-fleet-ui-overrides'
/** Nothing to inject on the server side. */
export const inject: string[] = []

/**
 * No-op server half: the overrides live entirely in the client entry. The
 * apply body exists so the plugin registers as a valid Cordis function plugin
 * in any host composition that loads both halves.
 */
export function apply(ctx: Context): void {
  ctx.logger.info('ui-fleet-ui-overrides: server half is a no-op (all overrides are client-side slot/CSS work)')
}
