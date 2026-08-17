/**
 * COMPOSITION smoke — the REAL web-profile runtime contract (issue #26,
 * Lessons.md 2026-08-16: "Standalone-verified ≠ composed-verified").
 *
 * Every other fleet suite verifies plugins in isolation against fakes or the
 * plugin's own standalone server. This suite boots a REAL Cordis app the way
 * the dsh-fleet container does (dsh-fleet-container/fleet-web.patch.yml): the
 * dsh webServer service + the fleet plugin family composed via the real
 * `ctx.plugin()` machinery — inject resolution, fiber ordering, the real
 * webServer route dispatcher (exact → longest-prefix → fallback), and the
 * fleet plugins' real handlers — then asserts REAL response BODIES over an
 * actual TCP socket.
 *
 * The three shipped bugs are each asserted as a class, not an instance:
 *   1. prefix handlers receive the FULL url — /fleet-teams-ui/api/rooms must
 *      route through the real dispatcher to the fleet-teams-ui api handler and
 *      return the rooms JSON (the withMountPrefix strip through the real seam).
 *   2. apply-time ctx.get('webServer') — the plugins declare inject so Cordis
 *      applies them AFTER the webServer exists; the routes mount (not the
 *      silent "no dsh webServer composed" skip).
 *   3. /api route collision — a web-gateway prefix route at `/api` (the
 *      client-connection shape) coexists with the fleet `/api/agents` prefix:
 *      longest-prefix wins, so /api/agents serves the fleet registry while
 *      other /api/* paths serve the gateway.
 *
 * The SPA trap is asserted explicitly: a real fallback seat serves a
 * SPA-looking index.html, and every fleet route is checked to return the REAL
 * body — not the SPA fallback (twice a 200 was wrongly taken as proof).
 *
 * Run: pnpm test:composition  (or)  tsx tests/composition-smoke.ts
 * @module @hydra/dsh-fleet/tests/composition-smoke
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { assertPass } from './harness.ts'
// Plugin MODULES (namespace imports) — the Loader mounts the module namespace
// (unwrapExports), NOT the bare apply function, so the exported `inject` array
// reaches ctx.plugin and Cordis orders each fiber after its services.
import * as FleetAgentModule from '../plugins/fleet-agent/src/index.ts'
import * as FleetBusModule from '../plugins/fleet-bus/src/index.ts'
import * as FleetTeamsModule from '../plugins/fleet-teams/src/index.ts'
import * as FleetTeamsUiModule from '../plugins/fleet-teams-ui/src/index.ts'
import * as FleetBoardModule from '../plugins/fleet-board/src/index.ts'
import * as FleetBudgetModule from '../plugins/fleet-budget/src/index.ts'
import * as FleetPolicyModule from '../plugins/fleet-policy/src/index.ts'
import * as FleetSettingsModule from '../plugins/fleet-settings/src/index.ts'

/** The SPA marker the real web app's index.html carries (client/web boot #root). */
const SPA_MARKER = 'id="root"'
/** A minimal SPA-looking index body the fallback seat serves. */
const SPA_INDEX = `<!doctype html><html><head><title>dsh</title></head><body><div ${SPA_MARKER}></div><script>window.__DSH_BOOT__={}</script></body></html>`

interface HttpResponse {
  status: number
  text: string
  json: unknown
}

/** Fetch + capture status/text + best-effort JSON parse (bodies, not statuses). */
async function getBody(url: string): Promise<HttpResponse> {
  const response = await fetch(url, { cache: 'no-store' })
  const text = await response.text()
  let json: unknown
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, text, json }
}

/** The gateway `/api` prefix handler shape (the web app's client-connection). */
function gatewayHandler(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, gateway: true, path: req.url ?? '/' }))
}

