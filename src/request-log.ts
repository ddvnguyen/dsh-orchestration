/**
 * Shared HTTP request access-log helper for the fleet plugin family (issue
 * #26, orchestration/state/request-logging-26.md): appends ONE structured
 * JSONL line per request to `$DSH_HOME/fleet/logs/<svc>.requests.jsonl`.
 *
 * Format (fixed, append-only JSONL):
 * ```
 * {"ts":"<ISO8601>","svc":"fleet-board","method":"GET","path":"/health","status":200,"durMs":12,"remote":"10.88.0.1","host":"harness.ddvnguyen.com"}
 * ```
 * `svc` values: `dsh-web`, `fleet-board`, `fleet-teams-ui`, `fleet-settings`,
 * `fleet-agent`, `fleet-exporter`. The fleet-exporter parses every
 * `*.requests.jsonl` in the logs dir, so the schema is a contract.
 *
 * Dependency-free by design (node:fs + node:path + the node:http types), and
 * deliberately a wrapper around a handler — the fleet servers share ONE
 * handler set between the dsh webServer mount and their standalone bins, so
 * wrapping the shared handlers once covers both surfaces
 * (src/family-mount.ts pattern).
 *
 * Failure semantics: logging must NEVER break a request. A write error
 * (unwritable logs dir, etc.) is surfaced on stderr and the request proceeds
 * untouched — the same "log errors visible, never silent" posture the family
 * servers use in their `onError` handlers.
 * @module @hydra/dsh-fleet/request-log
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FamilyMountHandler } from './family-mount.ts'

/** The access-log line schema (the exporter's parsing contract). */
export interface RequestLogLine {
  /** ISO8601 timestamp of the response (`new Date().toISOString()`). */
  ts: string
  /** The fleet service name (dsh-web / fleet-board / fleet-teams-ui / fleet-settings / fleet-agent / fleet-exporter). */
  svc: string
  /** The request method (GET / POST / …). */
  method: string
  /** The request pathname (query string excluded). */
  path: string
  /** The response status code; `0` when the request aborted before a response. */
  status: number
  /** Server-side handling duration in ms (rounded to a whole number). */
  durMs: number
  /** The client address (`req.socket.remoteAddress`). */
  remote: string
  /** The `Host` header the client sent. */
  host: string
}

/** Where the helper writes: `<svc>.requests.jsonl` inside this target. */
export interface RequestLogTarget {
  /** The fleet service name recorded in every line's `svc` field. */
  svc: string
  /**
   * The fleet store base dir (`$DSH_HOME/fleet` for the family). Lines are
   * appended to `<storeDir>/logs/<svc>.requests.jsonl`.
   */
  storeDir: string
}

/**
 * Wrap a handler so every request it serves appends one access-log line.
 * The line is written once per request on the earliest terminal event —
 * `finish` (normal response) or `close` / `aborted` / `error` (client
 * disconnect, logged with `status: 0`).
 *
 * @param svc - the fleet service name (`svc` field).
 * @param storeDir - the fleet store base dir; the logs dir is created on demand.
 * @param handler - the request handler to wrap.
 * @returns a handler of the same shape that logs each request before delegating.
 */
export function withRequestLog<T extends FamilyMountHandler>(svc: string, storeDir: string, handler: T): T {
  return ((req, res) => {
    scheduleRequestLog(svc, storeDir, req, res)
    return handler(req, res)
  }) as T
}

/** The access-log directory for a fleet store base dir: `<storeDir>/logs`. */
export function requestLogsDir(storeDir: string): string {
  return join(storeDir, 'logs')
}

/**
 * Resolve where `<svc>.requests.jsonl` lives for a fleet store base dir —
 * the single path the helper, the tests, and the exporter must agree on.
 */
export function requestLogPath(storeDir: string, svc: string): string {
  return join(requestLogsDir(storeDir), `${svc}.requests.jsonl`)
}

/** Hook the terminal response/request events so exactly ONE line is appended. */
function scheduleRequestLog(svc: string, storeDir: string, req: IncomingMessage, res: ServerResponse): void {
  const startedNs = process.hrtime.bigint()
  // The peer address is captured NOW, while the socket is still alive — it is
  // cleared once the connection is torn down, so the terminal event (close /
  // aborted) would otherwise see it empty on a client disconnect.
  const remote = req.socket?.remoteAddress ?? ''
  let logged = false
  const write = (): void => {
    if (logged) return
    logged = true
    appendRequestLine(svc, storeDir, req, res, startedNs, remote)
  }
  // `finish` then `close` both fire on a normal response; `close` alone (and
  // `aborted` / `error` on the request) fire on a client disconnect mid-request.
  // The `logged` guard collapses them into the single intended line.
  res.on('finish', write)
  res.on('close', write)
  req.on('aborted', write)
  req.on('error', write)
}

/** Build + append one JSONL line. Errors surface on stderr, never on the wire. */
function appendRequestLine(
  svc: string,
  storeDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  startedNs: bigint,
  remote: string,
): void {
  const line: RequestLogLine = {
    ts: new Date().toISOString(),
    svc,
    method: req.method ?? '',
    path: new URL(req.url ?? '/', 'http://x').pathname,
    // An aborted request never ended the response — its `writableEnded` stays
    // false and the statusCode would lie (Node defaults it to 200). Log 0.
    status: res.writableEnded ? res.statusCode : 0,
    durMs: Math.round(Number(process.hrtime.bigint() - startedNs) / 1e6),
    remote,
    host: hostHeader(req),
  }
  try {
    const dir = requestLogsDir(storeDir)
    mkdirSync(dir, { recursive: true })
    appendFileSync(requestLogPath(storeDir, svc), `${JSON.stringify(line)}\n`, 'utf8')
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`fleet request-log: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The `Host` header, array-safe (never a rejection vector for the appender). */
function hostHeader(req: IncomingMessage): string {
  const host = req.headers.host
  if (host === undefined) return ''
  return Array.isArray(host) ? (host[0] ?? '') : host
}
