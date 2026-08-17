/**
 * VERIFY (issue #26): fleet-extras smoke test.
 * Unit coverage for the P3.3 hcom borrow — workspace watch + subscribe + 30 s
 * collision detection (the shared-worktree protection pattern):
 *   - watch intent over explicit paths (multiple actors may watch the same
 *     path) → the polling scanner (scan()) detects real on-disk changes and
 *     attributes them to the watch holder (fleet/workspace-change);
 *   - noteWrite (the deterministic attribution seam) drives the collision
 *     detector: two DIFFERENT actors writing the SAME file within the window
 *     → fleet/collision fired with { actors, file, windowMs };
 *   - the same actor writing twice does NOT collide; the window elapsed → no
 *     collision; identical (path, pair) is deduped for the window (no storm);
 *   - subscribe: in-process subscriptions get the changed path injected
 *     (pathPattern filter respected);
 *   - events carry originKind 'extras' (signed when identity present);
 *   - the three model-facing tools execute.
 * No live LLM — fake clock + real temp dirs (the family harness pattern).
 *
 * Run: pnpm test:extras  (or)  tsx tests/fleet-extras-smoke.ts
 * @module @hydra/dsh-fleet/tests/fleet-extras-smoke
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertPass, fakeClock } from './harness.ts'
import { apply as applyExtras } from '../plugins/fleet-extras/src/index.ts'
import {
  FleetExtrasService,
  EXTRAS_ACTOR,
  EXTRAS_ORIGIN_KIND,
  EXTRAS_EVENT_TYPES,
} from '../plugins/fleet-extras/src/service.ts'
import { FleetBusService } from '../plugins/fleet-bus/src/service.ts'
import type { FleetBusEvent } from '../plugins/fleet-bus/src/types.ts'
import { FleetAgentService, type FleetSignedEvent } from '../plugins/fleet-agent/src/service.ts'
import type { CollisionPayload } from '../plugins/fleet-extras/src/types.ts'

/** Mount fleet-bus + fleet-extras on one fresh Context with a fake clock. */
function mountExtras(overrides: Record<string, unknown> = {}): {
  ctx: CordisContext
  clock: ReturnType<typeof fakeClock>
  bus: FleetBusService
  extras: FleetExtrasService
  delivered: Array<{ agentId: string; message: unknown }>
} {
  const clock = fakeClock()
  const ctx = new CordisContext()
  const delivered: Array<{ agentId: string; message: unknown }> = []
  const bus = new FleetBusService(ctx, {
    storeDir: mkdtempSync(join(tmpdir(), 'fleet-extras-bus-')),
    clock,
    resolveAgent: () => undefined,
  })
  const extras = new FleetExtrasService(ctx, {
    clock,
    resolveAgent: (agentId) => ({
      inject: (message) => { delivered.push({ agentId, message }) },
      followup: () => {},
    }),
    ...overrides,
  })
  assertPass('ctx.fleetExtras is registered', ctx.fleetExtras !== undefined)
  return { ctx, clock, bus, extras, delivered }
}

/** Bus events of one type, newest-last. */
function eventsOf(bus: FleetBusService, type: string): FleetBusEvent[] {
  return bus.replay({ type })
}

/** The collision payload of one event (or undefined). */
function collisionOf(event: FleetBusEvent | undefined): CollisionPayload | undefined {
  if (event === undefined) return undefined
  const payload = event.payload as { signed?: FleetSignedEvent } & Partial<CollisionPayload>
  return { file: payload.file!, actors: payload.actors!, windowMs: payload.windowMs!, firstTs: payload.firstTs!, secondTs: payload.secondTs!, id: payload.id! }
}

