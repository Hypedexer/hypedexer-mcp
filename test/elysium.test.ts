import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { HypedexerClient } from '../src/hypedexer/client.js'
import { HyperliquidPublicClient } from '../src/hyperliquid/public-client.js'
import { createLogger } from '../src/logger.js'
import type { ToolContext } from '../src/tools/context.js'
import { elysiumTools } from '../src/tools/elysium.js'
import type { AnyToolDef } from '../src/tools/types.js'
import { apiList, apiSingle, mockFetch } from './fixtures.js'

const ADDRESS = `0x${'a'.repeat(40)}`
const HASH = `0x${'b'.repeat(64)}`

/** Records every URL the tool requested, answering each with `body`. */
function recorder(body: unknown) {
  const seen: URL[] = []
  const inner = mockFetch([{ match: /./, json: body }])
  const fetchImpl: typeof fetch = (input, init) => {
    seen.push(new URL(typeof input === 'string' ? input : (input as URL).toString()))
    return inner(input, init)
  }
  const ctx: ToolContext = {
    hd: new HypedexerClient({ apiKey: 'k', fetch: fetchImpl }),
    hl: new HyperliquidPublicClient({ fetch: fetchImpl }),
    config: loadConfig({ HYPEDEXER_API_KEY: 'k' }),
    logger: createLogger('silent'),
  }
  return { ctx, seen }
}

