import { type TimeEncodeTarget, encodeTime } from '../../core/time.js'
import type { Page } from '../../core/types.js'
import type { Query } from '../../hypedexer/client.js'

/**
 * A uniform pagination handle returned in every list tool's structuredContent.
 * Only the field relevant to the endpoint's pagination kind is populated, plus
 * a `hint` steering the agent toward the correct next call.
 */
export interface PaginationOut {
  returned: number
  has_more: boolean
  next_cursor?: string
  next_offset?: number
  next_end_time?: number
  next_page?: number
  hint?: string
}

export type PaginationKind = 'cursor' | 'offset' | 'time-window' | 'none'

/** Encode common list inputs into HypeDexer query params. */
export function buildTimeQuery(
  query: Query,
  opts: {
    start?: string | undefined
    end?: string | undefined
    target: TimeEncodeTarget
    startKey: string
    endKey: string
  },
): Query {
  const out: Query = { ...query }
  if (opts.start !== undefined && opts.start !== '')
    out[opts.startKey] = encodeTime(opts.start, opts.target)
  if (opts.end !== undefined && opts.end !== '')
    out[opts.endKey] = encodeTime(opts.end, opts.target)
  return out
}

/** Derive the uniform pagination handle for a cursor-paginated page. */
export function cursorPagination<T>(page: Page<T>): PaginationOut {
  const next = page.meta.nextCursor ?? undefined
  const hasMore = page.meta.hasMore ?? Boolean(next)
  const out: PaginationOut = { returned: page.data.length, has_more: hasMore }
  if (hasMore && next) {
    out.next_cursor = next
    out.hint = 'More records exist. Call again with cursor=pagination.next_cursor to continue.'
  }
  return out
}

/** Derive the handle for an offset-paginated page (more exists iff the page was full). */
export function offsetPagination<T>(page: Page<T>, offset: number, limit: number): PaginationOut {
  const hasMore = page.data.length === limit
  const out: PaginationOut = { returned: page.data.length, has_more: hasMore }
  if (hasMore) {
    out.next_offset = offset + limit
    out.hint = 'Page was full; more may exist. Call again with offset=pagination.next_offset.'
  }
  return out
}

/** Derive the handle for a time-window-paginated page (decrement endTime past the oldest row). */
export function timeWindowPagination<T>(page: Page<T>, timeKey: string): PaginationOut {
  const out: PaginationOut = { returned: page.data.length, has_more: page.data.length > 0 }
  if (page.data.length === 0) {
    out.has_more = false
    return out
  }
  const oldest = page.data[page.data.length - 1]
  const t = readEpochMs(oldest, timeKey)
  if (t !== null) {
    out.next_end_time = t - 1
    out.hint =
      'Time-window paginated. Call again with end_time=pagination.next_end_time to fetch older records.'
  }
  return out
}

function readEpochMs(row: unknown, key: string): number | null {
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

/**
 * Gap-free backwards paging for newest-first endpoints whose rows can share one
 * timestamp (funding settlements, ledger entries, TWAP slices) and whose endTime
 * is inclusive. When a page is full, the rows carrying its oldest timestamp may
 * be only part of that instant, so they are dropped from this page and
 * next_end_time is set to that same timestamp: the next call returns them whole.
 * If every row shares one timestamp (nothing to drop safely), the page is kept
 * and next_end_time steps 1 ms past it.
 */
export function settlementSafePage<T>(
  rows: T[],
  limit: number,
  readTime: (row: T) => number | null,
): { rows: T[]; pagination: PaginationOut } {
  if (rows.length < limit || rows.length === 0) {
    return { rows, pagination: { returned: rows.length, has_more: false } }
  }
  const oldest = readTime(rows[rows.length - 1] as T)
  if (oldest === null) {
    return { rows, pagination: { returned: rows.length, has_more: true } }
  }
  const kept = rows.filter((r) => readTime(r) !== oldest)
  const hint =
    'Page was full. Call again with end_time=pagination.next_end_time to continue backwards without gaps.'
  if (kept.length === 0) {
    return {
      rows,
      pagination: { returned: rows.length, has_more: true, next_end_time: oldest - 1, hint },
    }
  }
  return {
    rows: kept,
    pagination: { returned: kept.length, has_more: true, next_end_time: oldest, hint },
  }
}

/** Read an epoch-ms timestamp at a dotted path (e.g. "fill.time"). */
export function epochAt(row: unknown, path: string): number | null {
  let cur: unknown = row
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return null
    cur = (cur as Record<string, unknown>)[key]
  }
  return readEpochMs({ v: cur }, 'v')
}
