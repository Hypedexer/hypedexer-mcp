import type { APIResponse, Hip4Envelope } from '../src/core/types.js'

/** Build an APIResponse list envelope. */
export function apiList<T>(data: T[], extra: Partial<APIResponse<T[]>> = {}): APIResponse<T[]> {
  return { success: true, data, ...extra }
}

/** Build an APIResponse single envelope. */
export function apiSingle<T>(data: T, extra: Partial<APIResponse<T>> = {}): APIResponse<T> {
  return { success: true, data, ...extra }
}

/** Build a HIP-4 envelope. */
export function hip4<T>(data: T[], extra: Partial<Hip4Envelope<T>> = {}): Hip4Envelope<T> {
  return { status: 'live', count: data.length, data, ...extra }
}

export interface MockRoute {
  /** Substring or RegExp matched against the request URL. */
  match: string | RegExp
  status?: number
  json?: unknown
  /** Raw text body (overrides json). */
  text?: string
  headers?: Record<string, string>
}

/**
 * A deterministic `fetch` stand-in. Routes are tried in order; the first whose
 * `match` is found in the URL wins. Unmatched URLs throw, surfacing test gaps.
 */
export function mockFetch(routes: MockRoute[]): typeof fetch {
  const fn = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const route of routes) {
      const hit =
        typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url)
      if (!hit) continue
      const status = route.status ?? 200
      const body = route.text ?? JSON.stringify(route.json ?? null)
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
      })
    }
    throw new Error(`mockFetch: no route for ${url}`)
  }
  return fn as unknown as typeof fetch
}
