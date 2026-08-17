/**
 * Verify (issue #23): claudeQueryOptions with mcpServers passes the fleet MCP
 * server into the official Claude Agent SDK query options.
 *
 * Mocks the spawn hook so we never launch a real Claude Code process.
 * @module @hydra/dsh-fleet/tests/fleet-claude-query-options
 */

import { assertPass } from './harness.ts'
import {
  claudeQueryOptions,
  type ClaudeCodeRunSpec,
} from '../plugins/subagent-claude-code-fleet/src/run.ts'

function main(): void {
  console.log('fleet-claude-query-options: claudeQueryOptions must expose mcpServers')

  const spec: ClaudeCodeRunSpec = {
    cwd: '/tmp/fleet-test',
    executable: '/usr/bin/false',
    env: {},
    disposeGraceMs: 3_000,
    spawn: () => {
      throw new Error('spawn must not be invoked during option construction')
    },
    mcpServers: {
      fleet: {
        type: 'stdio',
        command: '/usr/bin/tsx',
        args: ['plugins/fleet-mcp/src/bin.ts'],
      },
    },
  }

  const controller = new AbortController()
  const options = claudeQueryOptions(spec, controller, () => {})

  assertPass(
    'options.mcpServers is defined',
    options.mcpServers !== undefined,
    JSON.stringify(options),
  )

  const fleet = (options.mcpServers as Record<string, { command?: string }>)['fleet']
  assertPass(
    'options.mcpServers contains the fleet server entry',
    fleet !== undefined && fleet.command === '/usr/bin/tsx',
    JSON.stringify(fleet),
  )

  console.log('fleet-claude-query-options: ALL PASS')
}

try {
  main()
} catch (error: unknown) {
  console.error(`fleet-claude-query-options: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
