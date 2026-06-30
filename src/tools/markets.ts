import type { Query } from '../hypedexer/client.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { addressSchema, viewSchema } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Market-wide overview metrics (HypeDexer Data API, `/overview/*`).
 *
 * These are aggregate, exchange-level views (24h headline stats, 10-day daily
 * series, per-user coin breakdown) — distinct from the per-trade `fills` tools.
 * All endpoints use the APIResponse envelope.
 */
export const marketsTools: ToolModule = [
  defineTool({
    name: 'hd_market_snapshot_24h',
    group: 'markets',
    title: 'Hyperliquid 24h market snapshot',
    description:
      'One merged trailing-24h snapshot of the whole exchange. Fans out to five ' +
      '/overview endpoints in parallel and returns a single object with: ' +
      'total_fees (spot/perp/total fee USD), volume_24h ({value, variationPct}), ' +
      'total_fills ({value, variationPct}), active_traders ({value, variationPct}), ' +
      'and top_traders (an array of the best 24h traders by user, with tradeCount, ' +
      'totalVolume, winRate, totalPnl). Use this for a fast "state of the market" ' +
      'read instead of calling each metric separately. Note: active_traders, ' +
      'volume_24h, and total_fills are computed server-side and are slower ' +
      '(~2-8s, server-cached); fees and top_traders return quickly. No inputs.',
    inputSchema: {},
    async handler(_args, ctx) {
      const hd = requireHd(ctx)
      const [fees, volume, fills, activeTraders, topTraders] = await Promise.all([
        hd.getApiSingle<unknown>('/overview/total-fees-24h'),
        hd.getApiSingle<unknown>('/overview/trading-volume-24h'),
        hd.getApiSingle<unknown>('/overview/total-fills-24h'),
        hd.getApiSingle<unknown>('/overview/active-traders-24h'),
        hd.getApiList<unknown>('/overview/top-traders-24h'),
      ])
      return rawResult(
        {
          total_fees: fees.data,
          volume_24h: volume.data,
          total_fills: fills.data,
          active_traders: activeTraders.data,
          top_traders: topTraders.data,
        },
        'Trailing-24h market snapshot (fees, volume, fills, active + top traders).',
      )
    },
  }),

  defineTool({
    name: 'hd_market_daily_series',
    group: 'markets',
    title: 'Hyperliquid 10-day daily series',
    description:
      'Last 10 days of daily aggregates. view="volume" (default) returns one row per ' +
      'day ({date, volume}) — pass an optional `user` to scope volume to a single ' +
      'trader, omit it for the whole exchange. view="pnl" returns global daily realized ' +
      'PnL broken down by coin ({date, coin, pnl}); PnL is global-only and ignores `user`. ' +
      'Returns the full window in one call (no pagination).',
    inputSchema: {
      view: viewSchema(
        ['volume', 'pnl'],
        'volume = daily trading volume (supports optional `user`); pnl = global daily PnL by coin.',
        'volume',
      ),
      user: addressSchema
        .optional()
        .describe(
          'Only for view="volume": scope the series to one trader. Ignored for view="pnl".',
        ),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const path = args.view === 'pnl' ? '/overview/daily-pnl-10d' : '/overview/daily-volume-10d'
      const query: Query = {}
      if (args.view === 'volume' && args.user !== undefined) query.user = args.user

      const page = await hd.getApiList<unknown>(path, query)
      const meta: Record<string, unknown> = { view: args.view, source: path }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs

      return buildResult(
        { data: page.data, meta },
        {
          summary:
            args.view === 'pnl'
              ? 'Global daily PnL (10d) by coin.'
              : `Daily volume (10d)${args.user ? ` for ${args.user}` : ''}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_user_coin_distribution',
    group: 'markets',
    title: 'Trader coin distribution',
    description:
      "A single trader's all-time activity split by coin: one row per asset with " +
      '{coin, volume, fills}, sorted by volume. Requires a wallet `user`. ' +
      'Caveat: an unknown or mistyped address returns HTTP 200 with an empty array ' +
      '(not a 422), so an empty result usually means the address has no history — ' +
      'or was typed wrong. Returns the full breakdown in one call (no pagination).',
    inputSchema: {
      user: addressSchema.describe('Wallet address to break down by coin (required).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { user: args.user }
      const page = await hd.getApiList<unknown>('/overview/coin-distribution', query)

      const meta: Record<string, unknown> = {
        user: args.user,
        source: '/overview/coin-distribution',
      }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs

      const notes: string[] = []
      if (page.data.length === 0) {
        notes.push(
          'Empty result. This endpoint returns 200 with an empty array for unknown or mistyped ' +
            'addresses (no 422 is raised), so double-check the address is correct.',
        )
      }

      return buildResult(
        { data: page.data, meta, notes },
        {
          summary: `Coin distribution for ${args.user}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
