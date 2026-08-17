/**
 * V3 fleet roster — the team as fleet-agent profiles (issue #30).
 *
 * Typed runtime mirror of `roster.yaml` (the human source-of-truth; this
 * family has no yaml dependency, so the mirror is kept in sync manually).
 * Roster is ported from the V2 roster in
 * orchestration/v2/prompts/shared-v2-context.md:3-13 (owner + 6 roles) with
 * tier/provider from orchestration/agents/lead.md:4 + orchestration/providers.yaml.
 *
 * DELIBERATE OMISSION — the owner: V2 lists `owner` as the human operator
 * (shared-v2-context.md:7). V3 registers NO owner identity: a human has no
 * ed25519 keypair and cannot claim tasks via claimWake, so an owner profile
 * would be an unused fleet-agent. The owner stays an inbound-gate concept
 * (leader-contract.md, job-protocol.md), NOT a roster member.
 * @module @hydra/dsh-fleet/team/roster
 */

/** The six org-chart roles the fleet registers (V2 roster minus owner). */
export type FleetTeamRole = 'lead' | 'arch' | 'dev-1' | 'dev-2' | 'devops' | 'qa'

/** All registered fleet team roles, in roster order. */
export const FLEET_TEAM_ROLES: readonly FleetTeamRole[] = [
  'lead',
  'arch',
  'dev-1',
  'dev-2',
  'devops',
  'qa',
]

/** One roster entry — the identity profile the fleet registers for a member. */
export interface TeamRosterProfile {
  /** Stable slug; == the fleet-agent agent id (and the dsh agent id). */
  readonly agentId: FleetTeamRole
  /** Human label. */
  readonly name: string
  /** Org-chart role (== claimRole; used for task routing). */
  readonly role: FleetTeamRole
  /** Org-chart role routed to this agent by fleet-tasks claimWake. */
  readonly claimRole: FleetTeamRole
  /** 'agent' for roster members; 'human' reserved for a human operator (none). */
  readonly kind: 'agent'
  /** Workspace the agent works in (task worktrees live under it). */
  readonly cwd: string
  /** Provider tier (orchestration/providers.yaml + agents/lead.md). */
  readonly tier: 't0' | 't1' | 't2' | 't3'
  /** Provider/model string from providers.yaml. */
  readonly provider: string
  /** Per-role V3 prompt (see team/prompts/). */
  readonly promptFile: string
}

/** The workspace root the fleet runs in (dsh workspace; worktrees under it). */
export const WORKSPACE_ROOT: string = process.cwd()

/** The roster — every member the fleet registers (no owner; see module doc). */
export const ROSTER: readonly TeamRosterProfile[] = [
  {
    agentId: 'lead',
    name: 'Lead',
    role: 'lead',
    claimRole: 'lead',
    kind: 'agent',
    cwd: WORKSPACE_ROOT,
    tier: 't2',
    provider: 'opencode/opencode-go/mimo-v2.5',
    promptFile: 'prompts/lead.md',
  },
  {
    agentId: 'arch',
    name: 'Architect',
    role: 'arch',
    claimRole: 'arch',
    kind: 'agent',
    cwd: WORKSPACE_ROOT,
    tier: 't1',
    provider: 'claude/claude-sonnet-5',
    promptFile: 'prompts/arch.md',
  },
  {
    agentId: 'dev-1',
    name: 'Developer 1',
    role: 'dev-1',
    claimRole: 'dev-1',
    kind: 'agent',
    cwd: WORKSPACE_ROOT,
    tier: 't2',
    provider: 'opencode/opencode-go/mimo-v2.5',
    promptFile: 'prompts/dev-1.md',
  },
  {
    agentId: 'dev-2',
    name: 'Developer 2',
    role: 'dev-2',
    claimRole: 'dev-2',
    kind: 'agent',
    cwd: WORKSPACE_ROOT,
    tier: 't2',
    provider: 'opencode/opencode-go/mimo-v2.5',
    promptFile: 'prompts/dev-2.md',
  },
  {
    agentId: 'devops',
    name: 'Devops',
    role: 'devops',
    claimRole: 'devops',
    kind: 'agent',
    cwd: WORKSPACE_ROOT,
    tier: 't2',
    provider: 'opencode/opencode-go/mimo-v2.5',
    promptFile: 'prompts/devops.md',
  },
  {
    agentId: 'qa',
    name: 'QA',
    role: 'qa',
    claimRole: 'qa',
    kind: 'agent',
    cwd: WORKSPACE_ROOT,
    tier: 't2',
    provider: 'opencode/opencode-go/mimo-v2.5',
    promptFile: 'prompts/qa.md',
  },
]

/** Roster entry by agentId. */
export function getRosterProfile(agentId: string): TeamRosterProfile | undefined {
  return ROSTER.find(profile => profile.agentId === agentId)
}

/** Roster entry by org-chart role (same set here — role == agentId). */
export function getRosterByRole(role: string): TeamRosterProfile | undefined {
  return ROSTER.find(profile => profile.claimRole === role)
}

/** Registered agentIds in roster order. */
export const ROSTER_AGENT_IDS: readonly string[] = ROSTER.map(profile => profile.agentId)
