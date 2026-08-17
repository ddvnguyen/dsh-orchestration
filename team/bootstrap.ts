/**
 * V3 team bootstrap — idempotent fleet setup (issue #30).
 *
 * Mounts the fleet team: registers every roster profile with fleet-agent
 * (ed25519 keypairs minted on first registration, NEVER rotated by re-running),
 * seeds the org chart into fleet-tasks (claimRole routing), and mounts the
 * team plugins (bus / identity / tasks / supervisor / watchdog / board) on one
 * Context. Safe to re-run any number of times — registration is idempotent
 * (plugins/fleet-agent/src/service.ts:145-160: re-register falls back to
 * the existing profile and never rotates the key), stores are durable under
 * `$DSH_HOME/fleet`, and the roster is a fixed constant.
 *
 * The OWNER is deliberately NOT registered (see team/roster.ts module doc): a
 * human operator has no ed25519 keypair and cannot claim tasks via claimWake,
 * so V3 registers only the six agent profiles.
 *
 * Run: tsx team/bootstrap.ts        (or)  FLEET_TEAM_HOME=<dir> tsx team/bootstrap.ts
 * @module @hydra/dsh-fleet/team/bootstrap
 */

import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FleetClock } from '../src/types.ts'
import { FleetAgentService } from '../plugins/fleet-agent/src/service.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import { FleetTasksService } from '../plugins/fleet-tasks/src/service.ts'
import { FleetSupervisorService } from '../plugins/fleet-supervisor/src/service.ts'
import { FleetWatchdogService } from '../plugins/fleet-watchdog/src/service.ts'
import { FleetBoardFeed } from '../plugins/fleet-board/src/feed.ts'
import { ROSTER, ROSTER_AGENT_IDS, type FleetTeamRole } from './roster.ts'
import { ORG_CHART, ROLE_TO_AGENT, QA_AGENT_ID, fleetTasksOrgChartConfig } from './org-chart.ts'

/** A fake delivery target the supervisor/bus can wake in headless setups. */
export interface TeamDeliveryTarget {
  followup(message: unknown): void
  inject(message: unknown): void
}

export interface MountTeamOptions {
  /** Fleet data root (default resolveDshHome()). Identity lives at <home>/fleet/agent. */
  home?: string
  /** Store dir for bus/tasks/supervisor (default <home>/fleet). */
  storeDir?: string
  /** Injectable clock (tests only; defaults to the system clock). */
  clock?: FleetClock
  /**
   * Delivery-target resolver for bus/supervisor wakes. Defaults to no live
   * delivery (headless); a real dsh deployment composes the agent registry.
   */
  resolveAgent?: (agentId: string) => TeamDeliveryTarget | undefined
}

/** The mounted team: services + the registered roster + resolved paths. */
export interface MountedTeam {
  ctx: Context
  home: string
  storeDir: string
  bus: FleetBusService
  identity: FleetAgentService
  tasks: FleetTasksService
  supervisor: FleetSupervisorService
  watchdog: FleetWatchdogService
  board: FleetBoardFeed
  /** The registered fleet-agent profiles, in roster order. */
  profiles: ReturnType<FleetAgentService['register']>[]
}

/**
 * Mount the V3 team (idempotent): register the roster, seed the org chart,
 * mount the plugins. Safe to call repeatedly — profiles merge (no duplicates,
 * keys never rotate), stores are durable.
 */
