/**
 * Shared smoke-test harness for the dsh fleet prototype. Plain node scripts
 * run via tsx (submodule's binary) with node:assert — no vitest plumbing.
 * @module @hydra/dsh-fleet/tests/harness
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { apply as applyHeartbeat, type Config as HeartbeatConfig } from '../plugins/fleet-heartbeat/src/index.ts'
import type { FleetClock } from '../src/types.ts'

/** Mutable fake clock: tests advance `now` deterministically. */
export function fakeClock(start = 1_000_000): FleetClock & { advance(ms: number): void; current(): number } {
  let value = start
  return {
    now: () => value,
    advance(ms: number): void { value += ms },
    current: () => value,
  }
}

export interface MountedFleet {
  ctx: Context
  clock: FleetClock & { advance(ms: number): void; current(): number }
}

/** Mount fleet-heartbeat on a fresh Context with a fake clock. */
export function mountHeartbeat(overrides: Partial<HeartbeatConfig> = {}): MountedFleet {
  const clock = fakeClock()
  const ctx = new Context()
  applyHeartbeat(ctx, {
    stallThresholdMs: 10 * 60 * 1000,
    tickMs: 30_000,
    clock,
    ...overrides,
  })
  assert.ok(ctx.fleet !== undefined, 'ctx.fleet must be registered by fleet-heartbeat')
  return { ctx, clock }
}

/** Mount fleet-heartbeat + the REAL dsh session store (for the ledger mirror). */
export async function mountHeartbeatWithSessions(overrides: Partial<HeartbeatConfig> = {}): Promise<MountedFleet> {
  const clock = fakeClock()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  applyHeartbeat(ctx, {
    stallThresholdMs: 10 * 60 * 1000,
    tickMs: 30_000,
    clock,
    ...overrides,
  })
  assert.ok(ctx.fleet !== undefined, 'ctx.fleet must be registered by fleet-heartbeat')
  assert.ok(ctx.sessions !== undefined, 'ctx.sessions must be mounted by the session store')
  return { ctx, clock }
}

export function assertPass(name: string, ok: boolean, detail?: string): void {
  if (!ok) {
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
    process.exitCode = 1
    throw new Error(`assertion failed: ${name}`)
  }
  console.log(`  ✓ ${name}`)
}
