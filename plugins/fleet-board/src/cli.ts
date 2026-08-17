#!/usr/bin/env node
/**
 * `fleet` — the fleet-board CLI (issue #26, orchestration-v3 §4 P1.1).
 *
 * Reads the fleet-bus event store directly (no dsh session dependency) and
 * renders the transparency feed:
 *
 *   fleet log [--limit N] [--since TS] [--type T] [--scope S]
 *             [--actor A] [--origin-kind K] [--json] [--follow] [--no-color]
 *   fleet status [--json] [--stall-threshold-ms N] [--no-color]
 *
 * Store overrides: FLEET_BOARD_STORE_DIR / FLEET_BOARD_STORE_FILE (defaults
 * to `$DSH_HOME/fleet/fleet-bus.jsonl`). `--follow` tails new events at a 1s
 * poll and runs until interrupted.
 * @module @hydra/dsh-fleet-board/cli
 */

import {
  FleetBoardFeed,
  renderEventText,
  renderStatusText,
  filterFleetBoardEvents,
} from './feed.ts'
import type { FleetBoardFilter, FleetBoardRenderOptions } from './feed.ts'
import type { FleetBusScope } from '../../fleet-bus/src/types.ts'
import { pathToFileURL } from 'node:url'

const DEFAULT_LIMIT = 20
const FOLLOW_POLL_MS = 1000

interface CliContext {
  out: (line: string) => void
  color: boolean
}

/** `fleet log`: render the most recent matching events as text or JSON. */
export function runLog(feed: FleetBoardFeed, args: string[], ctx: CliContext): void {
  const filter = parseFilterArgs(args)
  const follow = hasFlag(args, '--follow')
  const json = hasFlag(args, '--json')
  const noColor = hasFlag(args, '--no-color')
  const color = noColor ? false : ctx.color
  const limit = parseLimitArg(args) ?? DEFAULT_LIMIT

  const renderOptions: FleetBoardRenderOptions = { color }
  if (json) {
    for (const event of feed.read({ ...filter, limit })) ctx.out(JSON.stringify(event))
  } else {
    for (const event of feed.read({ ...filter, limit })) ctx.out(renderEventText(event, renderOptions))
  }

  if (follow) followLoop(feed, filter, { json, renderOptions, out: ctx.out })
}

/** `fleet status`: derive the per-actor summary from stored events. */
export function runStatus(feed: FleetBoardFeed, args: string[], ctx: CliContext): void {
  const json = hasFlag(args, '--json')
  const noColor = hasFlag(args, '--no-color')
  const color = noColor ? false : ctx.color
  const stallThresholdMs = parsePositiveIntArg(args, '--stall-threshold-ms') ?? 10 * 60 * 1000
  const status = feed.status(stallThresholdMs)
  if (json) {
    ctx.out(JSON.stringify(status))
  } else {
    ctx.out(renderStatusText(status, { color }))
  }
}

/** Parse `fleet` argv (after the subcommand) into a feed filter. */
export function parseFilterArgs(args: string[]): FleetBoardFilter {
  const filter: FleetBoardFilter = {}
  const since = parsePositiveIntArg(args, '--since')
  if (since !== undefined) filter.since = since
  const type = parseStringArg(args, '--type')
  if (type !== undefined) filter.type = type
  const actor = parseStringArg(args, '--actor')
  if (actor !== undefined) filter.actor = actor
  const originKind = parseStringArg(args, '--origin-kind')
  if (originKind !== undefined) filter.originKind = originKind
  const scope = parseStringArg(args, '--scope')
  if (scope === 'agent' || scope === 'team' || scope === 'fleet') filter.scope = scope as FleetBusScope
  return filter
}