export function mountTeam(options: MountTeamOptions = {}): MountedTeam {
  const home = options.home ?? resolveDshHome()
  const storeDir = options.storeDir ?? join(home, 'fleet')
  const clock = options.clock

  const ctx = new Context()

  // Mount order matters: bus/identity first (tasks/supervisor/watchdog resolve
  // them via ctx.get at event time), then tasks (org-chart config), then the
  // supervisor (wakes INTO tasks' claimWake seam) and watchdog (verifies INTO
  // tasks' accept hook).
  const bus = new FleetBusService(ctx, {
    storeDir,
    clock,
    resolveAgent: options.resolveAgent as never,
  })
  const identity = new FleetAgentService(ctx, {
    home,
    // The identity service clocks via a plain function; adapt the FleetClock.
    ...(clock !== undefined ? { clock: () => clock.now() } : {}),
  })

  // Register every roster profile (idempotent — re-register never rotates keys).
  // P4.3: the roster seeds the full agent-config surface (claimRole/cwd/tier/
  // provider/promptFile); admin edits later override it via updateProfile.
  const profiles = ROSTER.map(profile =>
    identity.register({
      agentId: profile.agentId,
      name: profile.name,
      role: profile.claimRole,
      claimRole: profile.claimRole,
      cwd: profile.cwd,
      tier: profile.tier,
      provider: profile.provider,
      promptFile: profile.promptFile,
      status: 'active',
    }),
  )

  // Seed the org chart into fleet-tasks (claimRole routing for claimWake).
  const tasks = new FleetTasksService(ctx, {
    dir: storeDir,
    clock,
    ...fleetTasksOrgChartConfig(),
  })

  const supervisor = new FleetSupervisorService(ctx, {
    storeDir,
    clock,
    resolveAgent: options.resolveAgent as never,
  })

  // Watchdog reassigns false-done leaves by org-chart role (role → agent).
  const watchdog = new FleetWatchdogService(ctx, {
    clock,
    reassignAgents: { ...ROLE_TO_AGENT },
  })

  // Board reads the same durable bus store (no dsh session dependency).
  const board = new FleetBoardFeed({ storeDir })

  return { ctx, home, storeDir, bus, identity, tasks, supervisor, watchdog, board, profiles }
}

/**
 * Author agent presets for ALL roster entries into `$DSH_HOME/.agent-presets/`
 * (idempotent — writes preset.yml + agent.cordis.yml if absent).
 * Safe to re-run: existing files are never overwritten.
 */
