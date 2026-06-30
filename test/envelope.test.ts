import { describe, expect, it } from 'vitest'
import {
  fromApiList,
  fromApiSingle,
  fromBareList,
  fromBareSingle,
  fromHip4,
  unwrapInfo,
} from '../src/hypedexer/envelope.js'
import { apiList, apiSingle, hip4 } from './fixtures.js'

describe('envelope normalization', () => {
  it('normalizes an APIResponse list with pagination meta', () => {
    const page = fromApiList<{ id: number }>(
      apiList([{ id: 1 }, { id: 2 }], {
        next_cursor: '1700:abc',
        has_more: true,
        total_count: 42,
        execution_time_ms: 12,
      }),
    )
    expect(page.data).toHaveLength(2)
    expect(page.meta.family).toBe('apiResponse')
    expect(page.meta.nextCursor).toBe('1700:abc')
    expect(page.meta.hasMore).toBe(true)
    expect(page.meta.totalCount).toBe(42)
    expect(page.meta.executionMs).toBe(12)
  })

  it('defaults a missing list payload to an empty array', () => {
    expect(fromApiList({ success: true }).data).toEqual([])
  })

  it('normalizes an APIResponse single', () => {
    const single = fromApiSingle<{ count: number }>(apiSingle({ count: 7 }))
    expect(single.data).toEqual({ count: 7 })
    expect(single.meta.family).toBe('apiResponse')
  })

  it('passes a bare array straight through', () => {
    const page = fromBareList<number>([1, 2, 3])
    expect(page.data).toEqual([1, 2, 3])
    expect(page.meta.family).toBe('bare')
  })

  it('wraps a bare object as a single', () => {
    expect(fromBareSingle({ a: 1 }).data).toEqual({ a: 1 })
  })

  it('normalizes a HIP-4 envelope and surfaces not_yet_live status', () => {
    const live = fromHip4(hip4([{ m: 1 }]))
    expect(live.data).toHaveLength(1)
    expect(live.meta.status).toBe('live')

    const pending = fromHip4(hip4([], { status: 'not_yet_live', testnet_docs: 'https://x' }))
    expect(pending.data).toEqual([])
    expect(pending.meta.status).toBe('not_yet_live')
    expect(pending.meta.testnetDocs).toBe('https://x')
  })

  it('unwraps the two info dispatcher special-cases, leaves bare payloads alone', () => {
    expect(unwrapInfo(apiSingle([{ rate: 1 }]))).toEqual([{ rate: 1 }])
    expect(unwrapInfo([{ rate: 1 }])).toEqual([{ rate: 1 }])
  })
})
