import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { HyperliquidPublicClient } from '../src/hyperliquid/public-client.js'
import { createLogger } from '../src/logger.js'
import type { ToolContext } from '../src/tools/context.js'
import { publicTools } from '../src/tools/public.js'

/**
 * Live keyless tests against api.hyperliquid.xyz. Skipped by default; run with
 * HYPEDEXER_MCP_LIVE=1 (e.g. `pnpm test:live`).
 */
const live = process.env.HYPEDEXER_MCP_LIVE === '1'

function ctx(): ToolContext {
  return {
    hd: null,
    hl: new HyperliquidPublicClient(),
    config: loadConfig({}),
    logger: createLogger('silent'),
  }
}

describe.runIf(live)('public tools (live)', () => {
  it('hl_public_all_mids returns a BTC price', async () => {
    const t = publicTools.find((d) => d.name === 'hl_public_all_mids')!
    const res = await t.handler({}, ctx())
    const data = (res.structuredContent as Record<string, any>).data
    expect(typeof data.BTC).toBe('string')
    expect(Number(data.BTC)).toBeGreaterThan(0)
  })

  it('hl_public_perp_meta returns a non-empty universe', async () => {
    const t = publicTools.find((d) => d.name === 'hl_public_perp_meta')!
    const res = await t.handler({ view: 'universe' }, ctx())
    const data = (res.structuredContent as Record<string, any>).data
    expect(Array.isArray(data.universe)).toBe(true)
    expect(data.universe.length).toBeGreaterThan(0)
  })

  it('hl_public_l2_book returns levels for BTC', async () => {
    const t = publicTools.find((d) => d.name === 'hl_public_l2_book')!
    const res = await t.handler({ coin: 'BTC' }, ctx())
    const data = (res.structuredContent as Record<string, any>).data
    expect(Array.isArray(data.levels)).toBe(true)
  })
})
