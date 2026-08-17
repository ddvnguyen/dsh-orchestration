/**
 * fleet-settings service composition (issue #26, orchestration-v3 §4.4): the
 * single dep set the /fleet-settings page + API consume.
 *
 * The service composes the fleet-family services over the SAME durable dirs
 * the plugins use (fleet-agent `$DSH_HOME/fleet/agent/profiles.json`,
 * fleet-teams `$DSH_HOME/fleet/teams/teams.json` + `<room>.memory.md`,
 * fleet-budget `$DSH_HOME/fleet/fleet-budget.sqlite`, fleet-policy postures,
 * session ledger `$DSH_HOME/sessions`) — the fleet-teams-ui standalone
 * pattern, so every settings edit goes through the EXISTING service API and
 * persists across restarts. When composed in a dsh host the plugin passes the
 * ctx-resolved services instead (src/index.ts), so edits land in the live
 * services, not shadow copies.
 *
 * RESUME + ARCHIVE SEAMS (the probe's chosen seams — see
 * orchestration/state/fleet-settings-26.md): the canonical dsh RPCs the web
 * UI itself uses, called over HTTP on the dsh web server's gateway:
 * - resume  → `session.prompt` (`POST {base}/api/session.prompt`, mode
 *   `queue`, one text part) — the web composer's own followup path
 *   (`agent.followup`), which resumes a cold session too.
 * - archive → `workspace.archiveSession` (`POST {base}/api/workspace.archiveSession`),
 *   the registry-global archive set (idempotent), PLUS the durable UI overlay
 *   marker (src/overlay.ts) so the page hides the session even when no dsh
 *   host is reachable.
 * The seam payloads are returned verbatim to the caller (`target.body`), so a
 * caller may inspect or replay them; the service executes them when a
 * `dshWebBaseUrl` is configured.
 *
 * @module @hydra/dsh-fleet-settings/service
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { FleetAgentService } from '../../fleet-agent/src/service.ts'
import { FleetTeamsService } from '../../fleet-teams/src/service.ts'
import { FleetBudgetService } from '../../fleet-budget/src/service.ts'
import { FleetPolicyService } from '../../fleet-policy/src/service.ts'
import { SessionLedger } from './sessions.ts'
import { SettingsOverlay } from './overlay.ts'

/** The service + store deps the settings page + API consume. */
export interface SettingsDeps {
  /** fleet-agent profile CRUD (agents tab). */
  agents: FleetAgentService
  /** fleet-teams teams/rooms/grants (teams tab). */
  teams: FleetTeamsService
  /** fleet-budget caps + status (budgets tab). */
  budgets: FleetBudgetService
  /** fleet-policy postures (policy tab). */
  policy: FleetPolicyService
  /** The session ledger reader (sessions tab). */
  ledger: SessionLedger
  /** The durable UI overlay (session archive markers). */
  overlay: SettingsOverlay
  /**
   * Base URL of the dsh web server's HTTP gateway (e.g. `http://127.0.0.1:3080`).
   * When set, resume/archive are executed against it; when unset, the seam
   * payloads are returned without executing.
   */
  dshWebBaseUrl?: string
}

/** Build the full settings dep set, composing missing services over `home`. */
export function createSettingsDeps(config: { home?: string; dshWebBaseUrl?: string; deps?: Partial<SettingsDeps> } = {}): SettingsDeps {
  const home = config.home ?? resolveDshHome()
  const provided = config.deps ?? {}
  const ctx = new Context()
  return {
    agents: provided.agents ?? new FleetAgentService(ctx, { home }),
    teams: provided.teams ?? new FleetTeamsService(ctx, { home, storeDir: `${home}/fleet/teams` }),
    budgets: provided.budgets ?? new FleetBudgetService(ctx, {}),
    policy: provided.policy ?? new FleetPolicyService(ctx, {}),
    ledger: provided.ledger ?? new SessionLedger({ home }),
    overlay: provided.overlay ?? new SettingsOverlay({ home }),
    ...(provided.dshWebBaseUrl !== undefined
      ? { dshWebBaseUrl: provided.dshWebBaseUrl }
      : config.dshWebBaseUrl !== undefined ? { dshWebBaseUrl: config.dshWebBaseUrl } : {}),
  }
}

/** The one RPC envelope the page sends to the dsh gateway. */
export interface DshRpcSeam {
  /** The RPC method (e.g. `session.prompt`). */
  method: string
  /** The HTTP target on the dsh web server. */
  url: string
  /** The JSON envelope body (`client-request` full form). */
  body: {
    type: 'client-request'
    rpcId: string
    method: string
    payload: Record<string, unknown>
  }
}

/** Build the `session.prompt` resume seam (mode queue, one text part). */
export function resumeSeam(baseUrl: string, sessionId: string, text: string): DshRpcSeam {
  const rpcId = `fs-${randomUUID()}`
  return {
    method: 'session.prompt',
    url: `${baseUrl.replace(/\/+$/, '')}/api/session.prompt`,
    body: {
      type: 'client-request',
      rpcId,
      method: 'session.prompt',
      payload: {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: text.length > 0 ? text : 'Please continue the conversation.' }],
      },
    },
  }
}

/** Build the `workspace.archiveSession` seam. */
export function archiveSeam(baseUrl: string, sessionId: string): DshRpcSeam {
  const rpcId = `fs-${randomUUID()}`
  return {
    method: 'workspace.archiveSession',
    url: `${baseUrl.replace(/\/+$/, '')}/api/workspace.archiveSession`,
    body: {
      type: 'client-request',
      rpcId,
      method: 'workspace.archiveSession',
      payload: { sessionId },
    },
  }
}

/** Execute one seam RPC against the dsh gateway; `null` when no base URL. */
export async function executeSeam(seam: DshRpcSeam, baseUrl: string | undefined): Promise<{
  executed: boolean
  accepted: boolean
  status: number
  response?: unknown
}> {
  if (baseUrl === undefined) return { executed: false, accepted: false, status: 0 }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(seam.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(seam.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed: unknown = null
    try { parsed = JSON.parse(text) } catch { parsed = text }
    const accepted = response.ok
      && parsed !== null && typeof parsed === 'object'
      && (parsed as { result?: { ok?: boolean } }).result?.ok === true
    return { executed: true, accepted, status: response.status, response: parsed }
  } finally {
    clearTimeout(timer)
  }
}