function followLoop(
  feed: FleetBoardFeed,
  filter: FleetBoardFilter,
  options: { json: boolean; renderOptions: FleetBoardRenderOptions; out: (line: string) => void },
): void {
  let watermark = feed.lastSeq()
  const tick = (): void => {
    feed.refresh()
    const events = filterFleetBoardEvents(feed.tail(watermark), filter)
    for (const event of events) {
      options.out(options.json ? JSON.stringify(event) : renderEventText(event, options.renderOptions))
    }
    watermark = feed.lastSeq()
  }
  tick()
  const timer = setInterval(tick, FOLLOW_POLL_MS)
  timer.unref()
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function parseLimitArg(args: string[]): number | undefined {
  const inline = args.find(arg => arg.startsWith('--limit='))
  if (inline !== undefined) {
    const parsed = Number.parseInt(inline.slice('--limit='.length), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
  return parsePositiveIntArg(args, '--limit')
}

function parsePositiveIntArg(args: string[], flag: string): number | undefined {
  const at = args.indexOf(flag)
  if (at === -1 || at === args.length - 1) return undefined
  const parsed = Number.parseInt(args[at + 1] as string, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseStringArg(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  if (at === -1 || at === args.length - 1) return undefined
  const value = args[at + 1]
  return value !== undefined && value.length > 0 ? value : undefined
}

function printHelp(out: (line: string) => void): void {
  out(`fleet — fleet-board CLI (reads $DSH_HOME/fleet/fleet-bus.jsonl)

usage:
  fleet log [--limit N] [--since TS] [--type T] [--scope S] [--actor A]
            [--origin-kind K] [--json] [--follow] [--no-color]
  fleet status [--json] [--stall-threshold-ms N] [--no-color]
  fleet --help

flags:
  --limit N           most recent N matching events (default ${DEFAULT_LIMIT})
  --since TS          only events with ts >= TS (unix epoch ms)
  --type T            only events of exactly this type
  --scope S           only events of scope agent|team|fleet
  --actor A           only events produced by exactly this actor
  --origin-kind K     only events from exactly this mechanism
  --json              raw NDJSON events (log) / JSON status object
  --follow            tail new events every 1s until interrupted
  --no-color          plain text (no ANSI)
  --stall-threshold-ms N  recency threshold for status (default 600000)

env:
  FLEET_BOARD_STORE_DIR / FLEET_BOARD_STORE_FILE  override the bus store path
  FLEET_BOARD_HOST / FLEET_BOARD_PORT             override the board server bind`)
}

/** Dispatch a full `fleet` argv; returns the process exit code. */
export function runCli(argv: string[], ctx: CliContext): number {
  const subcommand = argv[0]
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    printHelp(ctx.out)
    return 0
  }
  const feed = new FleetBoardFeed(storeEnvConfig())
  try {
    if (subcommand === 'log') runLog(feed, argv.slice(1), ctx)
    else if (subcommand === 'status') runStatus(feed, argv.slice(1), ctx)
    else {
      ctx.out(`fleet: unknown subcommand "${subcommand}" (try "fleet --help")`)
      return 1
    }
    return 0
  } catch (error) {
    ctx.out(`fleet: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function storeEnvConfig(): { storeDir?: string; storeFile?: string } {
  return {
    ...(process.env.FLEET_BOARD_STORE_DIR !== undefined && process.env.FLEET_BOARD_STORE_DIR.length > 0
      ? { storeDir: process.env.FLEET_BOARD_STORE_DIR }
      : {}),
    ...(process.env.FLEET_BOARD_STORE_FILE !== undefined && process.env.FLEET_BOARD_STORE_FILE.length > 0
      ? { storeFile: process.env.FLEET_BOARD_STORE_FILE }
      : {}),
  }
}

function main(): void {
  const out = (line: string): void => { process.stdout.write(`${line}\n`) }
  const color = process.stdout.isTTY === true
  const exitCode = runCli(process.argv.slice(2), { out, color })
  process.exitCode = exitCode
}

// Run as a bin only; importing runLog/runStatus from tests must not execute
// main (the bin's argv is meaningless in-process).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
