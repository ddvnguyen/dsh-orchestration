/**
 * Shared sidebar-foot panel state: exactly ONE fleet panel (Scheduler or
 * Orchestration) may be open at a time. The two sidebar actions are separate
 * slot registrations with separate React trees, so the open/close state lives
 * in a tiny module-level store bridged through `useSyncExternalStore` instead
 * of per-component `useState`.
 * @module @hydra/dsh-fleet-sidebar/panel-store
 */

import { useSyncExternalStore } from 'react'

/** The two fleet sidebar foot actions. */
export type FleetSidebarPanel = 'scheduler' | 'orchestration'

/** Which panel is open (`null` = none). */
export type FleetSidebarOpen = FleetSidebarPanel | null

let open: FleetSidebarOpen = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** The currently open panel (sync read for useSyncExternalStore). */
export function getOpenPanel(): FleetSidebarOpen {
  return open
}

/** Open `panel`, first closing whatever was open (only one at a time). */
export function openPanel(panel: FleetSidebarPanel): void {
  if (open === panel) return
  open = panel
  emit()
}

/** Close whichever panel is open (no-op when none). */
export function closePanel(): void {
  if (open === null) return
  open = null
  emit()
}

/** Open the panel when closed, close it when open. */
export function togglePanel(panel: FleetSidebarPanel): void {
  if (open === panel) closePanel()
  else openPanel(panel)
}

/** Subscribe to panel-state changes (useSyncExternalStore listener). */
export function subscribePanel(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * React binding: `[open, openPanel]`. Both footer icons and the panels read
 * the same store, so opening one action closes the other automatically.
 */
export function useFleetSidebarPanel(): [FleetSidebarOpen, (panel: FleetSidebarPanel) => void] {
  const panel = useSyncExternalStore(subscribePanel, getOpenPanel, getOpenPanel)
  return [panel, openPanel]
}
