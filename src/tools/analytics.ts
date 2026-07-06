import type { Query } from '../hypedexer/client.js'
import { renameGossipAddress } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { buildTimeQuery } from './shared/pagination.js'
import {
  coinSchema,
  endTimeSchema,
  limitSchema,
  startTimeSchema,
  viewSchema,
  z,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Network-wide analytics aggregates (HypeDexer Data API, APIResponse envelope).
 *
 * These endpoints return precomputed rollups over a lookback window rather than
 * raw rows: fill activity, priority-fee economics, and liquidation totals. They
 * are cheap, single-shot snapshots - none are paginated except the two
 * priority-fee chart/leaderboard list views, which return the full set in one call.
 */
export const analyticsTools: ToolModule = [
  defineTool({
    name: 'hd_analytics_fills_stats',
    group: 'analytics',
    title: 'Hyperliquid fill statistics',
    description:
      'Aggregate fill activity across Hyperliquid over a recent lookback window: total fills, ' +
      'total volume, total fees, builder fees, and counts of unique users and coins, plus the ' +
      'covered time_range. Use it for a one-shot "how busy is the exchange" snapshot rather than ' +
      'fetching individual fills. Set hours (1-168, default 1) to widen the window, and coin to ' +
      'scope to a single asset (the coin is echoed back in the result). Returns a single object.',
    inputSchema: {
      coin: coinSchema.optional().describe('Scope stats to one asset; echoed back in the result.'),
      hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .describe('Lookback window in hours (1-168, default 1).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = {}
      if (args.coin !== undefined) query.coin = args.coin
      if (args.hours !== undefined) query.hours = args.hours
      const { data } = await hd.getApiSingle<unknown>('/analytics/fills/stats', query)
      return rawResult(data, `Fill stats${args.coin ? ` for ${args.coin}` : ''}.`)
    },
  }),

  defineTool({
    name: 'hd_analytics_priority_fees',
    group: 'analytics',
    title: 'Hyperliquid priority-fee analytics',
    description:
      'Priority-fee (gas tip) economics, in three views selected by `view`:\n' +
      '- "stats" (default): a single rollup over a recent window - fills paying priority, total/avg/min/max ' +
      'priority gas, and unique payers. Set hours (1-168, default 1).\n' +
      '- "daily": a time series of per-day priority-fee totals (fills, fillsWithFee, totalGas, uniqueUsers). ' +
      'Defaults to a ~29-day lookback; narrow it with start_time/end_time. Returned as a list.\n' +
      '- "leaderboard": top gossip nodes ranked by priority gas contributed (totalGas, count, daysActive). ' +
      'Each row is keyed by node, not by wallet - the node IPv4 is surfaced as `nodeIp`. Use limit (1-200) to cap rows.\n' +
      'These views return everything in one call (no pagination).',
    inputSchema: {
      view: viewSchema(
        ['stats', 'daily', 'leaderboard'],
        'stats = single rollup; daily = per-day time series; leaderboard = top gossip nodes by priority gas.',
        'stats',
      ),
      hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .describe('view="stats" only: lookback window in hours (1-168, default 1).'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(200),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)

      if (args.view === 'stats') {
        const query: Query = {}
        if (args.hours !== undefined) query.hours = args.hours
        const { data } = await hd.getApiSingle<unknown>('/analytics/priority-fees/stats', query)
        return rawResult(data, 'Priority-fee stats (network-wide).')
      }

      if (args.view === 'daily') {
        const query = buildTimeQuery(
          {},
          {
            start: args.start_time,
            end: args.end_time,
            target: 'isoSnake',
            startKey: 'start_time',
            endKey: 'end_time',
          },
        )
        const page = await hd.getApiList<unknown>('/analytics/priority-fees/chart/daily', query)
        const meta: Record<string, unknown> = { source: '/analytics/priority-fees/chart/daily' }
        if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
        return buildResult(
          { data: page.data, meta },
          {
            summary: 'Daily priority-fee chart (~29-day default lookback).',
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }

      // view === 'leaderboard'
      const query: Query = { limit: args.limit }
      const page = await hd.getApiList<Record<string, unknown>>(
        '/analytics/priority-fees/gossip/leaderboard',
        query,
      )
      const rows = page.data.map((row) => renameGossipAddress(row))
      const meta: Record<string, unknown> = {
        source: '/analytics/priority-fees/gossip/leaderboard',
      }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
      return buildResult(
        {
          data: rows,
          meta,
          notes: [
            'Most rows are gossip nodes whose IPv4 address is surfaced as `nodeIp` (renamed from upstream `address`). A minority of rows are keyed by a wallet `address` instead (non-IPv4) and are left as-is; treat `nodeIp` as a node IP, never a wallet.',
          ],
        },
        {
          summary: 'Gossip priority-fee leaderboard by node.',
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_analytics_liquidations_stats',
    group: 'analytics',
    title: 'Hyperliquid liquidation statistics',
    description:
      'Aggregate liquidation totals over a recent lookback window: number of liquidations (and the ' +
      'long/short split), total USD liquidated, total fees, the most-liquidated token, and the covered ' +
      'time_range. Use it for a quick risk/deleveraging snapshot. Set days (1-30, default 1) to widen the ' +
      'window, and coin to scope counts/amounts to one asset. Quirk: top_token_liquidated is computed ' +
      'market-wide and ignores the coin filter. Returns a single object.',
    inputSchema: {
      coin: coinSchema
        .optional()
        .describe(
          'Scope counts/amounts to one asset. Note: top_token_liquidated ignores this filter.',
        ),
      days: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe('Lookback window in days (1-30, default 1).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = {}
      if (args.coin !== undefined) query.coin = args.coin
      if (args.days !== undefined) query.days = args.days
      const { data } = await hd.getApiSingle<unknown>('/analytics/liquidations/stats', query)
      const caveat = args.coin
        ? ' Note: top_token_liquidated ignores the coin filter (it is market-wide).'
        : ''
      return rawResult(data, `Liquidation stats${args.coin ? ` for ${args.coin}` : ''}.${caveat}`)
    },
  }),
]
