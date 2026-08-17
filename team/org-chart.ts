/**
 * V3 team org chart — fleet-tasks claimRole routing (issue #30).
 *
 * The org chart maps every roster member to its org-chart role and wires that
 * mapping into the fleet-tasks plugin config so claimWake routes work by role.
 *
 * PLUGIN SHAPE (cite file:line):
 * - fleet-tasks config: `orgChart?: Record<string, string>` (agentId → role)
 *   at plugins/fleet-tasks/src/service.ts:97-119 (FleetTasksConfig) — the
 *   `orgChart` field is documented at service.ts:104 as "Org chart: agentId →
 *   role. Used by claimWake for role-routed claims". The default role resolver
 *   `lookupRole` (service.ts:497-501) prefers the orgChart entry, then the
 *   agent's fleet-agent profile role.
 * - claimWake routing: plugins/fleet-tasks/src/service.ts:401-424 — a task's
 *   `claimRole` is honored as a routing hint (service.ts:410-416): claimWake
 *   prefers tasks whose claimRole matches the agent's role, then un-routed
 *   tasks, and skips tasks routed to a different role.
 * - fleet-watchdog reassignment: `reassignAgents?: Record<string, string>`
 *   (role → agentId) at plugins/fleet-watchdog/src/service.ts:118-135 —
 *   after a false-done REJECT, the reopened leaf is reassigned via
 *   `reassignAgents[leaf.claimRole]` (service.ts:462-465).
 *
 * ROUTING RULES (from the issue #30 brief):
 * - arch / dev-1 / dev-2 / devops / qa → their own agentId (each member owns
 *   one org-chart role; a task with `claimRole: 'dev-1'` is claimed by dev-1).
 * - lead routes to all: the lead creates tasks, it does not claim them
 *   (lead's claimRole routes nothing — claimWake for 'lead' matches only
 *   tasks explicitly routed to 'lead', and the lead never creates those).
 * - qa is the gate role: qa claims the review/accept work and owns the
 *   artifact-contract gate (task_accept + watchdog).
 * @module @hydra/dsh-fleet/team/org-chart
 */

import type { FleetTasksConfig } from '../plugins/fleet-tasks/src/service.ts'
import { FLEET_TEAM_ROLES, ROSTER, type FleetTeamRole } from './roster.ts'

/** agentId → role. The exact shape fleet-tasks `orgChart` config expects. */
export const ORG_CHART: Record<string, FleetTeamRole> = Object.fromEntries(
  ROSTER.map(profile => [profile.agentId, profile.claimRole]),
) as Record<string, FleetTeamRole>

/** role → agentId (reverse of ORG_CHART; the watchdog reassignAgents shape). */
export const ROLE_TO_AGENT: Record<FleetTeamRole, string> = Object.fromEntries(
  ROSTER.map(profile => [profile.claimRole, profile.agentId]),
) as Record<FleetTeamRole, string>

/** The org-chart gate role: qa owns acceptance, nothing merges without it. */
export const QA_ROLE: FleetTeamRole = 'qa'
export const QA_AGENT_ID: string = ROLE_TO_AGENT[QA_ROLE]

/** Resolve an agent's org-chart role (claimWake routing input). */
export function resolveRole(agentId: string): FleetTeamRole | undefined {
  return ORG_CHART[agentId]
}

/** Resolve the agent that owns an org-chart role (delegation + reassignment). */
export function resolveAgentForRole(role: string | undefined): string | undefined {
  if (role === undefined) return undefined
  return ROLE_TO_AGENT[role as FleetTeamRole]
}

/**
 * The fleet-tasks config fragment that wires this org chart in: both the
 * `orgChart` table and an explicit `resolveRole` (the family default would
 * already use orgChart — service.ts:136 — but being explicit keeps the wiring
 * self-documenting and overridable by tests).
 */
export function fleetTasksOrgChartConfig(): Pick<FleetTasksConfig, 'orgChart' | 'resolveRole'> {
  return {
    orgChart: { ...ORG_CHART },
    resolveRole: (agentId) => resolveRole(agentId),
  }
}

/** All registered org-chart roles (roster order). */
export const TEAM_ROLES: readonly FleetTeamRole[] = FLEET_TEAM_ROLES
