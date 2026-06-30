import { describe, expect, it } from 'vitest'
import {
  assertSafeCursorOrder,
  notYetLiveNote,
  nullifyEpochSentinel,
  renameGossipAddress,
  sanitizeTotalCount,
} from '../src/hypedexer/quirks.js'

describe('quirks', () => {
  it('nullifies epoch-zero and 1970 ISO sentinels', () => {
    expect(nullifyEpochSentinel(0)).toBeNull()
    expect(nullifyEpochSentinel('1970-01-01T00:00:00')).toBeNull()
    expect(nullifyEpochSentinel('1970-01-01T00:00:00.000Z')).toBeNull()
    expect(nullifyEpochSentinel(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(nullifyEpochSentinel('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z')
  })

  it('refuses ascending cursor order, allows desc/undefined', () => {
    expect(() => assertSafeCursorOrder('asc')).toThrow(/ascending/i)
    expect(() => assertSafeCursorOrder('desc')).not.toThrow()
    expect(() => assertSafeCursorOrder(undefined)).not.toThrow()
  })

  it('drops a total_count that merely echoes the page size', () => {
    expect(sanitizeTotalCount(50, 50)).toBeUndefined()
    expect(sanitizeTotalCount(1234, 50)).toBe(1234)
    expect(sanitizeTotalCount(null, 50)).toBeNull()
  })

  it('renames an IPv4 address field to nodeIp', () => {
    expect(renameGossipAddress({ address: '1.2.3.4', x: 1 })).toEqual({ x: 1, nodeIp: '1.2.3.4' })
    expect(renameGossipAddress({ address: '0xabc', x: 1 })).toEqual({ address: '0xabc', x: 1 })
  })

  it('produces a not_yet_live note only when status matches', () => {
    expect(notYetLiveNote('not_yet_live', 'https://docs')).toMatch(/not yet live/i)
    expect(notYetLiveNote('not_yet_live', 'https://docs')).toMatch(/https:\/\/docs/)
    expect(notYetLiveNote('live')).toBeUndefined()
    expect(notYetLiveNote(undefined)).toBeUndefined()
  })
})
