import { describe, expect, it } from 'vitest'
import { hip3Tools } from '../src/tools/hip3.js'
import { apiList } from './fixtures.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`
const WINDOW = { start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-02T00:00:00Z' }

describe('HIP-3 windows are sent as start/end', () => {
  it('hd_hip3_fills sends start/end and every filter', async () => {
    const { calls } = await run(
      hip3Tools,
      'hd_hip3_fills',
      { ...WINDOW, dex_id: 'xyz', coin: 'xyz:NVDA', user: A, side: 'B', min_notional: 10000 },
      [{ match: '/hip3/fills', json: [] }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('start')).toBe('2026-10-01T00:00:00.000Z')
    expect(q?.get('end')).toBe('2026-10-02T00:00:00.000Z')
    expect(q?.has('start_time')).toBe(false)
    expect(q?.get('dex_id')).toBe('xyz')
    expect(q?.get('coin')).toBe('xyz:NVDA')
    expect(q?.get('user')).toBe(A)
    expect(q?.get('side')).toBe('B')
    expect(q?.get('min_notional')).toBe('10000')
  })

  it('hd_hip3_ohlcv sends start/end, dex_id, no offset, and hints when full', async () => {
    const { calls, sc } = await run(
      hip3Tools,
      'hd_hip3_ohlcv',
      { coin: 'xyz:TSLA', dex_id: 'xyz', limit: 1, ...WINDOW },
      [{ match: '/hip3/ohlcv', json: [{ time: '2026-10-01T00:00:00', trades: 3 }] }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('start')).toBe('2026-10-01T00:00:00.000Z')
    expect(q?.get('dex_id')).toBe('xyz')
    expect(q?.has('offset')).toBe(false)
    expect(sc.pagination).toBeUndefined()
    expect(sc.notes.join(' ')).toContain('2026-10-01T00:00:00')
  })

  it('hd_hip3_oracle_stats defaults to 1440 rows and sends start/end', async () => {
    const { calls } = await run(hip3Tools, 'hd_hip3_oracle_stats', { dex_id: 'xyz', ...WINDOW }, [
      { match: '/hip3/oracle/stats', json: [] },
    ])
    const q = calls[0]?.url.searchParams
    expect(q?.get('limit')).toBe('1440')
    expect(q?.get('end')).toBe('2026-10-02T00:00:00.000Z')
    expect(q?.has('offset')).toBe(false)
  })

  it('hd_hip3_user fills sends start/end, coin and dex_id', async () => {
    const { calls } = await run(
      hip3Tools,
      'hd_hip3_user',
      { address: A, view: 'fills', coin: 'xyz:TSLA', dex_id: 'xyz', ...WINDOW },
      [{ match: '/fills', json: [] }],
    )
    const q = calls[0]?.url.searchParams
    expect(calls[0]?.url.pathname).toBe(`/hip3/users/${A}/fills`)
    expect(q?.get('start')).toBe('2026-10-01T00:00:00.000Z')
    expect(q?.get('coin')).toBe('xyz:TSLA')
    expect(q?.get('dex_id')).toBe('xyz')
  })
})

describe('HIP-3 filters', () => {
  it('assets list forwards dex_id and search', async () => {
    const { calls } = await run(hip3Tools, 'hd_hip3_assets', { dex_id: 'xyz', search: 'TSLA' }, [
      { match: '/hip3/assets', json: [] },
    ])
    expect(calls[0]?.url.searchParams.get('dex_id')).toBe('xyz')
    expect(calls[0]?.url.searchParams.get('search')).toBe('TSLA')
  })

  it('auctions: status on list, dex_id on history', async () => {
    const list = await run(hip3Tools, 'hd_hip3_auctions', { status: 'closed', dex_id: 'x' }, [
      { match: '/hip3/auctions', json: [] },
    ])
    expect(list.calls[0]?.url.searchParams.get('status')).toBe('closed')
    expect(list.calls[0]?.url.searchParams.has('dex_id')).toBe(false)
    const hist = await run(
      hip3Tools,
      'hd_hip3_auctions',
      { view: 'history', dex_id: 'xyz', status: 'open' },
      [{ match: '/hip3/auctions/history', json: [] }],
    )
    expect(hist.calls[0]?.url.searchParams.get('dex_id')).toBe('xyz')
    expect(hist.calls[0]?.url.searchParams.has('status')).toBe(false)
  })

  it('snapshots forwards dex_id and coin', async () => {
    const { calls, sc } = await run(
      hip3Tools,
      'hd_hip3_snapshots',
      { dex_id: 'xyz', coin: 'xyz:TSLA' },
      [{ match: '/hip3/snapshots', json: [{ coin: 'xyz:TSLA', total_volume_cumulative: 1 }] }],
    )
    expect(calls[0]?.url.searchParams.get('coin')).toBe('xyz:TSLA')
    expect(sc.data[0].total_volume_cumulative).toBe(1)
  })

  it('leaderboard defaults by=volume and accepts trades/fees + dex_id', async () => {
    const def = await run(hip3Tools, 'hd_hip3_traders', { view: 'leaderboard' }, [
      { match: '/hip3/leaderboard', json: [] },
    ])
    expect(def.calls[0]?.url.searchParams.get('by')).toBe('volume')
    const fees = await run(
      hip3Tools,
      'hd_hip3_traders',
      { view: 'leaderboard', by: 'fees', dex_id: 'km' },
      [{ match: '/hip3/leaderboard', json: [] }],
    )
    expect(fees.calls[0]?.url.searchParams.get('by')).toBe('fees')
    expect(fees.calls[0]?.url.searchParams.get('dex_id')).toBe('km')
  })

  it('stats forwards dex_id and coin', async () => {
    const { calls } = await run(hip3Tools, 'hd_hip3_traders', { dex_id: 'xyz', coin: 'xyz:TSLA' }, [
      { match: '/hip3/stats/traders', json: [] },
    ])
    expect(calls[0]?.url.searchParams.get('coin')).toBe('xyz:TSLA')
  })

  it('gossip history forwards slot_id and order', async () => {
    const { calls } = await run(
      hip3Tools,
      'hd_hip3_gossip',
      { view: 'history', slot_id: 0, order: 'ASC' },
      [{ match: '/gossip/history', json: apiList([]) }],
    )
    expect(calls[0]?.url.searchParams.get('slot_id')).toBe('0')
    expect(calls[0]?.url.searchParams.get('order')).toBe('ASC')
  })
})
