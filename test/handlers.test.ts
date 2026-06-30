import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { HypedexerClient } from '../src/hypedexer/client.js'
import { HyperliquidPublicClient } from '../src/hyperliquid/public-client.js'
import { createLogger } from '../src/logger.js'
import type { ToolContext } from '../src/tools/context.js'
import { fillsTools } from '../src/tools/fills.js'
import type { AnyToolDef } from '../src/tools/types.js'
import { apiList, mockFetch } from './fixtures.js'

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
})
