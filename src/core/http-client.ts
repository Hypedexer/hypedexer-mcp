import { NetworkError, parseError } from './errors.js'

export type FetchLike = typeof fetch

export interface HttpClientOptions {
  apiKey: string
  baseUrl?: string
  fetch?: FetchLike
  timeoutMs?: number
  userAgent?: string
  defaultHeaders?: Record<string, string>
}

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
  query?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://api.hypedexer.com'
const DEFAULT_TIMEOUT_MS = 30_000

export class HttpClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchFn: FetchLike
  private readonly timeoutMs: number
  private readonly defaultHeaders: Record<string, string>

  constructor(opts: HttpClientOptions) {
    if (!opts.apiKey) throw new TypeError('HttpClient requires an apiKey')
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.defaultHeaders = {
      'X-API-Key': this.apiKey,
      accept: 'application/json',
      ...(opts.userAgent ? { 'user-agent': opts.userAgent } : {}),
      ...(opts.defaultHeaders ?? {}),
    }
  }

  async request<T>(req: HttpRequest): Promise<T> {
    const url = this.buildUrl(req.path, req.query)
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(req.headers ?? {}) }
    let body: string | undefined
    if (req.body !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json'
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    }

    const timeout = req.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    const onAbort = () => controller.abort(req.signal?.reason)
    if (req.signal) {
      if (req.signal.aborted) controller.abort(req.signal.reason)
      else req.signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(
      () => controller.abort(new Error(`request timed out after ${timeout}ms`)),
      timeout,
    )

    const init: RequestInit = {
      method: req.method ?? 'GET',
      headers,
      signal: controller.signal,
    }
    if (body !== undefined) init.body = body

    let response: Response
    try {
      response = await this.fetchFn(url, init)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'fetch failed'
      throw new NetworkError(message, { cause })
    } finally {
      clearTimeout(timer)
      if (req.signal) req.signal.removeEventListener('abort', onAbort)
    }

    const text = await response.text()
    if (!response.ok) {
      throw parseError(response.status, response.headers.get('content-type') ?? '', text)
    }

    if (text.length === 0) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch (cause) {
      throw new NetworkError('failed to parse response body', { cause, rawBody: text })
    }
  }

  private buildUrl(path: string, query?: HttpRequest['query']): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${this.baseUrl}${normalizedPath}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue
        url.searchParams.set(k, String(v))
      }
    }
    return url.toString()
  }
}
