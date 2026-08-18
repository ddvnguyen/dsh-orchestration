/**
 * ui-fleet-ui-overrides client entry: registers every UI override on the
 * dsh web slot system —
 *
 * 1. FleetStatsLine into `conversation.composer.dock` (same cell id as the
 *    shipped StatsLine, so it shadows it) — shows context size instead of
 *    the input/output token figures.
 * 2. An empty entry into `conversation.input.right` occupying the ring's
 *    `context-meter` cell — removes the ContextMeter ring (redundant once
 *    the stats line shows context).
 * 3. ContextSummaryRow into `trajectory.context.summary` — sticky context
 *    header on the Trajectory view (slot declared by DSH ui-trajectory).
 * 4. Global CSS injection (side-effect import of styles.module.css) — hides
 *    the Chat/Trajectory tab bar and slims the session header.
 * @module @hydra/dsh-fleet-ui-overrides/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-conversation's SlotMap merge ('conversation.composer.dock',
// 'conversation.input.right') into this program so the register calls type-
// check; ui-trajectory merges the 'trajectory.context.summary' row (added by
// the parallel DSH-fork change); ui-settings rides the settings-family seam.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { FleetStatsLine } from './FleetStatsLine.tsx'
import { ContextSummaryRow } from './ContextSummaryRow.tsx'
// Side-effect import: the client bundler extracts module CSS and injects a
// plugin-owned <style> tag at factory execution (removed on unload), which
// is what ships the global tab-hiding / header-slimming rules below.
import './styles.module.css'

/** Required services: the slot registry only. */
export const inject = ['slots']

/**
 * Register all overrides. Shadowing cells (the StatsLine and the ContextMeter
 * ring) register at priority -1 — the slot registry renders a cell's LOWEST-
 * priority live entry, and a second registration at the same cell + same
 * priority (0) would throw. The core registers its entries during boot and
 * plugins load after, so -1 guarantees the override wins in any order; order
 * 0 is kept on the stats entry to preserve the shipped cell's display slot.
 */
export function apply(ctx: ClientContext): void {
  // Override StatsLine (same cell id 'stats'; this entry wins the cell).
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'stats',
    order: 0,
    priority: -1,
  }, FleetStatsLine))

  // Remove the ContextMeter ring: an empty occupant of its cell renders
  // nothing and shadows the ring (harmless before the ring sits in the slot).
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'context-meter',
    priority: -1,
  }, () => null))

  // Trajectory context summary. The inject waits for the declaration, so
  // this registers whenever the slot becomes live — safe both before the
  // DSH-fork change lands (no-op) and after (row mounts on the trajectory).
  ctx.slots.inject('trajectory.context.summary', () => ctx.slots.register({
    name: 'trajectory.context.summary',
    id: 'context-summary',
  }, ContextSummaryRow))
}
