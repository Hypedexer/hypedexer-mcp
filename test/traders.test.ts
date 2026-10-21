import { describe, expect, it } from 'vitest'
import { tradersTools } from '../src/tools/traders.js'
import { apiList, apiSingle } from './fixtures.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`
const B = `0x${'b'.repeat(40)}`

describe('hd_user_profile views', () => {
  it('performance forwards window', async () => {
    const { calls } = await run(
      tradersTools,
      'hd_user_profile',
      { user: A, view: 'performance', window: 'all' },
      [{ match: '/performance', json: apiSingle({ window: 'all' }) }],
    )
    expect(calls[0]?.url.pathname).toBe(`/users/${A}/performance`)
    expect(calls[0]?.url.searchParams.get('window')).toBe('all')
  })

  it('equity_history forwards window and interval', async () => {
    const { calls, sc } = await run(
      tradersTools,
      'hd_user_profile',
      { user: A, view: 'equity_history', window: '30d', interval: '1d' },
      [{ match: '/equity-history', json: apiSingle({ summary: { points: 2 } }) }],
    )
    expect(calls[0]?.url.pathname).toBe(`/users/${A}/equity-history`)
    expect(calls[0]?.url.searchParams.get('interval')).toBe('1d')
    expect(sc.data.summary.points).toBe(2)
  })

  it('top_trades forwards sort, limit, include_open and window', async () => {
    const { calls } = await run(
      tradersTools,
      'hd_user_profile',
      { user: A, view: 'top_trades', sort: 'loss', limit: 3, include_open: false, window: '90d' },
      [{ match: '/top-trades', json: apiSingle({ trades: [] }) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('sort')).toBe('loss')
    expect(q?.get('limit')).toBe('3')
    expect(q?.get('include_open')).toBe('false')
    expect(q?.get('window')).toBe('90d')
  })

  it('account and pnl_calendar hit their paths; account ignores window', async () => {
    const acc = await run(
      tradersTools,
      'hd_user_profile',
      { user: A, view: 'account', window: '7d' },
      [{ match: '/account', json: apiSingle({ account_value: 1 }) }],
    )
    expect(acc.calls[0]?.url.pathname).toBe(`/users/${A}/account`)
    expect(acc.calls[0]?.url.searchParams.has('window')).toBe(false)
    const cal = await run(tradersTools, 'hd_user_profile', { user: A, view: 'pnl_calendar' }, [
      { match: '/pnl-calendar', json: apiSingle({ days: [] }) },
    ])
    expect(cal.calls[0]?.url.pathname).toBe(`/users/${A}/pnl-calendar`)
  })
})

describe('hd_users_batch_performance', () => {
  it('posts users, window and include_drawdown', async () => {
    const { calls, sc } = await run(
      tradersTools,
      'hd_users_batch_performance',
      { users: [A, B], window: '30d', include_drawdown: true },
      [{ match: '/users/batch/performance', json: apiList([{ user: A }, { user: B }]) }],
    )
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ users: [A, B], window: '30d', include_drawdown: true })
    expect(sc.data).toHaveLength(2)
  })

  it('rejects more than 500 wallets', async () => {
    const { res } = await run(
      tradersTools,
      'hd_users_batch_performance',
      { users: Array.from({ length: 501 }, () => A) },
      [],
    )
    expect(res.isError).toBe(true)
  })
})

describe('hd_traders_leaderboard', () => {
  it('window mode forwards page/min_trades and surfaces next_page', async () => {
    const { calls, sc } = await run(
      tradersTools,
      'hd_traders_leaderboard',
      { by: 'win_rate', window: '30d', page: 1, min_trades: 20, limit: 500, hours: 5 },
      [
        {
          match: '/users/leaderboard',
          json: apiList([{ rank: 1 }], { total_count: 339270, next_cursor: '2', has_more: true }),
        },
      ],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('window')).toBe('30d')
    expect(q?.get('page')).toBe('1')
    expect(q?.get('min_trades')).toBe('20')
    expect(q?.get('limit')).toBe('500')
    expect(q?.has('hours')).toBe(false)
    expect(sc.pagination.next_page).toBe(2)
    expect(sc.meta.total_count).toBe(339270)
  })

  it('live mode omits by when not given and caps limit at 100', async () => {
    const { calls, sc } = await run(tradersTools, 'hd_traders_leaderboard', { limit: 300 }, [
      { match: '/users/leaderboard', json: apiList([{ user: A }]) },
    ])
    expect(calls[0]?.url.searchParams.has('by')).toBe(false)
    expect(calls[0]?.url.searchParams.get('limit')).toBe('100')
    expect(sc.pagination.next_page).toBeUndefined()
  })
})

describe('no fake offset paging', () => {
  it('hd_traders_active and hd_user_coins send no offset', async () => {
    const active = await run(tradersTools, 'hd_traders_active', { limit: 2, offset: 5 }, [
      { match: '/users/active', json: apiList([{ user: A }, { user: B }]) },
    ])
    expect(active.calls[0]?.url.searchParams.has('offset')).toBe(false)
    expect(active.sc.pagination).toBeUndefined()
    const coins = await run(tradersTools, 'hd_user_coins', { user: A, limit: 1 }, [
      { match: '/coins', json: apiList([{ coin: 'ETH' }]) },
    ])
    expect(coins.calls[0]?.url.searchParams.has('offset')).toBe(false)
  })
})

describe('hd_completed_trades_search filters', () => {
  it('list forwards user, direction, pnl bounds and sort_dir', async () => {
    const { calls } = await run(
      tradersTools,
      'hd_completed_trades_search',
      {
        user: A,
        direction: 'short',
        min_pnl: 1000,
        max_pnl: 2000,
        sort_by: 'pnl_realized',
        sort_dir: 'ASC',
      },
      [{ match: '/completed-trades/', json: apiList([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('user')).toBe(A)
    expect(q?.get('direction')).toBe('short')
    expect(q?.get('min_pnl')).toBe('1000')
    expect(q?.get('max_pnl')).toBe('2000')
    expect(q?.get('sort_dir')).toBe('ASC')
  })

  it('summary forwards user and direction but not list-only params', async () => {
    const { calls } = await run(
      tradersTools,
      'hd_completed_trades_search',
      { view: 'summary', user: A, direction: 'long', min_pnl: 5 },
      [{ match: '/completed-trades/summary', json: apiSingle({ total_trades: 1 }) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('user')).toBe(A)
    expect(q?.get('direction')).toBe('long')
    expect(q?.has('min_pnl')).toBe(false)
  })
})