export function authorFleetPresets(home: string): Record<string, { presetYml: string; cordisYml: string }> {
  const presetsDir = join(home, '.agent-presets')
  const results: Record<string, { presetYml: string; cordisYml: string }> = {}

  /** Persona text per role — brief summary; the prompt file is mounted via agent-instructions. */
  const personaTexts: Record<FleetTeamRole, string> = {
    lead: 'You are the Lead for the V3 fleet. You PLAN, DELEGATE, SUPERVISE, and GATE. You do NOT implement code yourself.',
    arch: 'You are the Architect for the V3 fleet. You design system architecture, evaluate tradeoffs, and guide technical decisions.',
    'dev-1': 'You are Developer 1 for the V3 fleet. You implement features, fix bugs, and write code.',
    'dev-2': 'You are Developer 2 for the V3 fleet. You implement features, fix bugs, and write code.',
    devops: 'You are the DevOps engineer for the V3 fleet. You manage infrastructure, deployments, CI/CD, and monitoring.',
    qa: 'You are the QA engineer for the V3 fleet. You review code, run verification, and gate merges.',
  }

  /** Preset description per role. */
  const descriptions: Record<FleetTeamRole, string> = {
    lead: 'Fleet leader session — plan, delegate, supervise, gate. Carries the full fleet tool family plus native subagent capability.',
    arch: 'Fleet architect session — design, evaluate tradeoffs, guide technical decisions. Carries fleet-agent, fleet-board, and fleet-policy tools.',
    'dev-1': 'Fleet developer 1 session — implement features, fix bugs, write tests. Carries fleet-agent and fleet-board tools.',
    'dev-2': 'Fleet developer 2 session — implement features, fix bugs, write tests. Carries fleet-agent and fleet-board tools.',
    devops: 'Fleet DevOps session — manage infrastructure, deployments, CI/CD. Carries fleet-agent, fleet-board, and fleet-teams tools.',
    qa: 'Fleet QA session — review code, run verification, gate merges. Carries fleet-agent and fleet-board tools.',
  }

  /** Preset order per role. */
  const orders: Record<FleetTeamRole, number> = {
    lead: 10, arch: 20, 'dev-1': 30, 'dev-2': 40, devops: 50, qa: 60,
  }

  /** Role-specific fleet tools (fleet-agent is always included). */
  const fleetToolsYml: Record<FleetTeamRole, string> = {
    lead: [
      '# fleet-agent: agent identity + signed events + admin tools.',
      '- id: fleet-agent',
      "  name: '@hydra/dsh-fleet-agent'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '    autoRegisterAgents: true',
      '',
      '# fleet-teams: team_*/room_* tools — membership, grants, rooms, posting.',
      '- id: fleet-teams',
      "  name: '@hydra/dsh-fleet-teams'",
      '  inject: []',
      '  config:',
      '    injectTools: true',
      '',
      '# fleet-board: fleet_feed tool — transparency feed for supervision reads.',
      '- id: fleet-board',
      "  name: '@hydra/dsh-fleet-board'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '',
      '# fleet-policy: policy_* tools — authorize seam for the lead gate role.',
      '- id: fleet-policy',
      "  name: '@hydra/dsh-fleet-policy'",
      '  inject: []',
      '  config:',
      '    injectTools: true',
      '',
      '# fleet-budget: budget_* tools — budget reads and escalation.',
      '- id: fleet-budget',
      "  name: '@hydra/dsh-fleet-budget'",
      '  inject: []',
      '  config:',
      '    injectTools: true',
    ].join('\n'),
    arch: [
      '# fleet-agent: agent identity + signed events + admin tools.',
      '- id: fleet-agent',
      "  name: '@hydra/dsh-fleet-agent'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '    autoRegisterAgents: true',
      '',
      '# fleet-board: fleet_feed tool — transparency feed for supervision reads.',
      '- id: fleet-board',
      "  name: '@hydra/dsh-fleet-board'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '',
      '# fleet-policy: policy_* tools — authorize seam for the architect role.',
      '- id: fleet-policy',
      "  name: '@hydra/dsh-fleet-policy'",
      '  inject: []',
      '  config:',
      '    injectTools: true',
    ].join('\n'),
    'dev-1': [
      '# fleet-agent: agent identity + signed events + admin tools.',
      '- id: fleet-agent',
      "  name: '@hydra/dsh-fleet-agent'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '    autoRegisterAgents: true',
      '',
      '# fleet-board: fleet_feed tool — transparency feed for supervision reads.',
      '- id: fleet-board',
      "  name: '@hydra/dsh-fleet-board'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
    ].join('\n'),
    'dev-2': [
      '# fleet-agent: agent identity + signed events + admin tools.',
      '- id: fleet-agent',
      "  name: '@hydra/dsh-fleet-agent'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '    autoRegisterAgents: true',
      '',
      '# fleet-board: fleet_feed tool — transparency feed for supervision reads.',
      '- id: fleet-board',
      "  name: '@hydra/dsh-fleet-board'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
    ].join('\n'),
    devops: [
      '# fleet-agent: agent identity + signed events + admin tools.',
      '- id: fleet-agent',
      "  name: '@hydra/dsh-fleet-agent'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '    autoRegisterAgents: true',
      '',
      '# fleet-board: fleet_feed tool — transparency feed for supervision reads.',
      '- id: fleet-board',
      "  name: '@hydra/dsh-fleet-board'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '',
      '# fleet-teams: team_*/room_* tools — membership, grants, rooms, posting.',
      '- id: fleet-teams',
      "  name: '@hydra/dsh-fleet-teams'",
      '  inject: []',
      '  config:',
      '    injectTools: true',
    ].join('\n'),
    qa: [
      '# fleet-agent: agent identity + signed events + admin tools.',
      '- id: fleet-agent',
      "  name: '@hydra/dsh-fleet-agent'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
      '    autoRegisterAgents: true',
      '',
      '# fleet-board: fleet_feed tool — transparency feed for supervision reads.',
      '- id: fleet-board',
      "  name: '@hydra/dsh-fleet-board'",
      "  inject: ['webServer']",
      '  config:',
      '    injectTools: true',
    ].join('\n'),
  }

  for (const profile of ROSTER) {
    const presetDir = join(presetsDir, `fleet-${profile.agentId}`)
    const presetYmlPath = join(presetDir, 'preset.yml')
    const cordisYmlPath = join(presetDir, 'agent.cordis.yml')

    if (existsSync(presetYmlPath) && existsSync(cordisYmlPath)) {
      results[profile.agentId] = { presetYml: presetYmlPath, cordisYml: cordisYmlPath }
      continue
    }

    mkdirSync(presetDir, { recursive: true })

    const presetContent = [
      `name: Fleet ${profile.name}`,
      `description: ${descriptions[profile.agentId]}`,
      `order: ${orders[profile.agentId]}`,
      '',
    ].join('\n')

    const cordisContent = [
      `# Fleet ${profile.name} agent-plane composition.`,
      '#',
      '# Fleet plugins (fleet-agent, fleet-teams, fleet-board, fleet-policy, fleet-budget)',
      '# are provided by the host composition (fleet-web.patch.yml) with injectTools: true.',
      '# This preset provides: persona, instructions, shell, and delegation only.',
      '',
      '# ── identity ────────────────────────────────────────────────────────────────',
      '',
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    text: >-',
      `      ${personaTexts[profile.agentId]}`,
      '',
      '- id: agent-instructions',
      "  name: '@deepseek-ai/dsh-agent-instructions'",
      '  config:',
      '    maxBytes: 65536',
      '',
      '# ── shell ───────────────────────────────────────────────────────────────────',
      '',
      '- id: tool-bash',
      "  name: '@deepseek-ai/dsh-tool-bash'",
      "  disabled: !!js process.platform === 'win32'",
      '',
      '- id: tool-pwsh',
      "  name: '@deepseek-ai/dsh-tool-pwsh'",
      "  disabled: !!js process.platform !== 'win32'",
      '',
      '# ── delegation ──────────────────────────────────────────────────────────────',
      '',
      '- id: delegation',
      '  name: cordis:group',
      '  group: true',
      '  isolate:',
      '    workflowEngine: true',
      '  config:',
      '    - id: tool-subagent',
      "      name: '@deepseek-ai/dsh-tool-subagent'",
      '      config:',
      '        provider: spawn',
      '        toolName: subagent',
      '        backgroundMode: continuable',
      '',
      '    - id: tool-subagent-fork',
      "      name: '@deepseek-ai/dsh-tool-subagent'",
      '      config:',
      '        provider: fork',
      '        toolName: subagent_fork',
      '        backgroundMode: continuable',
      '',
    ].join('\n')

    writeFileSync(presetYmlPath, presetContent)
    writeFileSync(cordisYmlPath, cordisContent)

    results[profile.agentId] = { presetYml: presetYmlPath, cordisYml: cordisYmlPath }
  }

  return results
}

