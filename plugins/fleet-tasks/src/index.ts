/**
 * @hydra/dsh-fleet-tasks — the V3 flagship: a shared task queue with org chart,
 * heartbeat-wake claim, execution locks, and artifact contracts.
 *
 * A Cordis plugin in the dsh house style (function plugin: named exports
 * `name` / `inject` / `Config` / `apply`, see `@deepseek-ai/dsh-tool-todo` as
 * the registration template). It constructs the {@link FleetTasksService}
 * (registers `ctx.fleetTasks`) and registers six model-facing tools on the
 * global `ctx.tools` registry (the tool-todo pattern,
 * packages/todo/tool-todo/src/index.ts:149) so ANY in-process agent can create,
 * list, claim, complete, escalate, and accept tasks. The tools use `exec.agent`
 * for caller identity (packages/core/tools/src/index.ts:360-361).
 *
 * ```
 * - id: fleet-tasks
 *   name: '@hydra/dsh-fleet-tasks'
 *   config:
 *     dir: ''               # default $DSH_HOME/fleet (durable SQLite store)
 *     orgChart: {}          # optional agentId → role routing table
 * ```
 *
 * Deps: self-contained — `ctx.fleetBus` (event publish) and `ctx.fleetAgent`
 * (signed events + role resolution) are resolved optionally at mutation time.
 * @module @hydra/dsh-fleet-tasks
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { FleetTasksService, type FleetTasksConfig } from './service.ts'
import type { FleetTaskClaimResult } from './types.ts'

export const name = 'fleet-tasks'
/** Self-contained: ctx.fleetBus / ctx.fleetAgent are resolved optionally. */
export const inject: string[] = []

/** Schemastery configuration schema for the plugin consumer. */
export interface Config extends FleetTasksConfig {}

export const Config: z<Config> = z.object({
  /** Directory holding the SQLite store. Default `$DSH_HOME/fleet`. */
  dir: z.string(),
  /** Store file name. Default `fleet-tasks.sqlite`. */
  file: z.string(),
  /** Injectable clock (tests only). */
  clock: z.any(),
  /** Org chart: agentId → role (claimWake routing). */
  orgChart: z.any(),
  /** Role resolver override (tests only). */
  resolveRole: z.any(),
  /** Honor claimRole routing hints in claimWake (default true). */
  honorClaimRole: z.boolean(),
  /** Auto-close descendants on parent complete/cancel (default true). */
  autoCloseSubtree: z.boolean(),
})

export function apply(ctx: Context, config: Config): void {
  const tasks = new FleetTasksService(ctx, config)
  registerFleetTaskTools(ctx, tasks)
}

/** Scoped tools only run inside an agent; a caller without one has no id. */
function requireAgent(agent: { id: string } | undefined): { id: string } {
  if (agent === undefined) {
    throw new Error('fleet tools require an owning agent session')
  }
  return agent
}

/** Narrow a JSON output value to a record for render-time shaping. */
function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function renderTaskSummary(value: JsonValue | undefined, prefix: string): { type: 'text'; text: string }[] {
  const record = asRecord(value)
  const task = asRecord(record?.task as JsonValue | undefined)
  if (task === undefined) return [{ type: 'text', text: `${prefix}: no task returned` }]
  const id = String(task.id)
  const state = String(task.state)
  const assignee = task.assignee === undefined ? 'unclaimed' : String(task.assignee)
  return [{ type: 'text', text: `${prefix} ${id} [${state}, ${assignee}] "${String(task.title)}"` }]
}

