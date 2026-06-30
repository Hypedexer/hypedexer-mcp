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
