/**
 * @hydra/dsh-fleet-searxng — SearXNG metasearch as a DSH model-facing tool.
 *
 * Wraps the SearXNG HTTP JSON API as a `web_search` tool on `ctx.tools`,
 * providing the model with web search capabilities via the locally-hosted
 * SearXNG instance (Google, Bing, DuckDuckGo, etc.).
 *
 * The tool name is `web_search` — the same name the shipped DeepSeek search
 * tool uses. When this plugin is mounted, it replaces the DeepSeek search
 * provider with the local SearXNG instance, giving the fleet full control
 * over search without external API dependencies.
 *
 * ```
 * - id: fleet-searxng
 *   name: '@hydra/dsh-fleet-searxng'
 *   config:
 *     searxngUrl: http://127.0.0.1:8099
 * ```
 *
 * @module @hydra/dsh-fleet-searxng
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetSearxng: FleetSearxngService
  }
}

// ---- Config ----

export interface Config {
  /** SearXNG instance URL (default: http://127.0.0.1:8099). */
  searxngUrl: string
  /** Per-request timeout in ms (default: 30000). */
  timeoutMs: number
  /** Default search language (default: en). */
  language: string
  /** Default engines to use (empty = all enabled engines). */
  engines: string[]
  /** Max results to return to the model (default: 10). */
  maxResults: number
}

export const Config: z<Config> = z.object({
  searxngUrl: z.string().default('http://127.0.0.1:8099'),
  timeoutMs: z.number().default(30_000),
  language: z.string().default('en'),
  engines: z.array(String).default([]),
  maxResults: z.number().min(1).max(50).default(10),
})

// ---- Types ----

interface SearxngResult {
  title: string
  url: string
  content: string
  engine: string
  score: number
}

interface SearxngResponse {
  results: SearxngResult[]
  number_of_results: number
}

// ---- Service ----

export class FleetSearxngService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fleetSearxng')
  }
}

// ---- Plugin ----

export const name = 'fleet-searxng'
export const inject = ['tools']

export async function apply(ctx: Context, config: Config): Promise<void> {
  new FleetSearxngService(ctx)

  const { searxngUrl, timeoutMs, language, engines, maxResults } = config

  // Register the web_search tool on ctx.tools
  ctx.tools.register({
    name: 'web_search',
    description: 'Search the web via SearXNG metasearch engine (Google, Bing, DuckDuckGo, etc.). Returns titles, URLs, and snippets.',
    parameters: z.object({
      query: z.string().describe('The search query to execute'),
      engines: z.array(String).optional().describe('Comma-separated engine names to use (e.g. google, bing, duckduckgo). Omit for all enabled engines.'),
      language: z.string().optional().describe('ISO 639-1 language code (e.g. en, vi, ja). Default: en'),
    }),
    execute: async (_signal, params) => {
      const { query, engines: requestEngines, language: requestLang } = params

      const searchParams = new URLSearchParams({
        q: query,
        format: 'json',
        language: requestLang ?? language,
      })

      if (requestEngines?.length) {
        searchParams.set('engines', requestEngines.join(','))
      } else if (engines.length) {
        searchParams.set('engines', engines.join(','))
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch(`${searxngUrl}/search?${searchParams}`, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' },
        })

        if (!response.ok) {
          return { content: [{ type: 'text', text: `SearXNG error: HTTP ${response.status}` }], isError: true }
        }

        const data: SearxngResponse = await response.json() as SearxngResponse
        const results = data.results.slice(0, maxResults)

        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No results found for: ${query}` }] }
        }

        const formatted = results.map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content?.slice(0, 200) || '(no snippet)'}`
        ).join('\n\n')

        return {
          content: [{
            type: 'text',
            text: `Found ${data.number_of_results} results (showing ${results.length}):\n\n${formatted}`,
          }],
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { content: [{ type: 'text', text: `SearXNG search failed: ${msg}` }], isError: true }
      } finally {
        clearTimeout(timer)
      }
    },
  })
}
