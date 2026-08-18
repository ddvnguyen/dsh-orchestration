/**
 * ui-fleet-sidebar client entry: registers the Scheduler + Orchestration foot
 * actions into the DSH sidebar (`sidebar.footer.action` slot, declared by
 * @deepseek-ai/dsh-client-ui-sidebar). Each action renders its rail icon /
 * wide row and opens its slide-out panel; the open/close state is shared
 * through the module-level panel store, so only one panel is ever open.
 * @module @hydra/dsh-fleet-sidebar/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the sidebar shell's SlotMap merge ('sidebar.footer.action')
// into this program so the register calls type-check.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { OrchestrationIcon } from './OrchestrationIcon.tsx'
import { SchedulerIcon } from './SchedulerIcon.tsx'

/** Required services: the slot registry only. */
export const inject = ['slots']

/**
 * Register both footer actions above the Settings gear. The inject callback
 * returns the two registration disposers (SlotInjectionEffect is iterable),
 * released together when the plugin fiber unloads.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => [
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'fleet-scheduler',
      order: 10,
    }, SchedulerIcon),
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'fleet-orchestration',
      order: 20,
    }, OrchestrationIcon),
  ])
}
