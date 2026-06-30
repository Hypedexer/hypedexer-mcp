import { describe, expect, it } from 'vitest'
import type { Page } from '../src/core/types.js'
import {
  buildTimeQuery,
  cursorPagination,
  offsetPagination,
  timeWindowPagination,
} from '../src/tools/shared/pagination.js'

function page<T>(data: T[], meta: Partial<Page<T>['meta']> = {}): Page<T> {
  return { data, meta: { family: 'apiResponse', ...meta } }
}

describe('pagination handles', () => {
  it('cursor: surfaces next_cursor + hint when more exists', () => {
    const p = cursorPagination(page([{ a: 1 }], { nextCursor: '99:x', hasMore: true }))
    expect(p).toMatchObject({ returned: 1, has_more: true, next_cursor: '99:x' })
    expect(p.hint).toMatch(/next_cursor/)
  })

  it('cursor: no next when hasMore false', () => {
    const p = cursorPagination(page([{ a: 1 }], { hasMore: false, nextCursor: 'x' }))
    expect(p.has_more).toBe(false)
    expect(p.next_cursor).toBeUndefined()
  })

  it('offset: more iff the page was full', () => {
    expect(offsetPagination(page([1, 2, 3]), 0, 3)).toMatchObject({
      has_more: true,
      next_offset: 3,
    })
    expect(offsetPagination(page([1, 2]), 0, 3).has_more).toBe(false)
  })

  it('time-window: decrements end_time past the oldest row', () => {
    const rows = [{ time: 1_700_000_500 }, { time: 1_700_000_100 }]
    const p = timeWindowPagination(page(rows), 'time')
    expect(p.next_end_time).toBe(1_700_000_099)
    expect(p.hint).toMatch(/next_end_time/)
  })

  it('time-window: empty page ends pagination', () => {
    expect(timeWindowPagination(page([]), 'time')).toMatchObject({ returned: 0, has_more: false })
  })

  it('buildTimeQuery: encodes only provided bounds with the chosen target', () => {
    const q = buildTimeQuery(
      {},
      {
        start: '2026-01-01T00:00:00Z',
        target: 'epochCamel',
        startKey: 'startTime',
        endKey: 'endTime',
      },
    )
    expect(q.startTime).toBe(Date.parse('2026-01-01T00:00:00Z'))
    expect(q.endTime).toBeUndefined()
  })

  it('buildTimeQuery: isoSnake keeps an ISO string', () => {
    const q = buildTimeQuery(
      {},
      {
        start: '2026-01-01T00:00:00Z',
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      },
    )
    expect(String(q.start_time)).toMatch(/^2026-01-01T00:00:00/)
  })
})
