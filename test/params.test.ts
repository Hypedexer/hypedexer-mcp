import { describe, expect, it } from 'vitest'
import { analyticsTools } from '../src/tools/analytics.js'
import { buildersTools } from '../src/tools/builders.js'
import { liquidationsTools } from '../src/tools/liquidations.js'
import { marketsTools } from '../src/tools/markets.js'
import { twapsTools } from '../src/tools/twaps.js'
import { vaultsTools } from '../src/tools/vaults.js'
import { apiList, apiSingle } from './fixtures.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`
const B = `0x${'b'.repeat(40)}`

describe('hd_builder_users', () => {
  it('top view caps limit at 100 and sends no offset', async () => {
    const ok = await run(buildersTools, 'hd_builder_users', { address: A, limit: 100 }, [
      { match: '/users', json: apiSingle({ timeframe: '24h', builder: A, users: [{ user: B }] }) },
    ])
    expect(ok.calls[0]?.url.searchParams.has('offset')).toBe(false)
    expect(ok.sc.data).toHaveLength(1)
    const tooBig = await run(buildersTools, 'hd_builder_users', { address: A, limit: 101 }, [])
    expect(tooBig.res.isError).toBe(true)
  })

  it('external_activity posts users, timeframe and includeNoBuilder', async () => {
    const { calls, sc } = await run(
      buildersTools,
      'hd_builder_users',
      {
        address: A,
        view: 'external_activity',
        users: [B],
        timeframe: '24h',
        include_no_builder: false,
      },
      [{ match: '/external-activity', json: apiSingle({ summary: { usersChecked: 1 } }) }],
    )
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url.pathname).toBe(`/builders/${A}/external-activity`)
    expect(calls[0]?.body).toEqual({ users: [B], timeframe: '24h', includeNoBuilder: false })
    expect(sc.data.summary.usersChecked).toBe(1)
  })

  it('external_activity requires users', async () => {
    const { res, calls } = await run(
      buildersTools,
      'hd_builder_users',
      { address: A, view: 'external_activity' },
      [],
    )
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('analytics and markets params', () => {
  it('priority-fee stats forward coin', async () => {
    const { calls } = await run(
      analyticsTools,
      'hd_analytics_priority_fees',
      { view: 'stats', hours: 24, coin: 'BTC' },
      [{ match: '/priority-fees/stats', json: apiSingle({}) }],
    )
    expect(calls[0]?.url.searchParams.get('coin')).toBe('BTC')
    expect(calls[0]?.url.searchParams.get('hours')).toBe('24')
  })

  it('24h snapshot forwards the top-traders sort and limit', async () => {
    const { calls } = await run(
      marketsTools,
      'hd_market_snapshot_24h',
      { top_traders_sort: 'pnl_neg', top_traders_limit: 50 },
      [
        { match: '/overview/top-traders-24h', json: apiList([]) },
        { match: '/overview/', json: apiSingle({}) },
      ],
    )
    const top = calls.find((c) => c.url.pathname === '/overview/top-traders-24h')
    expect(top?.url.searchParams.get('sort')).toBe('pnl_neg')
    expect(top?.url.searchParams.get('limit')).toBe('50')
  })
})

describe('twaps, vaults and liquidations params', () => {
  it('per-user TWAPs keep coin, status, hours and order', async () => {
    const { calls } = await run(
      twapsTools,
      'hd_twaps_search',
      { address: A, coin: 'BTC', status: 'terminated', hours: 720, order: 'ASC' },
      [{ match: '/twaps/user/', json: apiList([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('coin')).toBe('BTC')
    expect(q?.get('status')).toBe('terminated')
    expect(q?.get('hours')).toBe('720')
    expect(q?.get('order')).toBe('ASC')
    const tooLong = await run(twapsTools, 'hd_twaps_search', { hours: 721 }, [])
    expect(tooLong.res.isError).toBe(true)
  })

  it('TWAP fills forward order', async () => {
    const { calls } = await run(
      twapsTools,
      'hd_twap_detail',
      { twap_id: 5, include_fills: true, order: 'DESC' },
      [
        { match: '/twaps/5/fills', json: apiList([]) },
        { match: '/twaps/5', json: apiSingle({ twapId: 5 }) },
      ],
    )
    const fills = calls.find((c) => c.url.pathname === '/twaps/5/fills')
    expect(fills?.url.searchParams.get('order')).toBe('DESC')
  })

  it('vault details forward limit', async () => {
    const { calls } = await run(vaultsTools, 'hd_vault_details', { vault_address: A, limit: 2 }, [
      { match: '/vaults/vaultDetails', json: { portfolio: [] } },
    ])
    expect(calls[0]?.url.searchParams.get('limit')).toBe('2')
  })

  it('liquidations forward amount_dollars and accept limit 1000', async () => {
    const { calls } = await run(
      liquidationsTools,
      'hd_liquidations_search',
      { amount_dollars: 1000000, limit: 1000 },
      [{ match: '/liquidations/', json: apiList([]) }],
    )
    expect(calls[0]?.url.searchParams.get('amount_dollars')).toBe('1000000')
    expect(calls[0]?.url.searchParams.get('limit')).toBe('1000')
  })
})
