import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  applyChildComposition,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  appendDelegatedPolicyOverrides,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import type { Config } from './config.ts'
import { createWorktree, removeWorktree } from './worktree.ts'

function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    default:
      return 'error'
  }
}

/**
 * A DSH-native SubagentProvider that creates isolated child agents running
 * in dedicated git worktrees. Each child gets its own filesystem and session,
 * while sharing the parent's process and Cordis context.
 */
export class FleetAgentProvider implements SubagentProvider {
  readonly name = 'fleet'
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    assertSubagentMaxDepth(request.maxDepth)
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before child publication')
    }

    const parent = request.parent
    const childDepth = resolveChildDepth(parent, request.maxDepth)
    const childId = SessionId(crypto.randomUUID())

    const inherited = captureDelegatedPolicyOverrides(parent)

    // Create an isolated worktree for this child agent
    const worktreePath = createWorktree(this.config.repoRoot, this.config.worktreeBase)

    let agentHandle: AgentHandle | undefined
    let worktreeCleanedUp = false

    const cleanupWorktree = (): void => {
      if (!worktreeCleanedUp) {
        worktreeCleanedUp = true
        try {
          removeWorktree(this.config.repoRoot, worktreePath)
        } catch {
          // Best-effort cleanup; the worktree remains on disk if removal fails.
        }
      }
    }

    try {
      const setup = (childCtx: Context): void => {
        appendDelegatedPolicyOverrides((childCtx.agent as Agent).session, inherited)
        applyChildComposition(childCtx, parent, {
          persona: request.persona,
          toolFilter: request.toolFilter,
        })
        // Append the one-shot descriptor into the child's initial turn
        let appended = false
        childCtx.on('agent/pre-step', async ({ agent }, next) => {
          const decision = await next()
          if (!appended && decision.kind === 'enter') {
            appended = true
            agent.session.append('subagent/descriptor', request.descriptor)
          }
          return decision
        })
      }

      agentHandle = await this.ctx.agents.create({
        sessionId: childId,
        meta: {
          ...childSessionMeta(parent, childDepth, 0),
          cwd: worktreePath,
        },
        agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
        signal: request.signal,
        setup,
      })

      const child = agentHandle.agent
      const flags = { cancelled: false }

      const onAbort = (): void => {
        flags.cancelled = true
        child.cancel({ kind: 'parent' })
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()

      const result: Promise<SubagentResult> = (async () => {
        try {
          if (!flags.cancelled) {
            child.followup(createUserMessage({ content: request.prompt, source: { kind: 'user' } }))
            await child.whenIdle()
          }
          return readResult(child, 0, flags.cancelled)
        } finally {
          request.signal.removeEventListener('abort', onAbort)
          cleanupWorktree()
        }
      })()

      return {
        id: childId,
        localAgent: child,
        result,
        async dispose(): Promise<void> {
          request.signal.removeEventListener('abort', onAbort)
          flags.cancelled = true
          const settlements = await Promise.allSettled([agentHandle!.dispose(), result])
          const disposal = settlements[0]
          if (disposal.status === 'rejected') throw disposal.reason
        },
      }
    } catch (err) {
      cleanupWorktree()
      throw err
    }
  }

  async prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // A fleet child starts fresh — no seed from parent history.
    void request
    return {}
  }
}

function readResult(
  child: Agent,
  boundary: number,
  cancelled: boolean,
): SubagentResult {
  const own = child.session.events.slice(boundary)
  const lastEnd = foldConsumedWork(own).end
  const output: ContentBlock[] = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  const stopReason: SubagentStopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  return { output, stopReason }
}
