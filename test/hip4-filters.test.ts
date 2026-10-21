import { describe, expect, it } from 'vitest'
import { hip4Tools } from '../src/tools/hip4.js'
import { hip4 } from './fixtures.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`
const START = '2026-10-21T00:00:00Z'
const START_MS = String(Date.parse(START))

describe('HIP-4 filters and epoch windows', () => {
  it('markets forward outcome_id, question_id, class and underlying', async () => {
    const { calls } = await run(
      hip4Tools,
      'hd_hip4_markets',
      { outcome_id: 11, question_id: 1, class: 'priceBinary', underlying: 'BTC' },
      [{ match: '/hip4/markets', json: hip4([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('outcome_id')).toBe('11')
    expect(q?.get('question_id')).toBe('1')
    expect(q?.get('class')).toBe('priceBinary')
    expect(q?.get('underlying')).toBe('BTC')
  })

  it('questions forward question_id; outcome tokens forward outcome_id', async () => {
    const qs = await run(hip4Tools, 'hd_hip4_questions', { question_id: 1 }, [
      { match: '/hip4/questions', json: hip4([]) },
    ])
    expect(qs.calls[0]?.url.searchParams.get('question_id')).toBe('1')
    const tok = await run(hip4Tools, 'hd_hip4_outcome_tokens', { outcome_id: 11 }, [
      { match: '/hip4/outcome-tokens', json: hip4([]) },
    ])
    expect(tok.calls[0]?.url.searchParams.get('outcome_id')).toBe('11')
  })

  it('fills send the window as epoch ms', async () => {
    const { calls } = await run(hip4Tools, 'hd_hip4_fills', { start_time: START }, [
      { match: '/hip4/fills', json: hip4([]) },
    ])
    expect(calls[0]?.url.searchParams.get('start')).toBe(START_MS)
  })

  it('fees forward user and coin with an epoch window', async () => {
    const { calls } = await run(
      hip4Tools,
      'hd_hip4_fees',
      { user: A, coin: '#132151', start_time: START },
      [{ match: '/hip4/fees', json: hip4([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('user')).toBe(A)
    expect(q?.get('coin')).toBe('#132151')
    expect(q?.get('start')).toBe(START_MS)
  })

  it('settlements forward outcome_id with an epoch window', async () => {
    const { calls } = await run(
      hip4Tools,
      'hd_hip4_settlements',
      { outcome_id: 14726, end_time: START },
      [{ match: '/hip4/settlements', json: hip4([]) }],
    )
    expect(calls[0]?.url.searchParams.get('outcome_id')).toBe('14726')
    expect(calls[0]?.url.searchParams.get('end')).toBe(START_MS)
  })

  it('analytics never sends a window or an offset', async () => {
    const { calls, sc } = await run(
      hip4Tools,
      'hd_hip4_analytics',
      { interval: '1d', limit: 2, start_time: START, offset: 4 },
      [{ match: '/hip4/analytics', json: hip4([{ bucket: '2026-10-21T00:00:00' }]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('interval')).toBe('1d')
    expect(q?.has('start')).toBe(false)
    expect(q?.has('offset')).toBe(false)
    expect(sc.pagination).toBeUndefined()
  })
})
