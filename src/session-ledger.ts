/**
 * Fleet → dsh session-log mirror. Mirrors fleet ledger records into a real
 * dsh `Session` (via `session.append`) so a model-visible session carries the
 * fleet context, mirroring how session-telemetry captures events — but in
 * reverse: fleet records are OUR events written INTO the session log.
 *
 * PROTO TYPE CAVEAT (see src/types.ts): the `fleet/*` session event types are
 * declared via `SessionEventMap` declaration merging and append cleanly at
 * runtime, but they are NOT part of the dsh persistence catalog
 * (`KNOWN_SESSION_EVENT_TYPES`), so a durable persistence backend refuses to
 * re-read a log containing them. In-memory ledgers (FleetRegistry) remain the
 * primary store; the session mirror is informational for live composition.
 * @module @hydra/dsh-fleet/session-ledger
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type {} from './types.ts'
import type { FleetAgentView, FleetLedgerEvent, FleetSessionEventType } from './types.ts'

/**
 * Append one fleet ledger event to a session log as the matching `fleet/*`
 * event. Unknown ledger kinds are skipped rather than guessed.
 * @param session - the target dsh session (agent.session / ctx.sessions.get).
 * @param event - one fleet ledger record.
 * @returns the appended session event type, or null when unmapped.
 */
export function mirrorFleetEventToSession(session: Session, event: FleetLedgerEvent): FleetSessionEventType | null {
  switch (event.data.kind) {
    case 'heartbeat':
      session.append('fleet/heartbeat', {
        agentId: event.agentId,
        status: 'active',
        heartbeatCount: event.data.heartbeatCount,
      })
      return 'fleet/heartbeat'
    case 'stall':
      session.append('fleet/stall', { agentId: event.agentId, stalledMs: event.data.stalledMs })
      return 'fleet/stall'
    case 'resume':
      session.append('fleet/resume', { agentId: event.agentId, stalledForMs: event.data.stalledForMs })
      return 'fleet/resume'
    case 'message':
      session.append('fleet/message', {
        messageId: event.data.messageId,
        from: event.data.from,
        to: event.data.to,
        text: event.data.text,
        state: event.data.state,
      })
      return 'fleet/message'
    default:
      return null
  }
}

/** Derive the mirror target for an agent view when it carries a session. */
export function fleetViewToSessionReference(view: FleetAgentView): { sessionId: string } | undefined {
  return view.sessionId !== undefined ? { sessionId: view.sessionId } : undefined
}
