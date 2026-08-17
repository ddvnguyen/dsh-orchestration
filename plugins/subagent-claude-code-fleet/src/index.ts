/**
 * Fixed Claude Code fleet subagent provider. Forked from
 * `@deepseek-ai/dsh-subagent-claude-code` to add `mcpServers` support for
 * Claude Code children. The extra config threads through to the official
 * Agent SDK query options exactly like Paseo's fleet wiring.
 *
 * @module @hydra/dsh-subagent-claude-code-fleet
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  startClaudeCodeRun,
  type ClaudeCodeRunSpec,
  type FleetMcpServerConfig,
} from './run.ts'

export const name = 'subagent-claude-code-fleet'
export const inject = ['subagents', 'subprocess']

/* jscpd:ignore-start -- sibling product providers intentionally expose the
 * same deployment-owned fields without adding a shared config owner. */
/** Deployment-owned environment and process-release bound. */
export interface Config {
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for Claude Code process-tree termination. */
  disposeGraceMs?: number
  /** MCP server configs injected into the Claude SDK query options. */
  mcpServers?: Record<string, FleetMcpServerConfig>
}

export const Config: z<Config> = z.object({
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  mcpServers: z.any(),
})

type ResolvedConfig = Required<Pick<Config, 'env' | 'disposeGraceMs'>> & Pick<Config, 'mcpServers'>
/* jscpd:ignore-end */

/* jscpd:ignore-start -- Cordis registration and shared-seam plumbing mirror
 * the Codex sibling; each product's lifecycle remains package-private. */
class ClaudeCodeFleetProvider implements SubagentProvider {
  readonly name = 'claude-code-fleet'
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-claude-code-fleet: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const executable = await this.ctx.subprocess.resolveExecutable(
      'claude',
      this.config.env,
      request.signal,
    )
    const spec: ClaudeCodeRunSpec = {
      cwd: resolveChildCwd(
        'subagent-claude-code-fleet',
        undefined,
        parentCwd,
      ),
      executable,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      mcpServers: this.config.mcpServers,
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-claude-code-fleet: child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startClaudeCodeRun(request, spec)
  }
}

/**
 * Register the fixed `claude-code-fleet` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - explicit child environment, disposal grace, and fleet MCP servers.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite(
    'subagent-claude-code-fleet',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-claude-code-fleet: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new ClaudeCodeFleetProvider(ctx, resolved))
}
/* jscpd:ignore-end */
