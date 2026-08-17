/**
 * One-shot Claude Code lifecycle with fleet MCP support: invoke the official
 * Agent SDK, optionally inject MCP servers into the query options, place the
 * real CLI process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-tree quiescence.
 *
 * Forked from `@deepseek-ai/dsh-subagent-claude-code/run.ts` to add
 * `mcpServers` support for Claude Code children. The conversion mirrors
 * `toClaudeSdkMcpConfig` from Paseo:
 *   external/paseo/packages/server/src/server/agent/providers/claude/agent.ts:973
 * @module @hydra/dsh-subagent-claude-code-fleet/run
 */

import { randomUUID } from 'node:crypto'
import {
  query as officialQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
  type McpStdioServerConfig,
  type McpSSEServerConfig,
  type McpHttpServerConfig,
  type McpServerConfig as ClaudeSdkMcpServerConfig,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/* jscpd:ignore-start -- sibling providers intentionally keep product-private
 * run inputs and error normalization instead of adding a shared lifecycle owner. */
/** Stdio-based MCP server config accepted from cordis.yml. */
export interface FleetMcpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  timeout?: number
  alwaysLoad?: boolean
}

/** HTTP-based MCP server config accepted from cordis.yml. */
export interface FleetMcpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
  alwaysLoad?: boolean
}

/** SSE-based MCP server config accepted from cordis.yml. */
export interface FleetMcpSseServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
  alwaysLoad?: boolean
}

/** Canonical MCP server configuration accepted from fleet plugin config. */
export type FleetMcpServerConfig =
  | FleetMcpStdioServerConfig
  | FleetMcpHttpServerConfig
  | FleetMcpSseServerConfig

/** Fully resolved inputs for one official Claude Agent SDK query. */
export interface ClaudeCodeRunSpec {
  /** Parent Session workspace supplied to the SDK and real CLI. */
  readonly cwd: string
  /** Exact native Claude Code executable resolved from the host PATH. */
  readonly executable: string
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
  /** MCP server configs injected into the Claude SDK query options. */
  readonly mcpServers?: Record<string, FleetMcpServerConfig>
}
/* jscpd:ignore-end */

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Normalize a fleet MCP server config into the official Claude SDK MCP config type.
 * Mirrors `toClaudeSdkMcpConfig` from:
 *   external/paseo/packages/server/src/server/agent/providers/claude/agent.ts:973
 */
export function toClaudeSdkMcpConfig(config: FleetMcpServerConfig): ClaudeSdkMcpServerConfig {
  switch (config.type) {
    case 'http':
      return {
        type: 'http',
        url: (config as FleetMcpHttpServerConfig).url,
        headers: (config as FleetMcpHttpServerConfig).headers,
        alwaysLoad: (config as FleetMcpHttpServerConfig).alwaysLoad,
      } as McpHttpServerConfig as ClaudeSdkMcpServerConfig
    case 'sse':
      return {
        type: 'sse',
        url: (config as FleetMcpSseServerConfig).url,
        headers: (config as FleetMcpSseServerConfig).headers,
        alwaysLoad: (config as FleetMcpSseServerConfig).alwaysLoad,
      } as McpSSEServerConfig as ClaudeSdkMcpServerConfig
  }

  const stdio = config as FleetMcpStdioServerConfig
  return {
    type: 'stdio',
    command: stdio.command,
    args: stdio.args,
    env: stdio.env,
    timeout: stdio.timeout,
    alwaysLoad: stdio.alwaysLoad,
  } as McpStdioServerConfig as ClaudeSdkMcpServerConfig
}

/** Normalize a fleet mcpServers record into the official SDK MCP config record. */
export function normalizeFleetMcpServers(
  servers: Record<string, FleetMcpServerConfig>,
): Record<string, ClaudeSdkMcpServerConfig> {
  const result: Record<string, ClaudeSdkMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    result[name] = toClaudeSdkMcpConfig(config)
  }
  return result
}

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-claude-code-fleet: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code-fleet: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-claude-code-fleet: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - an official discriminated result union.
 * @returns exact final text for a successful, non-error result.
 */
export function successfulResult(message: SDKResultMessage): string {
  if (
    message.subtype !== 'success'
    || message.is_error
    || message.result.trim().length === 0
  ) {
    const detail = message.subtype === 'success'
      ? 'success result was marked as an error or contained no answer'
      : message.errors.join('; ') || message.subtype
    throw new Error(`subagent-claude-code-fleet: Claude Code failed: ${detail}`)
  }
  return message.result
}

/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion.
 * @param query - published official SDK query.
 * @returns the completed shared result.
 */
export async function consumeClaudeQuery(
  query: AsyncIterable<SDKMessage>,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const message of query) {
    if (message.type !== 'result') continue
    answer = successfulResult(message)
  }
  if (answer === undefined) {
    throw new Error('subagent-claude-code-fleet: Claude Code ended without a result')
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Close the official query, terminate the managed process tree, and wait for
 * the subprocess owner to prove it is gone.
 * @param query - official SDK query, when creation reached that point.
 * @param child - shared-service handle that owns the CLI process tree.
 */
export async function disposeClaudeCodeChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  try {
    query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  if (child.pid > 0) {
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
  }
  try {
    await child.done
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'subagent-claude-code-fleet: query and process cleanup failed',
    )
  }
}

/**
 * Build the fixed official SDK options for one one-shot provider run.
 * @param spec - Workspace, environment, process service, disposal policy, and optional MCP servers.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the real managed child synchronously from the SDK hook.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
export function claudeQueryOptions(
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  capture: (child: SubprocessHandle) => void,
): Options {
  const base: Options = {
    abortController: controller,
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: spec.executable,
    env: { ...scrubbedParentEnv(), ...spec.env },
    persistSession: false,
    disallowedTools: ['AskUserQuestion'],
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      capture(child)
      return new ManagedClaudeCodeProcess(child)
    },
  }

  if (spec.mcpServers !== undefined) {
    base.mcpServers = normalizeFleetMcpServers(spec.mcpServers)
  }

  return base
}

/**
 * Start one official Claude Agent SDK query and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after both Query and real CLI handle exist.
 */
export async function startClaudeCodeRun(
  request: SubagentStartRequest,
  spec: ClaudeCodeRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-claude-code-fleet: request was aborted before SDK startup')
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code-fleet: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let child: SubprocessHandle | undefined
  let query: Query | undefined
  try {
    query = officialQuery({
      prompt,
      options: claudeQueryOptions(spec, controller, (captured) => {
        child = captured
      }),
    })
    if (child === undefined || child.pid <= 0) {
      throw new Error(
        'subagent-claude-code-fleet: official SDK did not publish a controllable Claude Code process',
      )
    }
    if (controller.signal.aborted) {
      throw new Error('subagent-claude-code-fleet: request was aborted before SDK startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeClaudeCodeChild(query, child)
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code-fleet: startup failed and CLI cleanup also failed',
        )
      }
    } else if (query !== undefined) {
      try {
        query.close()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code-fleet: startup failed and query cleanup also failed',
        )
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the request can abort while process cleanup is awaited.
    if (cancelledBeforeCleanup || request.signal.aborted) {
      throw new Error('subagent-claude-code-fleet: request was aborted before SDK startup')
    }
    throw thrown(error)
  }

  const publishedQuery = query
  const publishedChild = child
  const result = settleRunResult({
    attempt: () => consumeClaudeQuery(publishedQuery),
    collectOutput: () => [],
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeClaudeCodeChild(
      publishedQuery,
      publishedChild,
    ),
  })
}
