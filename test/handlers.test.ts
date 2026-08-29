import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { HypedexerClient } from '../src/hypedexer/client.js'
import { HyperliquidPublicClient } from '../src/hyperliquid/public-client.js'
import { createLogger } from '../src/logger.js'
import type { ToolContext } from '../src/tools/context.js'
import { fillsTools } from '../src/tools/fills.js'
import { hip4Tools } from '../src/tools/hip4.js'
import type { AnyToolDef } from '../src/tools/types.js'
import { apiList, hip4, mockFetch } from './fixtures.js'

function ctxWith(fetchImpl: typeof fetch): ToolContext {
  return {
    hd: new HypedexerClient({ apiKey: 'k', fetch: fetchImpl }),
    hl: new HyperliquidPublicClient({ fetch: fetchImpl }),
    config: loadConfig({ HYPEDEXER_API_KEY: 'k' }),
    logger: createLogger('silent'),
  }
}

function tool(mod: AnyToolDef[], name: string): AnyToolDef {
  const t = mod.find((d) => d.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

describe('hd_fills_search handler (real module, mocked fetch)', () => {
  it('perp scope: cursor-paginates and surfaces next_cursor', async () => {
    const ctx = ctxWith(
      mockFetch([
        {
          match: '/fills/',
          json: apiList([{ tid: '1' }, { tid: '2' }], { next_cursor: '99:x', has_more: true }),
        },
      ]),
    )
    const res = await tool(fillsTools, 'hd_fills_search').handler(
      { scope: 'perp', recent: false, limit: 50, offset: 0 },
      ctx,
    )
    const sc = res.structuredContent as Record<string, any>
    expect(sc.data).toHaveLength(2)
    expect(sc.pagination.next_cursor).toBe('99:x')
    expect(sc.pagination.has_more).toBe(true)
    expect(res.isError).toBeUndefined()
  })

  it('spot scope: offset-paginates and drops a page-size-as-total quirk', async () => {
    const ctx = ctxWith(
      mockFetch([
        { match: '/fills/spot/', json: apiList([{ a: 1 }, { a: 2 }], { total_count: 2 }) },
      ]),
    )
    const res = await tool(fillsTools, 'hd_fills_search').handler(
      { scope: 'spot', recent: false, limit: 2, offset: 0 },
      ctx,
    )
    const sc = res.structuredContent as Record<string, any>
    expect(sc.data).toHaveLength(2)
    // total_count equals page size (2) -> sanitized away
    expect(sc.meta.total_count).toBeUndefined()
    // full page of 2 with limit 2 -> more may exist
    expect(sc.pagination.next_offset).toBe(2)
  })

  it('routes a user-scoped perp query to /fills/user/{address}', async () => {
    let seen = ''
    const fetchImpl = mockFetch([{ match: '/fills/user/', json: apiList([]) }])
    const spy: typeof fetch = (input, init) => {
      seen = typeof input === 'string' ? input : (input as URL).toString()
      return fetchImpl(input, init)
    }
    const ctx = ctxWith(spy)
    await tool(fillsTools, 'hd_fills_search').handler(
      { scope: 'perp', recent: false, limit: 50, offset: 0, address: `0x${'a'.repeat(40)}` },
      ctx,
    )
    expect(seen).toContain(`/fills/user/0x${'a'.repeat(40)}`)
  })

  it('sends include_order_type on perp only, and notes it on spot', async () => {
    const seen: string[] = []
    const fetchImpl = mockFetch([
      { match: '/fills/', json: apiList([{ tid: '1', orderType: 'Limit' }]) },
      { match: '/fills/spot/', json: apiList([{ tid: '2' }]) },
    ])
    const spy: typeof fetch = (input, init) => {
      seen.push(typeof input === 'string' ? input : (input as URL).toString())
      return fetchImpl(input, init)
    }
    const ctx = ctxWith(spy)
    const perp = await tool(fillsTools, 'hd_fills_search').handler(
      { scope: 'perp', recent: false, limit: 50, offset: 0, include_order_type: true },
      ctx,
    )
    expect(seen[0]).toContain('include_order_type=true')
    expect((perp.structuredContent as Record<string, any>).data[0].orderType).toBe('Limit')

    const spot = await tool(fillsTools, 'hd_fills_search').handler(
      { scope: 'spot', recent: false, limit: 50, offset: 0, include_order_type: true },
      ctx,
    )
    expect(seen[1]).not.toContain('include_order_type')
    expect((spot.structuredContent as Record<string, any>).notes.join(' ')).toContain('perp-only')
  })
})

describe('HIP-4 attribution handlers (real module, mocked fetch)', () => {
  it('hd_hip4_providers passes venue and a full ISO window', async () => {
    let seen = ''
    const fetchImpl = mockFetch([
      { match: '/hip4/providers', json: hip4([{ provider: 'out', volume_usdc: 1 }]) },
    ])
    const spy: typeof fetch = (input, init) => {
      seen = typeof input === 'string' ? input : (input as URL).toString()
      return fetchImpl(input, init)
    }
    const res = await tool(hip4Tools, 'hd_hip4_providers').handler(
      { venue: 'out', start_time: '2026-08-22T09:30:00Z', limit: 50, offset: 0 },
      ctxWith(spy),
    )
    expect(seen).toContain('venue=out')
    expect(seen).toContain('start=2026-08-22T09%3A30%3A00.000Z')
    expect((res.structuredContent as Record<string, any>).data).toHaveLength(1)
  })

  it('hd_hip4_deployers decodes the sub_deployers delegation string', async () => {
    const subDeployers = JSON.stringify([
      ['settleOutcome', ['0xf1923927d7d2847191fb7ef8b1a16028aa5ae754']],
      ['registerQuestionFromTemplate', ['0xf1923927d7d2847191fb7ef8b1a16028aa5ae754']],
    ])
    const ctx = ctxWith(
      mockFetch([
        {
          match: '/hip4/deployers',
          json: hip4([
            { deployer: '0xabc', venue: 'out', fee_scale: 1, sub_deployers: subDeployers },
          ]),
        },
      ]),
    )
    const res = await tool(hip4Tools, 'hd_hip4_deployers').handler({ limit: 50, offset: 0 }, ctx)
    const row = (res.structuredContent as Record<string, any>).data[0]
    expect(row.delegations).toEqual([
      { action: 'settleOutcome', addresses: ['0xf1923927d7d2847191fb7ef8b1a16028aa5ae754'] },
      {
        action: 'registerQuestionFromTemplate',
        addresses: ['0xf1923927d7d2847191fb7ef8b1a16028aa5ae754'],
      },
    ])
    // the raw upstream string stays untouched
    expect(row.sub_deployers).toBe(subDeployers)
  })

  it('hd_hip4_deployers leaves an unparseable delegation string alone', async () => {
    const ctx = ctxWith(
      mockFetch([
        {
          match: '/hip4/deployers',
          json: hip4([{ deployer: '0xabc', sub_deployers: 'not json' }]),
        },
      ]),
    )
    const res = await tool(hip4Tools, 'hd_hip4_deployers').handler({ limit: 50, offset: 0 }, ctx)
    const row = (res.structuredContent as Record<string, any>).data[0]
    expect(row.delegations).toBeUndefined()
    expect(row.sub_deployers).toBe('not json')
  })

  it('hd_hip4_fills forwards the user / coin / outcome_id filters', async () => {
    let seen = ''
    const fetchImpl = mockFetch([{ match: '/hip4/fills', json: hip4([{ tid: 1 }]) }])
    const spy: typeof fetch = (input, init) => {
      seen = typeof input === 'string' ? input : (input as URL).toString()
      return fetchImpl(input, init)
    }
    await tool(hip4Tools, 'hd_hip4_fills').handler(
      { user: `0x${'a'.repeat(40)}`, coin: '#12100', outcome_id: 12100, limit: 50, offset: 0 },
      ctxWith(spy),
    )
    expect(seen).toContain(`user=0x${'a'.repeat(40)}`)
    expect(seen).toContain('coin=%2312100')
    expect(seen).toContain('outcome_id=12100')
  })
})
