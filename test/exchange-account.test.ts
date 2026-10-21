import { describe, expect, it } from 'vitest'
import { accountTools } from '../src/tools/account.js'
import { exchangeTools, resolveSpot, summarizeCandles } from '../src/tools/exchange.js'
import { apiList, apiSingle } from './fixtures.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`
const B = `0x${'b'.repeat(40)}`

const candle = (t: number, v: string, n: number, h = '10', l = '8', c = '9') => ({
  t,
  T: t + 86_400_000,
  s: '@307',
  i: '1d',
  o: '9',
  c,
  h,
  l,
  v,
  n,
})

describe('hd_candles', () => {
  it('defaults to 1d from startTime 0 and returns only the summary on request', async () => {
    const { calls, sc } = await run(
      exchangeTools,
      'hd_candles',
      { coin: '@307', include_candles: false },
      [
        {
          match: '/info',
          json: [candle(0, '1.5', 3), candle(86_400_000, '2.5', 5, '12', '6', '9')],
        },
      ],
    )
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({
      type: 'candleSnapshot',
      req: { coin: '@307', interval: '1d', startTime: 0 },
    })
    expect(sc.data.base_volume).toBe(4)
    expect(sc.data.trades).toBe(8)
    expect(sc.data.high).toBe(12)
    expect(sc.data.low).toBe(6)
    // 1.5 * (10+8+9)/3 + 2.5 * (12+6+9)/3 = 13.5 + 22.5
    expect(sc.data.est_quote_volume).toBe(36)
    expect(sc.data.candles).toBe(2)
  })

  it('keeps HIP-3 case, encodes the window, and flags the 5000-candle clip', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => candle(i * 60_000, '1', 1))
    const { calls, sc } = await run(
      exchangeTools,
      'hd_candles',
      { coin: 'xyz:TSLA', interval: '1m', start_time: '1000', end_time: '2026-01-01T00:00:00Z' },
      [{ match: '/info', json: many }],
    )
    expect(calls[0]?.body?.req).toEqual({
      coin: 'xyz:TSLA',
      interval: '1m',
      startTime: 1000,
      endTime: Date.parse('2026-01-01T00:00:00Z'),
    })
    expect(sc.notes.join(' ')).toContain('5000-candle maximum')
  })

  it('rejects an interval the upstream does not serve', async () => {
    const { res } = await run(exchangeTools, 'hd_candles', { coin: 'BTC', interval: '1w' }, [])
    expect(res.isError).toBe(true)
  })

  it('summarizeCandles handles an empty series', () => {
    expect(summarizeCandles([])).toEqual({ candles: 0 })
  })
})

describe('hd_exchange_info', () => {
  it('asset_context requires coin and unwraps result', async () => {
    const missing = await run(exchangeTools, 'hd_exchange_info', { view: 'asset_context' }, [])
    expect(missing.res.isError).toBe(true)
    expect(missing.calls).toHaveLength(0)

    const { calls, sc } = await run(
      exchangeTools,
      'hd_exchange_info',
      { view: 'asset_context', coin: 'BTC' },
      [{ match: '/info', json: { result: { markPx: '1' } } }],
    )
    expect(calls[0]?.body).toEqual({ type: 'metaAndAssetCtxs', coin: 'BTC' })
    expect(sc.data).toEqual({ markPx: '1' })
  })

  it('maps dex views and requires dex where the type needs it', async () => {
    const mids = await run(exchangeTools, 'hd_exchange_info', { view: 'all_mids', dex: 'xyz' }, [
      { match: '/info', json: { 'xyz:A': '1' } },
    ])
    expect(mids.calls[0]?.body).toEqual({ type: 'allMids', dex: 'xyz' })

    const limits = await run(exchangeTools, 'hd_exchange_info', { view: 'perp_dex_limits' }, [])
    expect(limits.res.isError).toBe(true)

    const cov = await run(exchangeTools, 'hd_exchange_info', { view: 'data_coverage', dex: 'x' }, [
      { match: '/info', json: { datasets: {} } },
    ])
    expect(cov.calls[0]?.body).toEqual({ type: 'dataCoverage' })
  })

  it('borrow_lend_history forwards token, interval, window and limit', async () => {
    const { calls } = await run(
      exchangeTools,
      'hd_exchange_info',
      { view: 'borrow_lend_history', token: 0, interval: '1h', start_time: '5', limit: 2 },
      [{ match: '/info', json: { history: [] } }],
    )
    expect(calls[0]?.body).toEqual({
      type: 'borrowLendReserveHistory',
      token: 0,
      interval: '1h',
      startTime: 5,
      limit: 2,
    })
  })
})

