import type { Page } from './types.js'

export type PaginationKind = 'cursor' | 'offset' | 'timeWindow' | 'none'

export interface PaginationContext {
  kind: PaginationKind
  limit?: number
  /** offset-only: starting offset (default 0) */
  initialOffset?: number
  /** timeWindow-only: returns the time value used as endTime cursor */
  timeKey?: string
}

export type PageFetcher<T, P> = (params: P) => Promise<Page<T>>

function isPageEmpty<T>(page: Page<T>): boolean {
  return page.data.length === 0
}

function timeOfRow(row: unknown, key: string): number | null {
  if (typeof row !== 'object' || row === null) return null
  const v = (row as Record<string, unknown>)[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n) && String(n) === v) return n
    const d = Date.parse(v)
    return Number.isNaN(d) ? null : d
  }
  return null
}

export async function* iterate<T, P extends Record<string, unknown>>(
  fetcher: PageFetcher<T, P>,
  initialParams: P,
  ctx: PaginationContext,
): AsyncIterable<T> {
  if (ctx.kind === 'none') {
    const page = await fetcher(initialParams)
    for (const row of page.data) yield row
    return
  }

  if (ctx.kind === 'cursor') {
    let params: P = { ...initialParams }
    while (true) {
      const page = await fetcher(params)
      for (const row of page.data) yield row
      const next = page.meta.nextCursor
      if (!next || page.meta.hasMore === false) return
      params = { ...params, cursor: next }
    }
  }

  if (ctx.kind === 'offset') {
    const limit =
      ctx.limit ?? (typeof initialParams.limit === 'number' ? (initialParams.limit as number) : 100)
    let offset = ctx.initialOffset ?? 0
    let params: P = { ...initialParams, limit, offset }
    while (true) {
      const page = await fetcher(params)
      for (const row of page.data) yield row
      if (page.data.length < limit) return
      offset += limit
      params = { ...params, offset }
    }
  }

  if (ctx.kind === 'timeWindow') {
    const key = ctx.timeKey ?? 'time'
    let params: P = { ...initialParams }
    while (true) {
      const page = await fetcher(params)
      if (isPageEmpty(page)) return
      for (const row of page.data) yield row
      const oldest = page.data[page.data.length - 1]
      const t = timeOfRow(oldest, key)
      if (t === null) return
      params = { ...params, endTime: t - 1 }
    }
  }
}
