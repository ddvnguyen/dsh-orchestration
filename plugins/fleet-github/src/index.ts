/**
 * @hydra/dsh-fleet-github — GitHub App authentication + MCP server integration.
 *
 * Manages the full GitHub App token lifecycle:
 * 1. Fetches private key from Doppler (or env/file fallback)
 * 2. Generates JWT and exchanges for installation token
 * 3. Spawns mcp-server-github with the token
 * 4. Proxies stdio between parent and child
 * 5. Handles pre-emptive token refresh, crash recovery, health checks
 *
 * Exposes GitHub tools (repos, PRs, issues, code search) to fleet agents
 * via the MCP server. Tools are registered as `mcp__github__<toolname>`.
 *
 * ```
 * - id: fleet-github
 *   name: '@hydra/dsh-fleet-github'
 *   config:
 *     appId: '3906823'
 *     installationId: '136596398'
 *     dopplerProject: 'hydra-vortex'
 *     dopplerConfig: 'dev'
 * ```
 *
 * @module @hydra/dsh-fleet-github
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ── Types ──

interface GitHubConfig {
  /** GitHub App ID */
  appId: string
  /** GitHub App Installation ID */
  installationId: string
  /** Doppler project name */
  dopplerProject: string
  /** Doppler config name */
  dopplerConfig: string
  /** Doppler secret key name (default: GITHUB_APP_PRIVATE_KEY) */
  dopplerSecretKey?: string
  /** Node binary path (default: auto-detect) */
  nodeBin?: string
  /** Token lifetime in seconds (default: 3300 = 55min) */
  tokenLifetimeS?: number
  /** Max consecutive crashes before giving up (default: 5) */
  maxCrashes?: number
  /** Crash cooldown in ms (default: 10000) */
  crashCooldownMs?: number
  /** Health check interval in ms (default: 300000 = 5min) */
  healthCheckMs?: number
}

// ── Defaults ──

const DEFAULTS: Partial<GitHubConfig> = {
  dopplerSecretKey: 'GITHUB_APP_PRIVATE_KEY',
  tokenLifetimeS: 3300,
  maxCrashes: 5,
  crashCooldownMs: 10_000,
  healthCheckMs: 300_000,
}

// ── Service ──

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetGithub: FleetGithubService
  }
}

export class FleetGithubService extends Service {
  private child: ChildProcess | null = null
  private currentToken: string | null = null
  private tokenExpiresAt = 0
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private consecutiveCrashes = 0
  private startupPhase = false
  private config: GitHubConfig

  constructor(ctx: Context) {
    super(ctx, 'fleetGithub')
    this.config = this.resolveConfig()
  }

  private resolveConfig(): GitHubConfig {
    const raw = (this as any).config ?? {}
    return {
      appId: raw.appId ?? process.env.GITHUB_APP_ID ?? '3906823',
      installationId: raw.installationId ?? process.env.GITHUB_INSTALLATION_ID ?? '136596398',
      dopplerProject: raw.dopplerProject ?? process.env.DOPPLER_PROJECT ?? 'hydra-vortex',
      dopplerConfig: raw.dopplerConfig ?? process.env.DOPPLER_CONFIG ?? 'dev',
      dopplerSecretKey: raw.dopplerSecretKey ?? DEFAULTS.dopplerSecretKey,
      nodeBin: raw.nodeBin ?? this.findNodeBin(),
      tokenLifetimeS: raw.tokenLifetimeS ?? DEFAULTS.tokenLifetimeS,
      maxCrashes: raw.maxCrashes ?? DEFAULTS.maxCrashes,
      crashCooldownMs: raw.crashCooldownMs ?? DEFAULTS.crashCooldownMs,
      healthCheckMs: raw.healthCheckMs ?? DEFAULTS.healthCheckMs,
    }
  }

  private findNodeBin(): string {
    // Try common paths
    const candidates = [
      '/home/ddv/.nvm/versions/node/v24.15.0/bin',
      '/usr/local/bin',
      '/usr/bin',
      join(process.env.HOME ?? '', '.nvm/versions/node/v24.15.0/bin'),
    ]
    for (const p of candidates) {
      if (existsSync(join(p, 'node'))) return p
    }
    return '/usr/bin'
  }

