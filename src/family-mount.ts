/**
 * Shared webServer mount helper for the fleet plugin family (issue #26,
 * Lessons.md 2026-08-16: "Standalone-verified ≠ composed-verified").
 *
 * The dsh webServer passes the FULL request url to a prefix route handler
 * (`packages/host/webserver/src/index.ts`), so a handler registered at
 * `/fleet-teams-ui/api` receives `/fleet-teams-ui/api/rooms`, not
 * `/api/rooms`. Every fleet HTTP surface (fleet-teams-ui, fleet-settings,
 * fleet-board, fleet-agent-admin) must therefore strip its mount prefix when
 * served through a webServer — while the SAME handler, when used standalone,
 * must see the bare path. Before this helper each plugin hand-rolled a
 * private strip function with subtly different edge-case behavior.
 *
 * `withMountPrefix(prefix, handler)` wraps a standalone handler so the mount
 * prefix is stripped from `req.url` (pathname + preserved query string) before
 * the handler runs. Mounting a handler with no prefix ('' or '/') is a
 * pass-through — the standalone bin and a webServer mount share one handler.
 *
 * ```
 * // standalone bin:      handler sees /api/rooms
 * // webServer mount:     register({ kind: 'prefix', path: '/fleet-teams-ui/api', handler })
 * //                       handler sees /api/rooms (prefix stripped)
 * const api = withMountPrefix('/fleet-teams-ui/api', dispatchApi)
 * ```
 * @module @hydra/dsh-fleet/family-mount
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** The handler shape both the dsh webServer and the standalone bins mount. */
export type FamilyMountHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Wrap a standalone handler so it sees the pathname with the mount prefix
 * stripped, leaving the query string untouched. The wrapped handler's
 * `req.url` is rewritten for the duration of the request only (each request
 * owns its `IncomingMessage`).
 *
 * @param prefix - the webServer mount path ('' or '/' = pass-through).
 * @param handler - the standalone handler expecting bare paths.
 * @returns the mount-aware handler to register on the webServer.
 */
export function withMountPrefix(prefix: string, handler: FamilyMountHandler): FamilyMountHandler {
  const mount = prefix === '/' || prefix === '' ? '' : prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (mount === '') return handler
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const pathname = url.pathname
    if (pathname === mount || pathname.startsWith(`${mount}/`)) {
      url.pathname = pathname.slice(mount.length) || '/'
      req.url = `${url.pathname}${url.search}`
    }
    return handler(req, res)
  }
}