async function main(): Promise<void> {
  console.log('fleet-extras-smoke: workspace watch + subscribe + 30s collision detection (shared-worktree pattern)')

  // ---- 1. noteWrite: two DIFFERENT actors on the same file within the window → fleet/collision ----
  {
    const { ctx, clock, bus, extras } = mountExtras()
    const file = '/worktree/docs/design.md'
    extras.watch([file], 'agent-a')
    extras.watch([file], 'agent-b')

    extras.noteWrite(file, 'agent-a', 'change')
    clock.advance(5_000)
    extras.noteWrite(file, 'agent-b', 'change')

    const collisions = eventsOf(bus, EXTRAS_EVENT_TYPES.collision)
    assertPass('fleet/collision fired with actors, file, window',
      collisions.length === 1, JSON.stringify(collisions))
    const payload = collisionOf(collisions[0])!
    assertPass('collision names both actors in write order',
      payload.actors[0] === 'agent-a' && payload.actors[1] === 'agent-b', JSON.stringify(payload))
    assertPass('collision names the shared file', payload.file === file, payload.file)
    assertPass('collision carries the window (30 s default)',
      payload.windowMs === 30_000 && payload.firstTs === 1_000_000 && payload.secondTs === 1_005_000,
      JSON.stringify(payload))
    assertPass('recentCollisions surfaces it', extras.recentCollisions().length === 1)
  }

  // ---- 2. same actor twice → no collision; window elapsed → no collision ----
  {
    const { ctx, clock, extras } = mountExtras()
    const file = '/worktree/docs/same-actor.md'
    extras.noteWrite(file, 'agent-a')
    clock.advance(5_000)
    extras.noteWrite(file, 'agent-a') // same actor, no collision
    clock.advance(10_000)
    extras.noteWrite(file, 'agent-b') // still within 30 s of agent-a's last write → collision fires
    assertPass('same actor writes do not collide; different actor within window does',
      eventsOf(ctx.fleetBus, EXTRAS_EVENT_TYPES.collision).length === 1)

    const { clock: clock2, extras: extras2, bus: bus2 } = mountExtras()
    const file2 = '/worktree/docs/elapsed.md'
    extras2.noteWrite(file2, 'agent-a')
    clock2.advance(31_000)
    extras2.noteWrite(file2, 'agent-b') // window elapsed → no collision
    assertPass('window elapsed → no collision',
      eventsOf(bus2, EXTRAS_EVENT_TYPES.collision).length === 0)
  }

  // ---- 3. identical (path, pair) deduped within the window (no storm) ----
  {
    const { ctx, clock, extras } = mountExtras()
    const file = '/worktree/docs/dedupe.md'
    extras.noteWrite(file, 'agent-a')
    clock.advance(1_000)
    extras.noteWrite(file, 'agent-b') // collision #1
    clock.advance(1_000)
    extras.noteWrite(file, 'agent-b') // agent-b again within window → deduped (no storm)
    clock.advance(1_000)
    extras.noteWrite(file, 'agent-a') // agent-a again within window → deduped
    assertPass('identical collision pair deduped for the window',
      eventsOf(ctx.fleetBus, EXTRAS_EVENT_TYPES.collision).length === 1)

    // After the window, a new collision on the same pair fires again.
    clock.advance(31_000)
    extras.noteWrite(file, 'agent-a')
    clock.advance(1_000)
    extras.noteWrite(file, 'agent-b')
    assertPass('the same pair collides again after the window expires',
      eventsOf(ctx.fleetBus, EXTRAS_EVENT_TYPES.collision).length === 2)
  }

  // ---- 4. LIVE scan(): real on-disk change under a watched dir → workspace-change, attributed to the watch holder ----
  {
    const { ctx, clock, bus, extras } = mountExtras()
    const dir = mkdtempSync(join(tmpdir(), 'fleet-extras-watch-'))
    const file = join(dir, 'live.ts')
    writeFileSync(file, 'v1\n')

    const watch = extras.watch([dir], 'agent-a')
    extras.scan() // first scan → 'create' detected
    assertPass('live scan() detects the existing file as create, attributed to the watch holder',
      eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).some(event =>
        (event.payload as { path: string; actor: string; kind: string }).path === file
          && (event.payload as { actor: string }).actor === 'agent-a'
          && (event.payload as { kind: string }).kind === 'create'),
      JSON.stringify(eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).map(e => e.payload)))

    clock.advance(1_000)
    writeFileSync(file, 'v2 changed\n') // real on-disk change
    extras.scan()
    assertPass('live scan() detects the real change, attributed to the watch holder',
      eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).some(event =>
        (event.payload as { path: string; kind: string }).path === file
          && (event.payload as { kind: string }).kind === 'change'),
      JSON.stringify(eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).map(e => e.payload)))

    // No op: identical mtime+size → no duplicate event.
    extras.scan()
    assertPass('unchanged file produces no duplicate event',
      eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).filter(e => (e.payload as { path: string }).path === file).length === 2)

    extras.unwatch(watch.id)
    assertPass('unwatch removes the intent', extras.listWatches().length === 0)
  }

  // ---- 5. LIVE collision: the scanner attributes agent-b's on-disk write; agent-a (the
  //      other watcher) reports its own concurrent edit via the explicit seam → collision ----
  {
    const { ctx, clock, bus, extras } = mountExtras()
    const dir = mkdtempSync(join(tmpdir(), 'fleet-extras-collide-'))
    const file = join(dir, 'shared.ts')
    writeFileSync(file, 'a\n')
    extras.watch([dir], 'agent-a')
    clock.advance(1_000)
    extras.watch([dir], 'agent-b') // most recent watcher → the presumed editor of scans
    extras.scan() // both watch the dir; the create is attributed to the most recent watcher (agent-b)
    clock.advance(1_000)
    writeFileSync(file, 'a2 written by agent-b on disk\n')
    extras.scan() // the live change is attributed to agent-b (the presumed editor)

    // Agent-a — the other watcher on the SAME file — reports its own concurrent
    // edit within the window via the deterministic seam (what a live agent tool
    // call does). Both mechanisms meet on one write ledger → collision.
    clock.advance(1_000)
    extras.noteWrite(file, 'agent-a')

    const collisions = eventsOf(bus, EXTRAS_EVENT_TYPES.collision)
    assertPass('agent-b live write + agent-a concurrent write → fleet/collision fires',
      collisions.length === 1, JSON.stringify(collisions.map(c => collisionOf(c))))
    const liveCollision = collisionOf(collisions[0])!
    assertPass('the live collision names both watchers + the shared file',
      liveCollision.file === file
        && liveCollision.actors.includes('agent-a')
        && liveCollision.actors.includes('agent-b'),
      JSON.stringify(liveCollision))
  }

  // ---- 6. subscribe: in-process delivery with pathPattern filter ----
  {
    const { clock, extras, delivered } = mountExtras()
    extras.subscribe('agent-c', { pathPattern: '/worktree/' })
    extras.subscribe('agent-d', { pathPattern: '/other/' })
    extras.noteWrite('/worktree/docs/readme.md', 'agent-a')

    assertPass('matching subscriber received the change (inject)',
      delivered.some(entry => entry.agentId === 'agent-c'),
      JSON.stringify(delivered))
    assertPass('non-matching subscriber did NOT receive it',
      !delivered.some(entry => entry.agentId === 'agent-d'),
      JSON.stringify(delivered))
  }

  // ---- 7. events: originKind 'extras' + signed when identity present ----
  {
    const clock = fakeClock()
    const ctx = new CordisContext()
    const identity = new FleetAgentService(ctx, { home: mkdtempSync(join(tmpdir(), 'fleet-extras-identity-')) })
    identity.register({ agentId: EXTRAS_ACTOR })
    const bus = new FleetBusService(ctx, { storeDir: mkdtempSync(join(tmpdir(), 'fleet-extras-bus-')), clock, resolveAgent: () => undefined })
    const extras = new FleetExtrasService(ctx, { clock })

    extras.noteWrite('/worktree/docs/signed.md', 'agent-a')
    clock.advance(1_000)
    extras.noteWrite('/worktree/docs/signed.md', 'agent-b')

    const changes = eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange)
    assertPass('workspace-change events carry originKind "extras"',
      changes.length === 2 && changes.every(event => event.originKind === EXTRAS_ORIGIN_KIND),
      JSON.stringify(changes))
    const changePayload = changes[0]!.payload as { signed?: FleetSignedEvent }
    assertPass('workspace-change embeds a signed envelope when identity is available',
      changePayload.signed !== undefined && identity.verify(changePayload.signed!).ok === true)

    const collisions = eventsOf(bus, EXTRAS_EVENT_TYPES.collision)
    assertPass('fleet/collision carries actor + originKind "extras"',
      collisions.length === 1
        && collisions[0]!.originKind === EXTRAS_ORIGIN_KIND
        && collisions[0]!.actor === EXTRAS_ACTOR,
      JSON.stringify(collisions))
    const collisionPayload = collisions[0]!.payload as { signed?: FleetSignedEvent }
    assertPass('fleet/collision is signed too',
      collisionPayload.signed !== undefined && identity.verify(collisionPayload.signed!).ok === true)
  }

  // ---- 8. cordis event emission per detection ----
  {
    const { ctx, extras } = mountExtras()
    const seen: Array<{ kind: string; record: JsonValue }> = []
    ctx.on('fleet-extras/event', (info) => { seen.push(info) })
    extras.noteWrite('/worktree/docs/emitted.md', 'agent-a')
    assertPass('fleet-extras/event emitted per workspace change',
      seen.some(entry => entry.kind === 'workspace-change'), JSON.stringify(seen))
  }

  // ---- 9. tools: three extras tools registered + execute ----
  {
    const ctx = new CordisContext()
    const clock = fakeClock()
    const registered = new Map<string, ToolDefinition>()
    ctx.reflect.provide('tools', {
      register(def: ToolDefinition): () => void {
        registered.set(def.name, def)
        return () => { registered.delete(def.name) }
      },
    } as never)

    applyExtras(ctx, { clock, collisionWindowMs: 30_000 } as never)
    assertPass('apply registers the three extras tools',
      ['extras_watch', 'extras_subscribe', 'extras_collisions'].every(name => registered.has(name)),
      JSON.stringify([...registered.keys()]))

    const exec = { agent: { id: 'agent-a', session: { id: 'agent-a' } } }
    const watchTool = registered.get('extras_watch')!
    const watchResult = await watchTool.execute!({ paths: ['/worktree/docs/tool.md'] }, exec as never) as { id: string; actor: string; paths: string[] }
    assertPass('extras_watch executes (registers intent)', watchResult.actor === 'agent-a' && watchResult.paths.length === 1)

    const subscribeTool = registered.get('extras_subscribe')!
    const subscribeResult = await subscribeTool.execute!({ pathPattern: '/worktree' }, exec as never) as { id: string; agentId: string; pathPattern?: string }
    assertPass('extras_subscribe executes (registers a filtered subscription)',
      subscribeResult.agentId === 'agent-a' && subscribeResult.pathPattern === '/worktree')

    const collisionsTool = registered.get('extras_collisions')!
    const collisionsResult = await collisionsTool.execute!({}, exec as never) as { windowMs: number; collisions: unknown[]; watches: Array<{ actor: string }> }
    assertPass('extras_collisions reports window + the watch/subscription state',
      collisionsResult.windowMs === 30_000
        && collisionsResult.watches.some(watch => watch.actor === 'agent-a')
        && collisionsResult.collisions.length === 0,
      JSON.stringify(collisionsResult))

    const noAgent = await watchTool.execute!({ paths: ['/x'] }, {} as never)
      .then(() => false, () => true)
    assertPass('extras tools require an owning agent session', noAgent === true)
  }

  // ---- 10. watch over a directory covers nested files (scan + attribution) ----
  {
    const { ctx, clock, bus, extras } = mountExtras()
    const dir = mkdtempSync(join(tmpdir(), 'fleet-extras-nested-'))
    const nestedDir = join(dir, 'deep', 'nested')
    mkdirSync(nestedDir, { recursive: true })
    const nestedFile = join(nestedDir, 'file.ts')
    writeFileSync(nestedFile, 'v1\n')

    extras.watch([dir], 'agent-a')
    extras.scan()
    assertPass('a watch on a dir covers a nested file (create detected, attributed)',
      eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).some(event =>
        (event.payload as { path: string; actor: string }).path === nestedFile
          && (event.payload as { actor: string }).actor === 'agent-a'),
      JSON.stringify(eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).map(e => e.payload)))

    clock.advance(1_000)
    writeFileSync(nestedFile, 'v2 changed\n')
    extras.scan()
    assertPass('the nested change is attributed to the dir watch holder',
      eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).some(event =>
        (event.payload as { path: string; kind: string }).path === nestedFile
          && (event.payload as { kind: string }).kind === 'change'),
      JSON.stringify(eventsOf(bus, EXTRAS_EVENT_TYPES.workspaceChange).map(e => e.payload)))
  }

  console.log('fleet-extras-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`fleet-extras-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
