import { HttpClient, type HttpRequest } from '../core/http-client.js'
import type { Page, Single } from '../core/types.js'
import { fromApiList, fromApiSingle, fromBareList, fromBareSingle, fromHip4 } from './envelope.js'

export interface HypedexerClientOptions {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
  /** Extra headers sent on every request (e.g. hosted-MCP metering headers). */
  defaultHeaders?: Record<string, string>
}

export type Query = Record<string, string | number | boolean | null | undefined>

/**
 * Thin typed caller over the vendored `HttpClient`. Methods return raw JSON
 * (`get`) or envelope-normalized `Page`/`Single` values. Tools choose the
 * normalizer that matches the endpoint's documented envelope family.
 */
export class HypedexerClient {
  private readonly http: HttpClient

  constructor(opts: HypedexerClientOptions) {
    this.http = new HttpClient({
      apiKey: opts.apiKey,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
      ...(opts.defaultHeaders !== undefined ? { defaultHeaders: opts.defaultHeaders } : {}),
    })
  }

  /** Raw GET - returns the unparsed-by-envelope JSON body. */
  get<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    const req: HttpRequest = { method: 'GET', path }
    if (query !== undefined) req.query = query
    if (signal !== undefined) req.signal = signal
    return this.http.request<T>(req)
  }

  /** POST (used by the `/info` dispatcher). */
  post<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const req: HttpRequest = { method: 'POST', path, body }
    if (signal !== undefined) req.signal = signal
    return this.http.request<T>(req)
  }

  // --- Envelope-normalized convenience getters -----------------------------

  async getApiList<T>(path: string, query?: Query, signal?: AbortSignal): Promise<Page<T>> {
    return fromApiList<T>(await this.get(path, query, signal))
  }

  async getApiSingle<T>(path: string, query?: Query, signal?: AbortSignal): Promise<Single<T>> {
    return fromApiSingle<T>(await this.get(path, query, signal))
  }

  async getBareList<T>(path: string, query?: Query, signal?: AbortSignal): Promise<Page<T>> {
    return fromBareList<T>(await this.get(path, query, signal))
  }

  async getBareSingle<T>(path: string, query?: Query, signal?: AbortSignal): Promise<Single<T>> {
    return fromBareSingle<T>(await this.get(path, query, signal))
  }

  async getHip4<T>(path: string, query?: Query, signal?: AbortSignal): Promise<Page<T>> {
    return fromHip4<T>(await this.get(path, query, signal))
  }
}