/** A human-readable summary of the mounted team (roster print). */
export function rosterSummary(team: MountedTeam): string {
  const lines: string[] = []
  lines.push(`V3 team mounted — home=${team.home} store=${team.storeDir}`)
  lines.push(`roster: ${team.profiles.length} profiles (${ROSTER_AGENT_IDS.join(', ')})`)
  for (const profile of team.profiles) {
    const roster = ROSTER.find(entry => entry.agentId === profile.agentId)
    lines.push(
      `  ${profile.agentId}  role=${profile.role}  name="${profile.name}"  `
      + `tier=${roster?.tier ?? '?'}  pubkey=${profile.publicKey.slice(0, 16)}…  prompt=${roster?.promptFile ?? '?'}`,
    )
  }
  lines.push(`org chart (agent → role): ${JSON.stringify(ORG_CHART)}`)
  lines.push(`claim roles (role → agent): ${JSON.stringify(ROLE_TO_AGENT)}`)
  lines.push(`qa gate agent: ${QA_AGENT_ID}`)
  lines.push(`contract: team/leader-contract.md v3.0.0 · job protocol: team/job-protocol.md`)
  return lines.join('\n')
}

/** Run bootstrap as a script: mount, print the roster, author all fleet presets, exit 0. */
export async function run(): Promise<void> {
  const home = process.env.FLEET_TEAM_HOME ?? resolveDshHome()
  const team = mountTeam({ home })
  console.log(rosterSummary(team))

  const presets = authorFleetPresets(home)
  for (const [agentId, paths] of Object.entries(presets)) {
    console.log(`fleet-${agentId} preset: ${paths.presetYml}`)
    console.log(`fleet-${agentId} cordis: ${paths.cordisYml}`)
  }

  console.log('bootstrap: OK (idempotent — safe to re-run)')
}

/** True when this module is the tsx entry point (not imported by a test). */
function isDirectRun(): boolean {
  const arg = process.argv[1]
  if (arg === undefined) return false
  return import.meta.url === pathToFileURL(resolve(arg)).href
}

// Direct execution (tsx team/bootstrap.ts), mirroring the family smoke tests.
if (isDirectRun()) {
  run().catch((error: unknown) => {
    console.error(`bootstrap: FAILED — ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
