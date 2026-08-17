/**
 * VERIFY (issue #26, request-logging-26.md): the shared request access-log
 * helper (src/request-log.ts) + the fleet server wiring.
 *
 * Asserts on a wrapped handler over a real node:http socket:
 * - one request → EXACTLY one JSONL line with the 8 design fields;
 * - multiple requests append (3 requests → 3 lines);
 * - status + durMs captured (a 404 line);
 * - err/abort → a `status: 0` line (client disconnect mid-request);
 * - the logs dir is created on demand (`<storeDir>/logs/`);
 * - separate svc values write to separate files;
 * - end-to-end wiring: a real FleetBoardServer writes `fleet-board.requests.jsonl`.
 *
 * Run: npm run test:reqlog  (or)  tsx tests/request-log-smoke.ts
 * @module @hydra/dsh-fleet/tests/request-log-smoke
 */

import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPass } from './harness.ts'
import { withRequestLog, requestLogPath, type RequestLogLine } from '../src/request-log.ts'
import { FleetBoardServer } from '../plugins/fleet-board/src/server.ts'

/** Parse the appended JSONL file into typed lines (empty when absent). */
function readLines(file: string): RequestLogLine[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as RequestLogLine)
}

/** Poll until the file holds at least `count` lines (server appends async-ish). */
async function waitForLines(file: string, count: number, timeoutMs = 2000): Promise<RequestLogLine[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lines = readLines(file)
    if (lines.length >= count) return lines
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  return readLines(file)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

async function main(): Promise<void> {
  console.log('request-log-smoke: shared access-log helper + fleet server wiring')

  const storeDir = mkdtempSync(join(tmpdir(), 'fleet-request-log-'))
  const boardFile = requestLogPath(storeDir, 'fleet-board')

  // ---- 1. one request → exactly one JSONL line with the 8 design fields ----
  {
    const handler = withRequestLog('fleet-board', storeDir, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ count: 1 }))
    })
    const server = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })
    try {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://127.0.0.1:${port}/events?limit=1`)
      await response.text()
      await sleep(50)

      const lines = readLines(boardFile)
      assertPass('a wrapped request produces exactly one JSONL line', lines.length === 1, JSON.stringify(lines))
      const entry = lines[0]
      assertPass('line carries the 8 design fields (ts/svc/method/path/status/durMs/remote/host)',
        entry !== undefined
          && Object.keys(entry).sort().join(',') === 'durMs,host,method,path,remote,status,svc,ts',
        JSON.stringify(entry))
      assertPass('ts is an ISO8601 parseable timestamp', entry !== undefined && !Number.isNaN(Date.parse(entry.ts)))
      assertPass('svc is the wrapped service', entry?.svc === 'fleet-board')
      assertPass('method captured', entry?.method === 'GET')
      assertPass('path captured as the pathname (query stripped)', entry?.path === '/events')
      assertPass('status captured from the response', entry?.status === 200)
      assertPass('durMs is a non-negative integer ms', entry !== undefined && Number.isInteger(entry.durMs) && entry.durMs >= 0)
      assertPass('remote is the client address', typeof entry?.remote === 'string' && entry.remote.includes('127.0.0.1'))
      assertPass('host header captured', typeof entry?.host === 'string' && entry.host.includes('127.0.0.1'))
      assertPass('logs dir + file created on demand (mkdir -p + append)',
        existsSync(join(storeDir, 'logs', 'fleet-board.requests.jsonl')) === true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }

  // ---- 2. multiple requests append ----
  {
    const handler = withRequestLog('fleet-board', storeDir, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{}')
    })
    const server = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })
    try {
      const port = (server.address() as { port: number }).port
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`http://127.0.0.1:${port}/health?n=${i}`)
        await response.text()
      }
      const lines = await waitForLines(boardFile, 4)
      assertPass('multiple requests append (1 + 3 = 4 lines)', lines.length === 4, JSON.stringify(lines.map(l => l.path)))
      assertPass('each appended line is the same svc', lines.every(line => line.svc === 'fleet-board'))
      assertPass('per-request path + query-free path captured', lines.slice(1).every(line => line.path === '/health'))
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }

  // ---- 3. status + durMs captured (a 404 line) ----
  {
    const handler = withRequestLog('fleet-board', storeDir, (req, res) => {
      res.writeHead(req.url?.startsWith('/missing') ? 404 : 200, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    const server = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })
    try {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://127.0.0.1:${port}/missing`)
      await response.text()
      const lines = await waitForLines(boardFile, 5)
      const missing = lines[lines.length - 1]
      assertPass('404 status captured', missing?.status === 404, JSON.stringify(missing))
      assertPass('durMs captured on the 404 line', missing !== undefined && Number.isInteger(missing.durMs) && missing.durMs >= 0)
      assertPass('aborted/404 lines still carry the path', missing?.path === '/missing')
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }

  // ---- 4. err/abort → a status:0 line (client disconnects mid-request) ----
  {
    const handler = withRequestLog('fleet-agent', storeDir, (_req, _res) => {
      // hold the response open — the client aborts before anything is written
    })
    const server = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })
    try {
      const port = (server.address() as { port: number }).port
      const agentFile = requestLogPath(storeDir, 'fleet-agent')
      await new Promise<void>((resolve) => {
        const client = httpRequest({ host: '127.0.0.1', port, path: '/slow', method: 'GET' })
        client.on('error', () => { /* the destroy below tears the socket down */ })
        client.end()
        setTimeout(() => { client.destroy(); resolve() }, 30)
      })
      const lines = await waitForLines(agentFile, 1)
      const aborted = lines[lines.length - 1]
      assertPass('an aborted request produces a line', lines.length === 1, JSON.stringify(lines))
      assertPass('aborted line logs status 0 (no response was ended)', aborted?.status === 0, JSON.stringify(aborted))
      assertPass('aborted line still captures method/path/remote', aborted?.method === 'GET' && aborted?.path === '/slow'
        && aborted?.remote.includes('127.0.0.1') === true, JSON.stringify(aborted))
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }

  // ---- 5. separate svc values write to separate files ----
  {
    const svcDir = mkdtempSync(join(tmpdir(), 'fleet-request-log-'))
    const teamsHandler = withRequestLog('fleet-teams-ui', svcDir, (_req, res) => {
      res.writeHead(200)
      res.end('teams')
    })
    const server = createServer(teamsHandler)
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })
    try {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://127.0.0.1:${port}/api/rooms`)
      await response.text()
      await sleep(50)
      const teamsLines = readLines(requestLogPath(svcDir, 'fleet-teams-ui'))
      assertPass('fleet-teams-ui requests land in their own file', teamsLines.length === 1 && teamsLines[0]?.svc === 'fleet-teams-ui')
      assertPass('no cross-svc bleed (board file stays empty)', readLines(requestLogPath(svcDir, 'fleet-board')).length === 0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }

  // ---- 6. end-to-end wiring: a real fleet server writes its access log ----
  {
    const boardDir = mkdtempSync(join(tmpdir(), 'fleet-request-log-'))
    const server = new FleetBoardServer({ port: 0, storeDir: boardDir })
    await server.listen()
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`)
      await response.text()
      const lines = await waitForLines(requestLogPath(boardDir, 'fleet-board'), 1)
      assertPass('FleetBoardServer wiring logs to <storeDir>/logs/fleet-board.requests.jsonl',
        lines.length === 1 && lines[0]?.svc === 'fleet-board' && lines[0]?.path === '/health' && lines[0]?.status === 200,
        JSON.stringify(lines))
    } finally {
      await server.close()
    }
  }

  console.log('request-log-smoke: ALL PASS')
}

void main().catch((error: unknown) => {
  console.error(`request-log-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
