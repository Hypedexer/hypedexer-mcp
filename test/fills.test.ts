import { describe, expect, it } from 'vitest'
import { fillsTools } from '../src/tools/fills.js'
import { apiList, apiSingle } from './fixtures.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`

describe('hd_fills_search filters', () => {
  it('market-wide perp feed forwards side, size_usd, order and has_priority_gas', async () => {
    const { calls } = await run(
      fillsTools,
      'hd_fills_search',
      { side: 'A', size_usd: 1000000, order: 'ASC', has_priority_gas: true, coins: ['@1'] },
      [{ match: '/fills/', json: apiList([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(calls[0]?.url.pathname).toBe('/fills/')
    expect(q?.get('side')).toBe('A')
    expect(q?.get('size_usd')).toBe('1000000')
    expect(q?.get('order')).toBe('ASC')
    expect(q?.get('has_priority_gas')).toBe('true')
    expect(q?.has('coins')).toBe(false)
  })

  it('user perp path takes time_range but not side or size_usd', async () => {
    const { calls } = await run(
      fillsTools,
      'hd_fills_search',
      { address: A, time_range: '24h', side: 'B', size_usd: 5 },
      [{ match: '/fills/user/', json: apiList([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('time_range')).toBe('24h')
    expect(q?.has('side')).toBe(false)
    expect(q?.has('size_usd')).toBe(false)
  })

  it('spot scope repeats coins and drops time_range', async () => {
    const { calls } = await run(
      fillsTools,
      'hd_fills_search',
      { scope: 'spot', address: A, coins: ['@107', '@142'], time_range: '1h', order: 'ASC' },
      [{ match: '/fills/spot/user/', json: apiList([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.getAll('coins')).toEqual(['@107', '@142'])
    expect(q?.has('time_range')).toBe(false)
    expect(q?.get('order')).toBe('ASC')
  })
})

describe('hd_fills_count', () => {
  it('reads X-Total-Count for a spot coin over all history', async () => {
    const { calls, sc } = await run(fillsTools, 'hd_fills_count', { scope: 'spot', coin: '@307' }, [
      { match: '/info', json: [{}], headers: { 'x-total-count': '82064' } },
    ])
    expect(calls[0]?.body).toEqual({ type: 'fills', market: 'spot', limit: 1, coin: '@307' })
    expect(sc.data.count).toBe(82064)
  })

  it('perp without a window starts at 0; time_range wins over start_time', async () => {
    const perp = await run(fillsTools, 'hd_fills_count', { coin: 'BTC', side: 'B' }, [
      { match: '/info', json: [], headers: { 'x-total-count': '7' } },
    ])
    expect(perp.calls[0]?.body).toEqual({
      type: 'fills',
      market: 'perp',
      limit: 1,
      coin: 'BTC',
      side: 'B',
      startTime: 0,
    })
    const ranged = await run(
      fillsTools,
      'hd_fills_count',
      { coin: 'BTC', time_range: '1h', start_time: '5' },
      [{ match: '/info', json: [], headers: { 'x-total-count': '3' } }],
    )
    expect(ranged.calls[0]?.body).toEqual({
      type: 'fills',
      market: 'perp',
      limit: 1,
      coin: 'BTC',
      timeRange: '1h',
    })
  })

  it('no filters falls back to the global /fills/count total', async () => {
    const { calls, sc } = await run(fillsTools, 'hd_fills_count', {}, [
      { match: '/fills/count', json: apiSingle({ count: 4439411979 }) },
    ])
    expect(calls[0]?.url.pathname).toBe('/fills/count')
    expect(sc.data.count).toBe(4439411979)
  })

  it('reports an unknown count when the header is missing', async () => {
    const { sc } = await run(fillsTools, 'hd_fills_count', { coin: 'BTC', time_range: '1h' }, [
      { match: '/info', json: [] },
    ])
    expect(sc.data.count).toBeNull()
  })
})
