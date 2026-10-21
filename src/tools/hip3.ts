import type { Query } from '../hypedexer/client.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { buildTimeQuery, offsetPagination } from './shared/pagination.js'
import {
  addressSchema,
  coinSchema,
  endTimeSchema,
  limitSchema,
  offsetSchema,
  startTimeSchema,
  viewSchema,
  z,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * HIP-3 builder-deployed perps (HypeDexer Data API).
 *
 * HIP-3 lets third parties deploy their own perp DEXes on Hyperliquid. Each DEX
 * has an id (e.g. "xyz"), a slate of assets whose coins are prefixed with the dex
 * id (e.g. "xyz:CL"), deployment auctions, OHLCV/oracle series, fills, trader
 * stats, and per-user activity. Most of these endpoints use the BARE envelope
 * (the payload IS the array/object) and page by offset.
 *
 * Exception: the priority-fee gossip surfaces (`hd_hip3_gossip`) ship the
 * APIResponse envelope (`{ success, data, ... }`), so those two paths use the
 * API getters - using the bare getters would mis-normalize their wrapped body.
 *
 * `asset_id` is reported as 0 everywhere in HIP-3, so it is neither a useful
 * field nor a useful filter; the relevant identity is `dex_id` + `coin`/`ticker`.
 *
 * Live 2026-10-21: /hip3/fills, /hip3/ohlcv, /hip3/oracle/stats and
 * /hip3/users/{address}/fills take their window as `start`/`end` (ISO);
 * `start_time`/`end_time` are silently ignored there. ohlcv and oracle/stats
 * ignore `offset` (they return the window oldest first), so they page by moving
 * the window, not by offset.
 */

/** Hint for the window-paged series (ohlcv, oracle stats): continue after the last row. */
function windowHint(rows: unknown[], limit: number, timeKey: string): string[] {
  if (rows.length < limit) return []
  const last = rows[rows.length - 1] as Record<string, unknown> | undefined
  const t = last?.[timeKey]
  return [
    `Page is full (${limit} rows). Continue with start_time set just after the last row (${String(t)}); offset is ignored by this endpoint.`,
  ]
}
export const hip3Tools: ToolModule = [
  defineTool({
    name: 'hd_hip3_overview',
    group: 'hip3',
    title: 'HIP-3 ecosystem overview',
    description:
      'One-shot snapshot across all HIP-3 builder-deployed perp DEXes: total DEX/asset counts, ' +
      '24h volume/fees/trades, total open interest, and the current deployment-auction state ' +
      '(active flag, price in HYPE, end time). Use this as the entry point before drilling into a ' +
      'specific DEX with hd_hip3_dexs or its assets with hd_hip3_assets. Returns a single object; no inputs.',
    inputSchema: {},
    async handler(_args, ctx) {
      const hd = requireHd(ctx)
      const { data } = await hd.getBareSingle<unknown>('/hip3/overview')
      return rawResult(data, 'HIP-3 ecosystem overview.')
    },
  }),

  defineTool({
    name: 'hd_hip3_dexs',
    group: 'hip3',
    title: 'HIP-3 deployed DEXes',
    description:
      'Builder-deployed perp DEXes. Omit dex_id to list every DEX (id, name, deployer address, ' +
      'collateral asset, fee share, active-since, staked HYPE); results page with ' +
      'pagination.next_offset. Pass dex_id (e.g. "xyz") to fetch just that DEX as a single object. ' +
      'Use the listing to discover dex ids you then feed to hd_hip3_oracle_stats / hd_hip3_assets / hd_hip3_snapshots.',
    inputSchema: {
      dex_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('A specific DEX id (e.g. "xyz"). Omit to list all DEXes.'),
      offset: offsetSchema,
      limit: limitSchema(500),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.dex_id !== undefined) {
        const { data } = await hd.getBareSingle<unknown>(
          `/hip3/dexs/${encodeURIComponent(args.dex_id)}`,
        )
        return rawResult(data, `HIP-3 DEX ${args.dex_id}.`)
      }
      const query: Query = { limit: args.limit, offset: args.offset }
      const page = await hd.getBareList<unknown>('/hip3/dexs', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      return buildResult(
        { data: page.data, pagination, meta: { source: '/hip3/dexs' } },
        { summary: 'HIP-3 deployed DEXes.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_assets',
    group: 'hip3',
    title: 'HIP-3 assets',
    description:
      'Assets listed on HIP-3 DEXes (ticker, symbol, max leverage, OI cap, halted flag, oracle ' +
      'source, fee share). Omit ticker to list assets across DEXes (offset-paged via ' +
      'pagination.next_offset), optionally filtered by dex_id and/or search (ticker or name, e.g. "TSLA" ' +
      'finds every dex listing TSLA). Pass a prefixed ticker like "xyz:CL" (dex id + ":" + symbol) to ' +
      'fetch one asset as a single object. Note: asset_id is always 0 upstream - identify assets by ticker, not id.',
    inputSchema: {
      ticker: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('A prefixed asset ticker like "xyz:CL". Omit to list all assets.'),
      dex_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('List mode: only this DEX (e.g. "xyz").'),
      search: z.string().trim().min(1).optional().describe('List mode: search by ticker or name.'),
      offset: offsetSchema,
      limit: limitSchema(1000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const assetIdNote =
        'asset_id is always 0 in HIP-3 - identify assets by their prefixed ticker, not by id.'
      if (args.ticker !== undefined) {
        const { data } = await hd.getBareSingle<unknown>(
          `/hip3/assets/${encodeURIComponent(args.ticker)}`,
        )
        return rawResult(data, `HIP-3 asset ${args.ticker}. ${assetIdNote}`)
      }
      const query: Query = { limit: args.limit, offset: args.offset }
      if (args.dex_id !== undefined) query.dex_id = args.dex_id
      if (args.search !== undefined) query.search = args.search
      const page = await hd.getBareList<unknown>('/hip3/assets', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      return buildResult(
        { data: page.data, pagination, meta: { source: '/hip3/assets' }, notes: [assetIdNote] },
        { summary: 'HIP-3 assets.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_auctions',
    group: 'hip3',
    title: 'HIP-3 deployment auctions',
    description:
      'HIP-3 DEX-deployment auctions, selected by view:\n' +
      '- "list" (default): all auctions, offset-paged (pagination.next_offset); filter with status ' +
      '(open|closed|expired).\n' +
      '- "current": the single in-progress auction as an object (no pagination).\n' +
      '- "history": settled auctions, offset-paged; filter with dex_id.\n' +
      'Quirk: on "history", auction_id is a STRING (it is an integer on "list"), and expired rows ' +
      'may carry empty-string dex_id/coin/winner. List/history page with limit + offset.',
    inputSchema: {
      view: viewSchema(
        ['list', 'current', 'history'],
        'list = all auctions; current = the live auction object; history = settled auctions.',
        'list',
      ),
      status: z
        .enum(['open', 'closed', 'expired'])
        .optional()
        .describe('view="list" only: auction status filter.'),
      dex_id: z.string().trim().min(1).optional().describe('view="history" only: one DEX.'),
      offset: offsetSchema,
      limit: limitSchema(500),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'current') {
        const { data } = await hd.getBareSingle<unknown>('/hip3/auctions/current')
        return rawResult(data, 'Current HIP-3 deployment auction.')
      }
      const isHistory = args.view === 'history'
      const cap = isHistory ? 500 : 200
      const limit = Math.min(args.limit, cap)
      const path = isHistory ? '/hip3/auctions/history' : '/hip3/auctions'
      const query: Query = { limit, offset: args.offset }
      if (isHistory && args.dex_id !== undefined) query.dex_id = args.dex_id
      if (!isHistory && args.status !== undefined) query.status = args.status
      const page = await hd.getBareList<unknown>(path, query)
      const pagination = offsetPagination(page, args.offset, limit)
      const notes = isHistory
        ? [
            'On auction history, auction_id is a STRING (vs an integer on the "list" view); ' +
              'expired rows may have empty-string dex_id/coin/winner.',
          ]
        : []
      return buildResult(
        { data: page.data, pagination, meta: { source: path }, notes },
        { summary: `HIP-3 auctions (${args.view}).`, maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_snapshots',
    group: 'hip3',
    title: 'HIP-3 market snapshots',
    description:
      'Live per-coin market snapshots across HIP-3 DEXes (mark/oracle price, funding, open interest, ' +
      '24h volume/fees/trades, halted flag, and the all-time per-coin totals total_volume_cumulative and ' +
      'total_fees_cumulative). view="snapshots" (default) returns the full set, or one DEX / one coin with ' +
      'dex_id / coin: the one-call answer to "all-time volume of HIP-3 coin xyz:TSLA". view="top_movers" ' +
      'returns the most active coins (same row shape), capped at 100. Both return the list in one call (no pagination).',
    inputSchema: {
      view: viewSchema(
        ['snapshots', 'top_movers'],
        'snapshots = every coin; top_movers = the most active coins (cap 100).',
        'snapshots',
      ),
      dex_id: z.string().trim().min(1).optional().describe('view="snapshots": only this DEX.'),
      coin: coinSchema
        .optional()
        .describe('view="snapshots": only this prefixed coin, e.g. "xyz:TSLA".'),
      limit: limitSchema(100).describe(
        'Only applies to view="top_movers" (cap 100); ignored for snapshots.',
      ),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'top_movers') {
        const query: Query = { limit: args.limit }
        const page = await hd.getBareList<unknown>('/hip3/top-movers', query)
        return buildResult(
          { data: page.data, meta: { source: '/hip3/top-movers' } },
          { summary: 'HIP-3 top movers.', maxTokens: ctx.config.maxResponseTokens },
        )
      }
      const query: Query = {}
      if (args.dex_id !== undefined) query.dex_id = args.dex_id
      if (args.coin !== undefined) query.coin = args.coin
      const page = await hd.getBareList<unknown>('/hip3/snapshots', query)
      return buildResult(
        { data: page.data, meta: { source: '/hip3/snapshots' } },
        { summary: 'HIP-3 market snapshots.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_ohlcv',
    group: 'hip3',
    title: 'HIP-3 OHLCV candles',
    description:
      'Hourly open/high/low/close candles for one HIP-3 coin, oldest first. `coin` is required and must be the ' +
      'prefixed form (e.g. "xyz:CL"); dex_id optional. Bound with start_time/end_time (ISO-8601 or epoch-ms, ' +
      'sent as start/end); without them the last ~7 days are returned. Default 168 rows, up to 2000. The ' +
      'endpoint has no offset: to continue, move start_time past the last row. Quirk: volume and fees are ' +
      'always 0 here - use the per-candle `trades` count as the activity proxy, or hd_candles for volume.',
    inputSchema: {
      coin: coinSchema.describe('Prefixed HIP-3 coin, e.g. "xyz:CL". Required.'),
      dex_id: z.string().trim().min(1).optional().describe('The DEX id (e.g. "xyz").'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(2000, 168),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { coin: args.coin, limit: args.limit }
      if (args.dex_id !== undefined) query.dex_id = args.dex_id
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start',
        endKey: 'end',
      })
      const page = await hd.getBareList<unknown>('/hip3/ohlcv', query)
      return buildResult(
        {
          data: page.data,
          meta: { source: '/hip3/ohlcv' },
          notes: [
            'volume and fees are always 0 on HIP-3 OHLCV; use the `trades` count as the activity proxy.',
            ...windowHint(page.data, args.limit, 'time'),
          ],
        },
        { summary: `HIP-3 OHLCV for ${args.coin}.`, maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_oracle_stats',
    group: 'hip3',
    title: 'HIP-3 oracle statistics',
    description:
      'One-minute oracle vs mark statistics for a HIP-3 DEX, oldest first: mark/oracle OHLC, max deviation %, avg ' +
      'funding rate, open interest, and trade count. `dex_id` is required (e.g. "xyz"). Bound with ' +
      'start_time/end_time (ISO-8601 or epoch-ms, sent as start/end); without them the last ~24h. Up to 10000 rows ' +
      '(default 1440). The endpoint has no offset: to continue, move start_time past the last bucket. Note: rows ' +
      'carry no coin and asset_id is always 0, so series of different assets of one DEX are not distinguishable.',
    inputSchema: {
      dex_id: z
        .string()
        .trim()
        .min(1)
        .describe('DEX id to scope the oracle series, e.g. "xyz". Required.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(10000, 1440),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { dex_id: args.dex_id, limit: args.limit }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start',
        endKey: 'end',
      })
      const page = await hd.getBareList<unknown>('/hip3/oracle/stats', query)
      return buildResult(
        {
          data: page.data,
          meta: { source: '/hip3/oracle/stats' },
          notes: windowHint(page.data, args.limit, 'bucket'),
        },
        {
          summary: `HIP-3 oracle stats for ${args.dex_id}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_fills',
    group: 'hip3',
    title: 'HIP-3 fills',
    description:
      'Executed trade fills across HIP-3 DEXes, newest first (time, dex_id, coin, user, side, price, size, ' +
      'notional, fee, builder fee, liquidation flag, hash, tid). Filters: dex_id, coin (prefixed), user, side ' +
      '(B|A), min_notional (USD), and a window with start_time/end_time (ISO-8601 or epoch-ms, sent as ' +
      'start/end). Offset-paged via pagination.next_offset. Note: `tid` is a plain integer trade id here (not an ' +
      'opaque pagination cursor).',
    inputSchema: {
      dex_id: z.string().trim().min(1).optional().describe('Only this DEX (e.g. "xyz").'),
      coin: coinSchema.optional().describe('Only this prefixed coin, e.g. "xyz:NVDA".'),
      user: addressSchema.optional().describe('Only this wallet.'),
      side: z.enum(['B', 'A']).optional().describe('B = buy, A = sell.'),
      min_notional: z.number().min(0).optional().describe('Minimum notional in USD.'),
      offset: offsetSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.dex_id !== undefined) query.dex_id = args.dex_id
      if (args.coin !== undefined) query.coin = args.coin
      if (args.user !== undefined) query.user = args.user
      if (args.side !== undefined) query.side = args.side
      if (args.min_notional !== undefined) query.min_notional = args.min_notional
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start',
        endKey: 'end',
      })
      const page = await hd.getBareList<unknown>('/hip3/fills', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      return buildResult(
        { data: page.data, pagination, meta: { source: '/hip3/fills' } },
        { summary: 'HIP-3 fills.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_traders',
    group: 'hip3',
    title: 'HIP-3 trader stats & leaderboard',
    description:
      'Trader activity on HIP-3 DEXes, selected by view:\n' +
      '- "stats" (default): per-(dex,trader,coin) rows (volume, fees, trades, realized PnL, last update), ' +
      'filter with dex_id and/or coin (e.g. the top traders of "xyz:TSLA"), offset-paged via pagination.next_offset.\n' +
      '- "leaderboard": top traders ranked by `by` (volume default, pnl, trades, fees), optionally within one ' +
      'dex_id. Capped at 200; returns the ranked list in one call (no pagination).',
    inputSchema: {
      view: viewSchema(
        ['stats', 'leaderboard'],
        'stats = per-trader/coin rows; leaderboard = top traders by a ranking metric.',
        'stats',
      ),
      by: z
        .enum(['volume', 'pnl', 'trades', 'fees'])
        .optional()
        .describe('view="leaderboard" only: ranking metric (default volume).'),
      dex_id: z.string().trim().min(1).optional().describe('Only this DEX (both views).'),
      coin: coinSchema.optional().describe('view="stats" only: one prefixed coin.'),
      offset: offsetSchema,
      limit: limitSchema(500),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'leaderboard') {
        const limit = Math.min(args.limit, 200)
        const by = args.by ?? 'volume'
        const query: Query = { by, limit }
        if (args.dex_id !== undefined) query.dex_id = args.dex_id
        const page = await hd.getBareList<unknown>('/hip3/leaderboard', query)
        return buildResult(
          { data: page.data, meta: { source: '/hip3/leaderboard', by } },
          { summary: `HIP-3 leaderboard by ${by}.`, maxTokens: ctx.config.maxResponseTokens },
        )
      }
      const query: Query = { limit: args.limit, offset: args.offset }
      if (args.dex_id !== undefined) query.dex_id = args.dex_id
      if (args.coin !== undefined) query.coin = args.coin
      const page = await hd.getBareList<unknown>('/hip3/stats/traders', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      return buildResult(
        { data: page.data, pagination, meta: { source: '/hip3/stats/traders' } },
        { summary: 'HIP-3 trader stats.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_user',
    group: 'hip3',
    title: 'HIP-3 activity for one wallet',
    description:
      "One wallet's HIP-3 activity, selected by view (address required):\n" +
      '- "overview" (default): aggregate totals (volume, fees, trades, realized PnL, coins/dexs traded) ' +
      'as a single object.\n' +
      '- "fills": the wallet\'s fills, optionally filtered by coin / dex_id and bound by start_time/end_time ' +
      '(sent as start/end), offset-paged via pagination.next_offset.\n' +
      '- "coins": per-coin breakdown for the wallet (volume, fees, trades, PnL), capped at 100, returned ' +
      'in one call.',
    inputSchema: {
      address: addressSchema,
      view: viewSchema(
        ['overview', 'fills', 'coins'],
        'overview = aggregate totals; fills = the wallet fills; coins = per-coin breakdown.',
        'overview',
      ),
      coin: coinSchema.optional().describe('view="fills" only: one prefixed coin.'),
      dex_id: z.string().trim().min(1).optional().describe('view="fills" only: one DEX.'),
      offset: offsetSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'overview') {
        const { data } = await hd.getBareSingle<unknown>(`/hip3/users/${args.address}/overview`)
        return rawResult(data, `HIP-3 overview for ${args.address}.`)
      }
      if (args.view === 'coins') {
        const limit = Math.min(args.limit, 100)
        const query: Query = { limit }
        const page = await hd.getBareList<unknown>(`/hip3/users/${args.address}/coins`, query)
        return buildResult(
          { data: page.data, meta: { source: `/hip3/users/${args.address}/coins` } },
          {
            summary: `HIP-3 per-coin breakdown for ${args.address}.`,
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }
      // view === 'fills'
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.coin !== undefined) query.coin = args.coin
      if (args.dex_id !== undefined) query.dex_id = args.dex_id
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start',
        endKey: 'end',
      })
      const page = await hd.getBareList<unknown>(`/hip3/users/${args.address}/fills`, query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      return buildResult(
        { data: page.data, pagination, meta: { source: `/hip3/users/${args.address}/fills` } },
        { summary: `HIP-3 fills for ${args.address}.`, maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip3_gossip',
    group: 'hip3',
    title: 'HIP-3 priority-fee gossip',
    description:
      'Priority-fee gossip auction state for HIP-3 priority slots. view="status" (default) returns the ' +
      'live object (previous winners + the current per-slot auctions: gas, winner, timing). ' +
      'view="history" returns the offset-paged snapshot history; filter with slot_id, bound it with ' +
      'start_time/end_time (ISO-8601 or epoch-ms) and sort with order (ASC|DESC by snapshot time, default DESC). ' +
      'Quirks: `winner` is usually a gossip node IPv4 address, but the earliest history rows (April 2026) carry a ' +
      'wallet address instead; history may contain duplicate rows per snapshot; live on 2026-10-21 the newest ' +
      'history row was from 2026-07-11, so recent windows can be empty.',
    inputSchema: {
      view: viewSchema(
        ['status', 'history'],
        'status = live per-slot auction object; history = snapshot history (offset-paged).',
        'status',
      ),
      slot_id: z.number().int().min(0).optional().describe('view="history": one priority slot.'),
      order: z.enum(['ASC', 'DESC']).optional().describe('view="history": default DESC.'),
      offset: offsetSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      // These two paths use the APIResponse envelope (not bare), so use the API getters.
      if (args.view === 'status') {
        const { data } = await hd.getApiSingle<unknown>('/hip3/priority-fees/gossip/status')
        return rawResult(
          data,
          'HIP-3 priority-fee gossip status. Note: `winner` is a gossip node IPv4, not a wallet address.',
        )
      }
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.slot_id !== undefined) query.slot_id = args.slot_id
      if (args.order !== undefined) query.order = args.order
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const page = await hd.getApiList<unknown>('/hip3/priority-fees/gossip/history', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const meta: Record<string, unknown> = { source: '/hip3/priority-fees/gossip/history' }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
      return buildResult(
        {
          data: page.data,
          pagination,
          meta,
          notes: [
            '`winner` is usually a gossip node IPv4 address (early rows carry a wallet address). ' +
              'History may contain duplicate rows per snapshot.',
          ],
        },
        { summary: 'HIP-3 priority-fee gossip history.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),
]