async function main(): Promise<void> {
  console.log('composition-smoke: real Cordis web profile — webServer + fleet plugins, TCP body assertions')

  const home = mkdtempSync(join(tmpdir(), 'composition-fleet-'))
  const storeDir = join(home, 'fleet')

  const ctx = new Context()
  const fibers: Array<Fiber & PromiseLike<Fiber>> = []

  // The dsh base services the fleet plugins touch at apply time (ctx.tools).
  // Constructed the way the family harness mounts services (mountTeam pattern).
  void new SystemPrompt(ctx, {})
  void new ToolRuntime(ctx, {})
  const webServerFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  fibers.push(webServerFiber)
  await webServerFiber
  const webServer = ctx.get('webServer') as InstanceType<typeof WebServer>
  assertPass('real webServer service composes and listens on an OS-assigned port',
    webServer !== undefined && webServer.port > 0, `port=${webServer?.port}`)

  // Compose the fleet plugin family the way the container does (fleet-web.patch.yml),
  // via the REAL ctx.plugin machinery — the plugin inject arrays order each fiber
  // after the services it reads at apply time.
  const compose = (plugin: Parameters<Context['plugin']>[0], config: unknown): void => {
    const fiber = ctx.plugin(plugin as never, config as never)
    fibers.push(fiber as Fiber & PromiseLike<Fiber>)
  }
  compose(FleetBusModule, { storeDir, resolveAgent: () => undefined })
  compose(FleetAgentModule, { home, autoRegisterAgents: false, injectTools: false })
  compose(FleetTeamsModule, { home, storeDir: join(storeDir, 'teams'), injectTools: false })
  compose(FleetTeamsUiModule, { home })
  compose(FleetBoardModule, { storeDir, injectTools: false })
  compose(FleetBudgetModule, { dir: storeDir, injectTools: false })
  compose(FleetPolicyModule, { injectTools: false })
  compose(FleetSettingsModule, { home, dshWebBaseUrl: undefined })

  // Await every fiber: with inject declared, a fiber settles only once its
  // services exist AND apply() ran — the ordering guarantee under test.
  for (const fiber of fibers) await fiber
  assertPass('all fleet plugin fibers activated (inject-ordered, no silent no-mount skip)', true)

  // The web app gateway (`/api` prefix, the client-connection shape) + the SPA
  // fallback seat — the collision + SPA-trap seams the fleet routes must beat.
  const gatewayDisposer = webServer.register({ kind: 'prefix', path: '/api', handler: gatewayHandler })
  const fallbackDisposer = webServer.registerFallback((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(SPA_INDEX)
  })
  const base = `http://127.0.0.1:${webServer.port}`

  try {
    // Seed through the LIVE services the plugins composed (never a fake): one
    // profile + one team/room, so the registry + rooms APIs return real data.
    const agentService = ctx.get('fleetAgent') as {
      register(input: { agentId: string; name: string; role: string }): { agentId: string }
    }
    agentService.register({ agentId: 'dev-1', name: 'Dev One', role: 'dev' })
    const teamsService = ctx.get('fleetTeams') as {
      createTeam(input: { name: string }, actor: string): { id: string }
      createRoom(input: { teamId: string; name: string }, actor: string): { id: string }
      joinRoom(roomId: string, actor: string): unknown
    }
    const team = teamsService.createTeam({ name: 'builders' }, 'dev-1')
    const room = teamsService.createRoom({ teamId: team.id, name: 'ops' }, 'dev-1')
    teamsService.joinRoom(room.id, 'dev-1')

    // ---- the SPA trap: the fallback itself must be distinguishable ----
    const spa = await getBody(`${base}/`)
    assertPass('GET / → 200 with the SPA index body (fallback seat serves the app)',
      spa.status === 200 && spa.text.includes(SPA_MARKER), spa.text.slice(0, 80))

    // ---- 1. fleet-admin page + profile API through the REAL dispatcher ----
    const admin = await getBody(`${base}/admin`)
    assertPass('GET /admin → REAL fleet-admin body, not the SPA fallback',
      admin.status === 200 && admin.text.includes('fleet-admin') && !admin.text.includes(SPA_MARKER),
      admin.text.slice(0, 80))
    const adminHealth = await getBody(`${base}/admin/health`)
    assertPass('GET /admin/health → JSON ok',
      adminHealth.status === 200 && (adminHealth.json as { ok?: boolean })?.ok === true)

    const agents = await getBody(`${base}/api/agents`)
    const agentsJson = agents.json as { count?: number; profiles?: Array<{ name?: string; role?: string }> }
    assertPass('GET /api/agents → fleet JSON with the seeded profile (registry, not SPA)',
      agents.status === 200
        && (agentsJson.count ?? 0) >= 1
        && (agentsJson.profiles ?? []).some(profile => profile.name === 'Dev One' && profile.role === 'dev') === true,
      agents.text.slice(0, 160))

    // ---- 3. /api collision: the web gateway prefix coexists via longest-prefix ----
    const gateway = await getBody(`${base}/api/health`)
    assertPass('GET /api/health → the web gateway handler (fleet /api/agents wins its subtree only)',
      gateway.status === 200 && (gateway.json as { gateway?: boolean })?.gateway === true,
      gateway.text.slice(0, 120))

    // ---- 2. fleet-teams-ui rooms page + API (prefix-strip through the real seam) ----
    const roomsPage = await getBody(`${base}/fleet-teams-ui`)
    assertPass('GET /fleet-teams-ui → REAL rooms page, not the SPA fallback',
      roomsPage.status === 200
        && roomsPage.text.includes('fleet-teams — rooms')
        && !roomsPage.text.includes(SPA_MARKER),
      roomsPage.text.slice(0, 80))
    const rooms = await getBody(`${base}/fleet-teams-ui/api/rooms`)
    const roomsJson = rooms.json as { ok?: boolean; teams?: Array<{ rooms: Array<{ room: { name?: string } }> }> }
    assertPass('GET /fleet-teams-ui/api/rooms → parses + carries the seeded room (FULL url prefix-stripped by the real dispatcher)',
      rooms.status === 200
        && roomsJson.ok === true
        && (roomsJson.teams?.[0]?.rooms ?? []).some(({ room }) => room.name === 'ops'),
      rooms.text.slice(0, 160))
    const uiProfiles = await getBody(`${base}/fleet-teams-ui/api/profiles`)
    assertPass('GET /fleet-teams-ui/api/profiles → the fleet-agent registry via the teams-ui mount',
      uiProfiles.status === 200 && (uiProfiles.json as { count?: number })?.count === 1,
      uiProfiles.text.slice(0, 120))

    // ---- fleet-board feed through the real dispatcher ----
    const boardHealth = await getBody(`${base}/fleet-board/health`)
    assertPass('GET /fleet-board/health → JSON ok (board routes mounted via webServer)',
      boardHealth.status === 200
        && (boardHealth.json as { ok?: boolean; service?: string })?.ok === true
        && (boardHealth.json as { service?: string })?.service === 'fleet-board',
      boardHealth.text.slice(0, 120))
    const boardEvents = await getBody(`${base}/fleet-board/events`)
    assertPass('GET /fleet-board/events → feed JSON',
      boardEvents.status === 200 && (boardEvents.json as { count?: number })?.count !== undefined,
      boardEvents.text.slice(0, 120))

    // ---- fleet-settings (companion settings page, composed with its services) ----
    const settingsPage = await getBody(`${base}/fleet-settings`)
    assertPass('GET /fleet-settings → REAL settings page, not the SPA fallback',
      settingsPage.status === 200
        && settingsPage.text.includes('fleet-settings')
        && !settingsPage.text.includes(SPA_MARKER),
      settingsPage.text.slice(0, 80))
    const settingsAgents = await getBody(`${base}/fleet-settings/api/agents`)
    assertPass('GET /fleet-settings/api/agents → live fleet-agent registry (settings mount + prefix strip)',
      settingsAgents.status === 200 && (settingsAgents.json as { count?: number })?.count === 1,
      settingsAgents.text.slice(0, 120))
    const settingsHealth = await getBody(`${base}/fleet-settings/health`)
    assertPass('GET /fleet-settings/health → JSON ok with the live services',
      settingsHealth.status === 200 && (settingsHealth.json as { ok?: boolean })?.ok === true,
      settingsHealth.text.slice(0, 120))

    // ---- the routes are real, not the fallback: every fleet route body differs ----
    assertPass('every fleet route served its own real body (SPA fallback never matched a fleet route)',
      !admin.text.includes(SPA_MARKER)
        && !roomsPage.text.includes(SPA_MARKER)
        && !settingsPage.text.includes(SPA_MARKER)
        && !agents.text.includes(SPA_MARKER))
  } finally {
    gatewayDisposer()
    fallbackDisposer()
    // Teardown: dispose the plugin fibers (reverse order) so the real HTTP
    // server closes and the test process exits cleanly.
    for (const fiber of fibers.slice().reverse()) {
      await fiber.dispose().catch(() => undefined)
    }
  }

  console.log('composition-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`composition-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