/** Register the six fleet-tasks tools on the global tools registry. */
function registerFleetTaskTools(ctx: Context, tasks: FleetTasksService): void {
  ctx.tools.register(defineTool({
    name: 'task_create',
    description: 'Create a task in the shared fleet queue. Every task carries a fixed workflow state (Triage/Backlog/Unstarted), a severity (P0/P1/P2), an optional goal ancestry (parentId links this task under a top-level goal), an optional org-chart claimRole, and an optional artifact contract {expectedResult, metric, passRange} that its completion evidence must satisfy.',
    parameters: {
      title: { type: 'string', required: true, description: 'The task title.' },
      state: { type: 'string', enum: ['Triage', 'Backlog', 'Unstarted'], description: 'Initial state (default Triage).' },
      severity: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'Severity (default P1).' },
      priority: { type: 'string', description: 'Free-form priority hint (e.g. "high", "3").' },
      parentId: { type: 'string', description: 'Parent task id: makes this a sub-issue under a goal (goal ancestry is derived; a completed parent auto-closes its descendants).' },
      claimRole: { type: 'string', description: 'Org-chart role that should claim this task (claimWake routes by it).' },
      artifactContract: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expectedResult: { type: 'string', required: true, description: 'What "done" means, in words.' },
          metric: { type: 'string', required: true, description: 'The exact metric to measure (e.g. "exit-code", "tests-passed").' },
          passRange: { type: 'string', required: true, description: 'PASS predicate over the metric, e.g. "== 0", ">= 1".' },
        },
        description: 'Artifact contract; a completion must satisfy it or accept() rejects the completion as false-done.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderTaskSummary(value, 'Created'),
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const task = tasks.create({
        title: args.title,
        ...(args.state !== undefined ? { state: args.state } : {}),
        ...(args.severity !== undefined ? { severity: args.severity } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        ...(args.claimRole !== undefined ? { claimRole: args.claimRole } : {}),
        ...(args.artifactContract !== undefined ? { artifactContract: args.artifactContract } : {}),
      }, caller.id)
      return { task } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Create fleet task', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'task_list',
    description: 'List tasks in the shared fleet queue, optionally filtered by state / assignee / goal ancestry / severity. Use it to see what work exists before claiming.',
    parameters: {
      state: { type: 'string', enum: ['Triage', 'Backlog', 'Unstarted', 'Started', 'Completed', 'Cancelled'], description: 'Only tasks in exactly this state.' },
      assignee: { type: 'string', description: 'Only tasks assigned to exactly this agent id.' },
      goal: { type: 'string', description: 'Only tasks whose goal ancestry contains this goal task id.' },
      severity: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'Only tasks with exactly this severity.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        const list = Array.isArray(record?.tasks) ? record.tasks : []
        return [{ type: 'text', text: `Fleet tasks: ${list.length} matching` }]
      },
    },
    async execute(args, exec) {
      requireAgent(exec.agent)
      const tasksList = tasks.list({
        ...(args.state !== undefined ? { state: args.state } : {}),
        ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.severity !== undefined ? { severity: args.severity } : {}),
      })
      return { tasks: tasksList } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'List fleet tasks', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'task_claim',
    description: 'Atomically claim a task for one agent (single assignee + execution lock). Only one claimant can ever win a task. Returns the claim token — keep it to complete/cancel the task while you hold the lock.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The task id to claim.' },
      agentId: { type: 'string', description: 'Claiming agent id (default: the calling agent).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        if (record?.ok === false) {
          return [{ type: 'text', text: `Claim failed: ${String(record.reason ?? 'unknown')}` }]
        }
        return renderTaskSummary(value, 'Claimed')
      },
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const result: FleetTaskClaimResult = tasks.claim(args.taskId, args.agentId ?? caller.id)
      if (!result.ok) return { ok: false, reason: result.reason } as unknown as JsonValue
      return { ok: true, task: result.task, token: result.token } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Claim fleet task', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'task_complete',
    description: 'Complete a claimed task by submitting artifact evidence. Requires the claim token from task_claim and an evidence result — the measured value of the task\'s artifact-contract metric (e.g. exit-code "0", tests-passed "12"). Completing a parent auto-completes its descendant sub-issues. Acceptance is pending until task_accept verifies the evidence against the contract.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The task id to complete.' },
      token: { type: 'string', required: true, description: 'The claim token returned by task_claim.' },
      evidence: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'string', required: true, description: 'Measured metric value (number as string, e.g. "0", "12").' },
          notes: { type: 'string', description: 'Free-form notes on how the result was produced.' },
          artifacts: { type: 'array', items: { type: 'string' }, description: 'Artifact references (file paths, run ids).' },
        },
        required: true,
        description: 'Artifact evidence for the task\'s contract metric.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderTaskSummary(value, 'Completed'),
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const task = tasks.complete(args.taskId, args.token, {
        result: args.evidence.result,
        ...(args.evidence.notes !== undefined ? { notes: args.evidence.notes } : {}),
        ...(args.evidence.artifacts !== undefined ? { artifacts: args.evidence.artifacts } : {}),
      }, caller.id)
      return { task } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Complete fleet task', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'task_escalate',
    description: 'Escalate a task by severity with a named owner and a next action (gastown pattern). Raises the task\'s severity and records the escalation so a lead/watchdog knows who owns it and what must happen next.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The task id to escalate.' },
      severity: { type: 'string', enum: ['P0', 'P1', 'P2'], required: true, description: 'Escalated severity.' },
      owner: { type: 'string', required: true, description: 'Named owner responsible for the escalation.' },
      nextAction: { type: 'string', required: true, description: 'The next concrete action the escalation requires.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderTaskSummary(value, 'Escalated'),
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const task = tasks.escalate(args.taskId, {
        severity: args.severity,
        owner: args.owner,
        nextAction: args.nextAction,
      }, caller.id)
      return { task } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Escalate fleet task', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'task_accept',
    description: 'Verify a completed task\'s artifact evidence against its artifact contract (watchdog hook). On PASS the completion is accepted. On FAIL the completion is REJECTED as false-done: the task reopens to Unstarted, the assignee + execution lock are released, and a fleet/task-rejected event is published. A task without a contract is accepted trivially.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The completed task id to verify.' },
      evidence: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'string', required: true, description: 'Measured metric value (number as string).' },
          notes: { type: 'string', description: 'Free-form notes.' },
          artifacts: { type: 'array', items: { type: 'string' }, description: 'Artifact references.' },
        },
        description: 'Override evidence (defaults to the task\'s stored evidence).',
      },
      artifactContract: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expectedResult: { type: 'string', required: true },
          metric: { type: 'string', required: true },
          passRange: { type: 'string', required: true },
        },
        description: 'Override contract (defaults to the task\'s artifactContract).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const record = asRecord(value)
        if (record?.accepted === true) return renderTaskSummary(value, 'Accepted')
        const reason = typeof record?.reason === 'string' ? ` (${record.reason})` : ''
        return [{ type: 'text', text: `Rejected as false-done${reason}` }]
      },
    },
    async execute(args, exec) {
      const caller = requireAgent(exec.agent)
      const result = tasks.accept(args.taskId, {
        ...(args.evidence !== undefined ? {
          evidence: {
            result: args.evidence.result,
            ...(args.evidence.notes !== undefined ? { notes: args.evidence.notes } : {}),
            ...(args.evidence.artifacts !== undefined ? { artifacts: args.evidence.artifacts } : {}),
          },
        } : {}),
        ...(args.artifactContract !== undefined ? { artifactContract: args.artifactContract } : {}),
      }, caller.id)
      return { accepted: result.accepted, task: result.task, reason: result.reason } as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Accept fleet task', kind: 'other', rawInput: args }),
  }))
}

/** Re-export the vocabulary for consumers of the plugin. */
export type { FleetTask, FleetTaskClaimResult } from './types.ts'
