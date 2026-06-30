import { NetworkError, parseError } from '../core/errors.js'

/**
 * Client for the FREE, keyless Hyperliquid public info API.
 *
 * Every read is `POST {baseUrl}/info` with a JSON body `{ type, ...params }`.
 * No authentication. This is what lets the MCP server boot and smoke-test
 * end-to-end with no HypeDexer API key.
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */
export interface HyperliquidPublicClientOptions {
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
}

const DEFAULT_BASE_URL = 'https://api.hyperliquid.xyz'
const DEFAULT_TIMEOUT_MS = 30_000

export class HyperliquidPublicClient {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly userAgent: string

  constructor(opts: HyperliquidPublicClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.userAgent = opts.userAgent ?? 'hypedexer-mcp'
  }

  /** POST a typed info request and return the parsed JSON body. */
  async info<T = unknown>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(
      () => controller.abort(new Error(`request timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    )

    let response: Response
    try {
      response = await this.fetchFn(`${this.baseUrl}/info`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': this.userAgent,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'fetch failed'
      throw new NetworkError(message, { cause })
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const text = await response.text()
    if (!response.ok) {
      throw parseError(response.status, response.headers.get('content-type') ?? '', text)
    }
    if (text.length === 0) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch (cause) {
      throw new NetworkError('failed to parse Hyperliquid response body', { cause, rawBody: text })
    }
  }
}