describe('hd_order_book', () => {
  it('liquidity accepts coins and unwraps result', async () => {
    const { calls, sc } = await run(
      exchangeTools,
      'hd_order_book',
      { view: 'liquidity', coins: ['BTC', '@307'] },
      [{ match: '/info', json: { result: [{ coin: 'BTC' }, { coin: '@307' }] } }],
    )
    expect(calls[0]?.body).toEqual({ type: 'marketLiquidity', coins: ['BTC', '@307'] })
    expect(sc.data).toHaveLength(2)
  })

  it('diffs requires coin and forwards limit; trades allows no coin', async () => {
    const bad = await run(exchangeTools, 'hd_order_book', { view: 'diffs' }, [])
    expect(bad.res.isError).toBe(true)
    const diffs = await run(
      exchangeTools,
      'hd_order_book',
      { view: 'diffs', coin: 'BTC', limit: 2 },
      [{ match: '/info', json: { result: { events: [] } } }],
    )
    expect(diffs.calls[0]?.body).toEqual({ type: 'l2BookDiffSnapshot', coin: 'BTC', limit: 2 })
    const trades = await run(exchangeTools, 'hd_order_book', { view: 'trades', limit: 3 }, [
      { match: '/info', json: { result: [] } },
    ])
    expect(trades.calls[0]?.body).toEqual({ type: 'trades', limit: 3 })
  })
})

describe('hd_market_history', () => {
  it('coins forwards kind', async () => {
    const { calls, sc } = await run(
      exchangeTools,
      'hd_market_history',
      { view: 'coins', kind: 'spot' },
      [{ match: '/market/coins', json: apiList([{ coin: '@107', notional_usd: 1 }]) }],
    )
    expect(calls[0]?.url.searchParams.get('kind')).toBe('spot')
    expect(sc.data).toHaveLength(1)
  })

  it('slippage encodes the coin path and window params', async () => {
    const { calls } = await run(
      exchangeTools,
      'hd_market_history',
      {
        view: 'slippage',
        coin: '@307',
        start_time: '2026-10-01T00:00:00Z',
        interval: '1d',
        size_usd: 10000,
      },
      [{ match: '/market/slippage/', json: apiList([]) }],
    )
    const u = calls[0]?.url as URL
    expect(u.pathname).toBe('/market/slippage/%40307')
    expect(u.searchParams.get('start_time')).toBe('2026-10-01T00:00:00.000Z')
    expect(u.searchParams.get('interval')).toBe('1d')
    expect(u.searchParams.get('size_usd')).toBe('10000')
  })

  it('book requires at; liquidity_report maps to its path', async () => {
    const bad = await run(exchangeTools, 'hd_market_history', { view: 'book', coin: 'BTC' }, [])
    expect(bad.res.isError).toBe(true)
    const book = await run(
      exchangeTools,
      'hd_market_history',
      { view: 'book', coin: 'BTC', at: '2026-10-20T12:00:00Z', levels: 2, source: 'snapshot' },
      [{ match: '/market/book/', json: apiSingle({ coin: 'BTC', bids: [] }) }],
    )
    expect(book.calls[0]?.url.searchParams.get('levels')).toBe('2')
    expect(book.calls[0]?.url.searchParams.get('source')).toBe('snapshot')
    expect(book.sc.data).toEqual({ coin: 'BTC', bids: [] })

    const rep = await run(
      exchangeTools,
      'hd_market_history',
      { view: 'liquidity_report', coin: 'SOL', start_time: '2025-09-01T00:00:00Z', period: 'week' },
      [{ match: '/market/liquidity-report/', json: apiSingle({ periods: [] }) }],
    )
    expect(rep.calls[0]?.url.pathname).toBe('/market/liquidity-report/SOL')
    expect(rep.calls[0]?.url.searchParams.get('period')).toBe('week')
  })
})

describe('hd_spot_meta', () => {
  const meta = {
    universe: [
      { name: '@307', index: 307, tokens: [452, 0], isCanonical: false },
      { name: 'PURR/USDC', index: 0, tokens: [1, 0], isCanonical: true },
    ],
    tokens: [
      { name: 'USDC', index: 0 },
      { name: 'PURR', index: 1 },
      { name: 'HTAO', index: 452, fullName: 'Hyper TAO' },
    ],
  }

  it('resolveSpot maps a handle, a pair name and a token name', () => {
    expect(resolveSpot(meta, '@307')[0]?.label).toBe('HTAO/USDC')
    expect(resolveSpot(meta, 'purr/usdc')[0]?.coin).toBe('@0')
    expect(resolveSpot(meta, 'htao')[0]?.coin).toBe('@307')
    expect(resolveSpot(meta, '@999')).toEqual([])
  })

  it('view=resolve calls spotMeta', async () => {
    const { calls, sc } = await run(exchangeTools, 'hd_spot_meta', { query: '@307' }, [
      { match: '/info', json: meta },
    ])
    expect(calls[0]?.body).toEqual({ type: 'spotMeta' })
    expect(sc.data[0].base.name).toBe('HTAO')
  })

  it('view=tokens forwards search and clamps limit to 500', async () => {
    const { calls, sc } = await run(
      exchangeTools,
      'hd_spot_meta',
      { view: 'tokens', search: 'HTAO', limit: 900 },
      [{ match: '/spot/tokens', json: [{ token_index: 452 }] }],
    )
    expect(calls[0]?.url.searchParams.get('search')).toBe('HTAO')
    expect(calls[0]?.url.searchParams.get('limit')).toBe('500')
    expect(sc.data).toHaveLength(1)
  })

  it('auctions_history forwards lookback_hours', async () => {
    const { calls } = await run(
      exchangeTools,
      'hd_spot_meta',
      { view: 'auctions_history', lookback_hours: 72, limit: 5 },
      [{ match: '/spot/auctions/hist', json: [] }],
    )
    expect(calls[0]?.url.searchParams.get('lookback_hours')).toBe('72')
    expect(calls[0]?.url.searchParams.get('limit')).toBe('5')
  })
})