function tool(name: string): AnyToolDef {
  const t = elysiumTools.find((d) => d.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

const page = { limit: 50, offset: 0 }

describe('elysium tools (real module, mocked fetch)', () => {
  it('hd_elysium_stats: current and daily hit their routes', async () => {
    const a = recorder(apiSingle({ total_blocks: 1 }))
    await tool('hd_elysium_stats').handler({ view: 'current', days: 30 }, a.ctx)
    expect(a.seen[0]?.pathname).toBe('/elysium/testnet/stats')

    const b = recorder(apiList([{ day: '2026-09-29' }]))
    const res = await tool('hd_elysium_stats').handler({ view: 'daily', days: 7 }, b.ctx)
    expect(b.seen[0]?.pathname).toBe('/elysium/testnet/stats/daily')
    expect(b.seen[0]?.searchParams.get('days')).toBe('7')
    expect(res.isError).toBeUndefined()
  })

  it('hd_elysium_blocks: list, single and per-block transactions', async () => {
    const list = recorder(apiList([{ block_number: 1 }]))
    await tool('hd_elysium_blocks').handler(
      { transactions: false, start_block: 5, start_time: '2026-09-20T00:00:00Z', ...page },
      list.ctx,
    )
    expect(list.seen[0]?.pathname).toBe('/elysium/testnet/blocks')
    expect(list.seen[0]?.searchParams.get('start_block')).toBe('5')
    expect(list.seen[0]?.searchParams.get('start_time')).toContain('2026-09-20T00:00:00')

    const one = recorder(apiSingle({ block_number: 42 }))
    await tool('hd_elysium_blocks').handler(
      { block_number: 42, transactions: false, ...page },
      one.ctx,
    )
    expect(one.seen[0]?.pathname).toBe('/elysium/testnet/blocks/42')

    const txs = recorder(apiList([{ tx_hash: HASH }]))
    await tool('hd_elysium_blocks').handler(
      { block_number: 42, transactions: true, ...page },
      txs.ctx,
    )
    expect(txs.seen[0]?.pathname).toBe('/elysium/testnet/blocks/42/transactions')
  })

  it('hd_elysium_transactions: detail by hash, feed with filters', async () => {
    const one = recorder(apiSingle({ tx_hash: HASH, logs: [], token_transfers: [] }))
    await tool('hd_elysium_transactions').handler({ tx_hash: HASH, ...page }, one.ctx)
    expect(one.seen[0]?.pathname).toBe(`/elysium/testnet/transactions/${HASH}`)

    const feed = recorder(apiList([{ tx_hash: HASH }]))
    await tool('hd_elysium_transactions').handler(
      {
        from_addr: ADDRESS,
        method_id: '0xa9059cbb',
        include_spam: false,
        include_system: false,
        ...page,
      },
      feed.ctx,
    )
    const q = feed.seen[0]?.searchParams
    expect(feed.seen[0]?.pathname).toBe('/elysium/testnet/transactions')
    expect(q?.get('from_addr')).toBe(ADDRESS)
    expect(q?.get('method_id')).toBe('0xa9059cbb')
    expect(q?.get('include_spam')).toBe('false')
    expect(q?.get('include_system')).toBe('false')
  })

  it('hd_elysium_bridge: track returns every transfer of a hash', async () => {
    const r = recorder(apiList([{ transfer_id: 'w:1' }, { transfer_id: 'd:2' }]))
    const res = await tool('hd_elysium_bridge').handler(
      { view: 'track', tx_hash: HASH, ...page },
      r.ctx,
    )
    expect(r.seen[0]?.pathname).toBe(`/elysium/testnet/bridge/transfers/${HASH}`)
    expect((res.structuredContent as { data: unknown[] }).data).toHaveLength(2)
  })

  it('hd_elysium_bridge: track without a hash steers instead of calling', async () => {
    const r = recorder(apiList([]))
    const res = await tool('hd_elysium_bridge').handler({ view: 'track', ...page }, r.ctx)
    expect(res.isError).toBe(true)
    expect(r.seen).toHaveLength(0)
  })

  it('hd_elysium_bridge: rejects a status that belongs to another view', async () => {
    const r = recorder(apiList([]))
    const res = await tool('hd_elysium_bridge').handler(
      { view: 'transfers', status: 'pending', ...page },
      r.ctx,
    )
    expect(res.isError).toBe(true)
    expect(r.seen).toHaveLength(0)
  })

  it('hd_elysium_bridge: retryables, tokens and reserves hit their routes', async () => {
    const ret = recorder(apiList([]))
    await tool('hd_elysium_bridge').handler(
      { view: 'retryables', status: 'failed', ...page },
      ret.ctx,
    )
    expect(ret.seen[0]?.pathname).toBe('/elysium/testnet/bridge/retryables')
    expect(ret.seen[0]?.searchParams.get('status')).toBe('failed')

    const tok = recorder(apiList([]))
    await tool('hd_elysium_bridge').handler(
      { view: 'tokens', route: 'canonical', ...page },
      tok.ctx,
    )
    expect(tok.seen[0]?.pathname).toBe('/elysium/testnet/bridge/tokens')

    const res = recorder(apiList([{ backed: true }]))
    const out = await tool('hd_elysium_bridge').handler({ view: 'reserves', ...page }, res.ctx)
    expect(res.seen[0]?.pathname).toBe('/elysium/testnet/bridge/reserves')
    expect(res.seen[0]?.searchParams.has('limit')).toBe(false)
    expect((out.structuredContent as { notes?: string[] }).notes?.[0]).toContain('route')
  })

  it('hd_elysium_tokens: list, detail, holders, transfers', async () => {
    const list = recorder(apiList([]))
    await tool('hd_elysium_tokens').handler(
      { view: 'detail', standard: 'erc20', search: 'HYPE', ...page },
      list.ctx,
    )
    expect(list.seen[0]?.pathname).toBe('/elysium/testnet/tokens')
    expect(list.seen[0]?.searchParams.get('search')).toBe('HYPE')

    const det = recorder(apiSingle({ address: ADDRESS }))
    await tool('hd_elysium_tokens').handler({ address: ADDRESS, view: 'detail', ...page }, det.ctx)
    expect(det.seen[0]?.pathname).toBe(`/elysium/testnet/tokens/${ADDRESS}`)

    const hol = recorder(apiList([]))
    await tool('hd_elysium_tokens').handler({ address: ADDRESS, view: 'holders', ...page }, hol.ctx)
    expect(hol.seen[0]?.pathname).toBe(`/elysium/testnet/tokens/${ADDRESS}/holders`)

    const tr = recorder(apiList([]))
    await tool('hd_elysium_tokens').handler(
      { address: ADDRESS, view: 'transfers', holder: ADDRESS, ...page },
      tr.ctx,
    )
    expect(tr.seen[0]?.pathname).toBe(`/elysium/testnet/tokens/${ADDRESS}/transfers`)
    expect(tr.seen[0]?.searchParams.get('holder')).toBe(ADDRESS)
  })

  it('hd_elysium_user: balances at a block, activity, bridge', async () => {
    const bal = recorder(apiSingle({ address: ADDRESS, tokens: [] }))
    await tool('hd_elysium_user').handler(
      { address: ADDRESS, view: 'balances', block: 100, ...page },
      bal.ctx,
    )
    expect(bal.seen[0]?.pathname).toBe(`/elysium/testnet/user/${ADDRESS}/balances`)
    expect(bal.seen[0]?.searchParams.get('block')).toBe('100')

    const act = recorder(apiList([]))
    await tool('hd_elysium_user').handler({ address: ADDRESS, view: 'activity', ...page }, act.ctx)
    expect(act.seen[0]?.pathname).toBe(`/elysium/testnet/user/${ADDRESS}/activity`)

    const br = recorder(apiList([]))
    await tool('hd_elysium_user').handler(
      { address: ADDRESS, view: 'bridge', direction: 'deposit', ...page },
      br.ctx,
    )
    expect(br.seen[0]?.pathname).toBe(`/elysium/testnet/user/${ADDRESS}/bridge`)
    expect(br.seen[0]?.searchParams.get('direction')).toBe('deposit')
  })
})