  private log(level: string, msg: string) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19)
    process.stderr.write(`[${ts}] [fleet-github] ${level} ${msg}\n`)
  }

  // ── Process Helpers ──

  private execCmd(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      let done = false
      const proc = spawn(cmd, args, {
        env: { ...process.env, PATH: `${this.config.nodeBin}:${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      proc.stdout.on('data', d => stdout += d)
      proc.stderr.on('data', d => stderr += d)

      const timer = setTimeout(() => {
        if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error(`Timeout after ${timeoutMs}ms`)) }
      }, timeoutMs)

      proc.on('close', code => {
        clearTimeout(timer)
        if (done) return
        done = true
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(stderr.trim() || `exit code ${code}`))
      })
      proc.on('error', err => {
        clearTimeout(timer)
        if (!done) { done = true; reject(err) }
      })
    })
  }

  private async execWithRetry(cmd: string, args: string[], retries: number, baseDelayMs: number, label: string): Promise<string> {
    let lastErr: Error | undefined
    for (let i = 0; i <= retries; i++) {
      try {
        return await this.execCmd(cmd, args)
      } catch (err: any) {
        lastErr = err
        if (i < retries) {
          const delay = baseDelayMs * Math.pow(2, i)
          this.log('WARN', `${label} attempt ${i + 1}/${retries + 1} failed: ${err.message} — retrying in ${delay}ms`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }
    throw new Error(`${label} failed after ${retries + 1} attempts: ${lastErr?.message}`)
  }

  // ── Token Management ──

  private async fetchPrivateKey(): Promise<string> {
    // 1. Environment variable
    if (process.env.GITHUB_APP_PRIVATE_KEY) {
      const key = process.env.GITHUB_APP_PRIVATE_KEY.trim()
      if (key.length > 100 && key.includes('BEGIN')) {
        this.log('INFO', 'Using GITHUB_APP_PRIVATE_KEY from environment')
        return key
      }
    }

    // 2. Key files
    const keyPaths = [
      join(process.env.HOME ?? '', '.config/hydra/github-app-key.pem'),
      '/etc/hydra/github-app-key.pem',
    ]
    for (const p of keyPaths) {
      try {
        if (existsSync(p)) {
          const key = readFileSync(p, 'utf8').trim()
          if (key.length > 100 && key.includes('BEGIN')) {
            this.log('INFO', `Using private key from file: ${p}`)
            return key
          }
        }
      } catch { /* skip */ }
    }

    // 3. Doppler
    this.log('INFO', 'Fetching private key from Doppler...')
    return await this.execWithRetry('doppler', [
      'secrets', 'get', this.config.dopplerSecretKey!,
      '-p', this.config.dopplerProject,
      '-c', this.config.dopplerConfig,
      '--plain',
    ], 3, 3000, 'Doppler')
  }

  private async generateToken(): Promise<string> {
    const privateKey = await this.fetchPrivateKey()
    if (!privateKey || privateKey.length < 100) {
      throw new Error('Private key too short or empty')
    }

    const header = { alg: 'RS256', typ: 'JWT' }
    const now = Math.floor(Date.now() / 1000)
    const payload = { iat: now - 60, exp: now + 600, iss: this.config.appId }

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')

    const sign = crypto.createSign('RSA-SHA256')
    sign.update(`${headerB64}.${payloadB64}`)
    const sigB64 = sign.sign(privateKey, 'base64url')

    const jwt = `${headerB64}.${payloadB64}.${sigB64}`

    // Exchange JWT for installation token
    const resp = await fetch(
      `https://api.github.com/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
      }
    )

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`Token exchange failed: HTTP ${resp.status}: ${body.substring(0, 200)}`)
    }

    const data = await resp.json() as any
    if (!data.token) throw new Error('Response missing token field')

    this.tokenExpiresAt = Date.now() + this.config.tokenLifetimeS! * 1000
    this.log('INFO', `Token obtained, expires_at=${data.expires_at}`)
    return data.token
  }

  private async validateToken(token: string): Promise<boolean> {
    try {
      const resp = await fetch('https://api.github.com/rate_limit', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      })
      return resp.ok
    } catch {
      return false
    }
  }

  // ── Child Process Management ──

  private spawnChild(token: string) {
    this.currentToken = token
    const nodeBin = this.config.nodeBin!
    const mcpServer = join(nodeBin, 'mcp-server-github')

    this.child = spawn(join(nodeBin, 'node'), [mcpServer], {
      env: {
        ...process.env,
        PATH: `${nodeBin}:${process.env.PATH ?? ''}`,
        GITHUB_PERSONAL_ACCESS_TOKEN: token,
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.log('INFO', `Child spawned (pid=${this.child.pid})`)

    this.child.stdout?.pipe(process.stdout)
    this.child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d)
    })

    this.child.on('exit', (code, signal) => {
      if (signal === 'SIGTERM') {
        this.log('INFO', `Child terminated (signal=${signal})`)
        this.child = null
        return
      }

      this.consecutiveCrashes++
      this.log('ERROR', `Child crashed (code=${code}, crash #${this.consecutiveCrashes})`)

      if (this.consecutiveCrashes > this.config.maxCrashes!) {
        this.log('ERROR', 'Too many consecutive crashes, giving up')
        this.child = null
        return
      }

      this.child = null

      if (!this.startupPhase && this.currentToken) {
        setTimeout(() => {
          if (this.currentToken) {
            this.log('INFO', 'Auto-restarting child after crash cooldown')
            this.spawnChild(this.currentToken)
          }
        }, this.config.crashCooldownMs)
      }
    })
  }

  private async childReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, timeoutMs)
    })
  }

  // ── Token Refresh ──

  private async refreshToken() {
    this.log('INFO', 'Refreshing token...')
    try {
      const newToken = await this.generateToken()
      const valid = await this.validateToken(newToken)
      if (!valid) {
        this.log('WARN', 'Refreshed token failed health check')
        return
      }

      const oldChild = this.child
      this.spawnChild(newToken)
      this.consecutiveCrashes = 0

      setTimeout(() => {
        if (oldChild?.pid) {
          this.log('INFO', 'Terminating old child after token rotation')
          oldChild.kill('SIGTERM')
        }
      }, 2000)
    } catch (err: any) {
      this.log('ERROR', `Token refresh failed: ${err.message}`)
    }
  }

  // ── Startup ──

  async start() {
    this.log('INFO', 'Starting GitHub MCP integration...')

    let attempt = 0
    while (true) {
      attempt++
      try {
        const token = await this.generateToken()
        const valid = await this.validateToken(token)
        if (!valid) throw new Error('Startup token failed health check')

        this.startupPhase = true
        this.spawnChild(token)
        this.consecutiveCrashes = 0
        await this.childReady(3000)
        this.startupPhase = false

        this.log('INFO', 'GitHub MCP ready')

        // Periodic token refresh
        this.refreshTimer = setInterval(
          () => this.refreshToken().catch(e => this.log('ERROR', `Scheduled refresh failed: ${e.message}`)),
          this.config.tokenLifetimeS! * 1000
        )

        // Health monitor
        this.healthTimer = setInterval(async () => {
          if (this.currentToken && !(await this.validateToken(this.currentToken))) {
            this.log('WARN', 'Token health check failed, triggering refresh')
            this.refreshToken().catch(e => this.log('ERROR', `Emergency refresh failed: ${e.message}`))
          }
        }, this.config.healthCheckMs!)

        return
      } catch (err: any) {
        this.startupPhase = false
        const delay = Math.min(3000 * Math.pow(2, attempt), 60_000)
        this.log('ERROR', `Startup attempt ${attempt} failed: ${err.message} — retrying in ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  stop() {
    this.log('INFO', 'Stopping GitHub MCP...')
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    if (this.child) {
      this.child.kill('SIGTERM')
      setTimeout(() => this.child?.kill('SIGKILL'), 5000)
    }
  }
}

// ── Plugin ──

export const name = 'fleet-github'
export const inject = ['tools']

export interface Config {
  appId?: string
  installationId?: string
  dopplerProject?: string
  dopplerConfig?: string
  dopplerSecretKey?: string
  nodeBin?: string
  tokenLifetimeS?: number
  maxCrashes?: number
  crashCooldownMs?: number
  healthCheckMs?: number
}

export const Config: z<Config> = z.object({
  appId: z.string().optional(),
  installationId: z.string().optional(),
  dopplerProject: z.string().optional(),
  dopplerConfig: z.string().optional(),
  dopplerSecretKey: z.string().optional(),
  nodeBin: z.string().optional(),
  tokenLifetimeS: z.number().optional(),
  maxCrashes: z.number().optional(),
  crashCooldownMs: z.number().optional(),
  healthCheckMs: z.number().optional(),
})

export function apply(ctx: Context, config: Config): void {
  const service = new FleetGithubService(ctx)
  ;(service as any).config = config

  ctx.effect(() => {
    service.start().catch(err => {
      process.stderr.write(`[fleet-github] FATAL: ${err.message}\n`)
    })

    return () => service.stop()
  }, 'fleet-github.lifecycle')
}