describe('hd_account_state', () => {
  it('clearinghouse accepts users[] and dex', async () => {
    const { calls } = await run(
      accountTools,
      'hd_account_state',
      { view: 'clearinghouse', users: [A, B], dex: 'xyz' },
      [{ match: '/info', json: { [A]: {}, [B]: {} } }],
    )
    expect(calls[0]?.body).toEqual({ type: 'clearinghouseState', users: [A, B], dex: 'xyz' })
  })

  it('requires user, coin and builder where the type needs them', async () => {
    expect((await run(accountTools, 'hd_account_state', { view: 'fees' }, [])).res.isError).toBe(
      true,
    )
    expect(
      (await run(accountTools, 'hd_account_state', { view: 'active_asset', user: A }, [])).res
        .isError,
    ).toBe(true)
    const fee = await run(
      accountTools,
      'hd_account_state',
      { view: 'max_builder_fee', user: A, builder: B },
      [{ match: '/info', json: 100 }],
    )
    expect(fee.calls[0]?.body).toEqual({ type: 'maxBuilderFee', user: A, builder: B })
    expect(fee.sc.data).toBe(100)
  })

  it('drops dex on views that do not take it', async () => {
    const { calls } = await run(
      accountTools,
      'hd_account_state',
      { view: 'role', user: A, dex: 'xyz' },
      [{ match: '/info', json: { role: 'user' } }],
    )
    expect(calls[0]?.body).toEqual({ type: 'userRole', user: A })
  })
})

describe('hd_account_history', () => {
  it('orders window mode pages through the X-Next-Cursor header', async () => {
    const { calls, sc } = await run(
      accountTools,
      'hd_account_history',
      { view: 'orders', user: A, start_time: '1', end_time: '2', limit: 2, cursor: '9' },
      [
        {
          match: '/info',
          json: [{ order: { oid: 8 } }, { order: { oid: 7 } }],
          headers: { 'x-has-more': 'true', 'x-next-cursor': '7' },
        },
      ],
    )
    expect(calls[0]?.body).toEqual({
      type: 'historicalOrders',
      user: A,
      startTime: 1,
      endTime: 2,
      limit: 2,
      cursor: '9',
    })
    expect(sc.pagination).toMatchObject({ has_more: true, next_cursor: '7' })
  })

  it('order_status requires oid', async () => {
    expect(
      (await run(accountTools, 'hd_account_history', { view: 'order_status', user: A }, [])).res
        .isError,
    ).toBe(true)
    const ok = await run(
      accountTools,
      'hd_account_history',
      { view: 'order_status', user: A, oid: 5 },
      [{ match: '/info', json: { status: 'unknownOid' } }],
    )
    expect(ok.calls[0]?.body).toEqual({ type: 'orderStatus', user: A, oid: 5 })
  })

  it('ledger holds back the oldest instant of a full page', async () => {
    const rows = [
      { time: 30, delta: {} },
      { time: 20, delta: {} },
      { time: 10, delta: {} },
    ]
    const { calls, sc } = await run(
      accountTools,
      'hd_account_history',
      { view: 'ledger', user: A, limit: 3 },
      [{ match: '/info', json: rows }],
    )
    expect(calls[0]?.body).toEqual({ type: 'userNonFundingLedgerUpdates', user: A, limit: 3 })
    expect(sc.data).toHaveLength(2)
    expect(sc.pagination).toMatchObject({ has_more: true, next_end_time: 10 })
  })

  it('twap_slice_fills reads fill.time and forwards twapId', async () => {
    const rows = [
      { fill: { time: 50 }, twapId: 1 },
      { fill: { time: 40 }, twapId: 1 },
    ]
    const { calls, sc } = await run(
      accountTools,
      'hd_account_history',
      { view: 'twap_slice_fills', user: A, twap_id: 1, limit: 2 },
      [{ match: '/info', json: rows }],
    )
    expect(calls[0]?.body).toMatchObject({ type: 'userTwapSliceFills', twapId: 1, limit: 2 })
    expect(sc.pagination.next_end_time).toBe(40)
    expect(sc.data).toHaveLength(1)
  })
})
