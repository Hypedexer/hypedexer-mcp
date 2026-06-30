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
 * API getters — using the bare getters would mis-normalize their wrapped body.
 *
 * `asset_id` is reported as 0 everywhere in HIP-3, so it is neither a useful
 * field nor a useful filter; the relevant identity is `dex_id` + `coin`/`ticker`.
 */
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
      'source, fee share). Omit ticker to list all assets across DEXes (offset-paged via ' +
      'pagination.next_offset). Pass a prefixed ticker like "xyz:CL" (dex id + ":" + symbol) to ' +
      'fetch one asset as a single object. Note: asset_id is always 0 upstream — identify assets by ticker, not id.',
    inputSchema: {
      ticker: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('A prefixed asset ticker like "xyz:CL". Omit to list all assets.'),
      offset: offsetSchema,
      limit: limitSchema(1000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const assetIdNote =
        'asset_id is always 0 in HIP-3 — identify assets by their prefixed ticker, not by id.'
      if (args.ticker !== undefined) {
        const { data } = await hd.getBareSingle<unknown>(
          `/hip3/assets/${encodeURIComponent(args.ticker)}`,
        )
        return rawResult(data, `HIP-3 asset ${args.ticker}. ${assetIdNote}`)
      }
      const query: Query = { limit: args.limit, offset: args.offset }
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
      '- "list" (default): all auctions, offset-paged (pagination.next_offset).\n' +
      '- "current": the single in-progress auction as an object (no pagination).\n' +
      '- "history": settled auctions, offset-paged.\n' +
      'Quirk: on "history", auction_id is a STRING (it is an integer on "list"), and expired rows ' +
      'may carry empty-string dex_id/coin/winner. List/history page with limit + offset.',
    inputSchema: {
      view: viewSchema(
        ['list', 'current', 'history'],
        'list = all auctions; current = the live auction object; history = settled auctions.',
        'list',
      ),
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
      '24h volume/fees/trades, cumulative totals, halted flag). view="snapshots" (default) returns the ' +
      'full set; view="top_movers" returns the most active coins (same row shape), capped at 100. ' +
      'Both return the list in one call (no pagination).',
    inputSchema: {
      view: viewSchema(
        ['snapshots', 'top_movers'],
        'snapshots = every coin; top_movers = the most active coins (cap 100).',
        'snapshots',
      ),
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
      const page = await hd.getBareList<unknown>('/hip3/snapshots')
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
      'Open/high/low/close candles for one HIP-3 coin. `coin` is required and must be the prefixed ' +
      'form (e.g. "xyz:CL"). Optionally bound with start_time/end_time (ISO-8601 or epoch-ms; sent as ' +
      'a bare date). Offset-paged via pagination.next_offset; default 168 rows, up to 2000. Quirk: ' +
      'volume and fees are always 0 here — use the per-candle `trades` count as the activity proxy.',
    inputSchema: {
      coin: coinSchema.describe('Prefixed HIP-3 coin, e.g. "xyz:CL". Required.'),
      offset: offsetSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(2000, 168),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { coin: args.coin, limit: args.limit, offset: args.offset }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoBare',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const page = await hd.getBareList<unknown>('/hip3/ohlcv', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      return buildResult(
        {
          data: page.data,
          pagination,
          meta: { source: '/hip3/ohlcv' },
          notes: [
            'volume and fees are always 0 on HIP-3 OHLCV; use the `trades` count as the activity proxy.',
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
      'Per-bucket oracle vs mark statistics for a HIP-3 DEX: mark/oracle OHLC, max deviation %, avg ' +
      'funding rate, open interest, and trade count. `dex_id` is required (e.g. "xyz"). Optionally bound ' +
      'with start_time/end_time (ISO-8601 or epoch-ms; sent as a bare date). Offset-paged via ' +
      'pagination.next_offset, up to 10000 rows. Note: asset_id is always 0, so any asset_id filter is a no-op.',
    inputSchema: {
      dex_id: z
        .string()
        .trim()
        .min(1)
        .describe('DEX id to scope the oracle series, e.g. "xyz". Required.'),
      offset: offsetSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(10000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { dex_id: args.dex_id, limit: args.limit, offset: args.offset }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoBare',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const page = await hd.getBareList<unknown>('/hip3/oracle/stats', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      return buildResult(
        {
          data: page.data,
          pagination,
          meta: { source: '/hip3/oracle/stats' },
          notes: [
            'asset_id is always 0 in HIP-3, so an asset_id filter has no effect; scope by dex_id.',
          ],
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
      'Executed trade fills across HIP-3 DEXes (time, dex_id, coin, user, side, price, size, notional, ' +
      'fee, builder fee, liquidation flag, hash, tid). Optionally bound with start_time/end_time ' +
      '(ISO-8601 or epoch-ms; sent as a bare date). Offset-paged via pagination.next_offset. ' +
      'Note: `tid` is a plain integer trade id here (not an opaque pagination cursor).',
    inputSchema: {
      offset: offsetSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit, offset: args.offset }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoBare',
        startKey: 'start_time',
        endKey: 'end_time',
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
      'offset-paged via pagination.next_offset.\n' +
      '- "leaderboard": top traders ranked by a metric. Requires `by` ("volume" or "pnl"). Capped at 200; ' +
      'returns the ranked list in one call (no pagination).\n' +
      'An unrecognized `by` value silently falls back upstream rather than erroring.',
    inputSchema: {
      view: viewSchema(
        ['stats', 'leaderboard'],
        'stats = per-trader/coin rows; leaderboard = top traders by a ranking metric.',
        'stats',
      ),
      by: z
        .enum(['volume', 'pnl'])
        .optional()
        .describe('view="leaderboard" only (required there): ranking metric, "volume" or "pnl".'),
      offset: offsetSchema,
      limit: limitSchema(500),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'leaderboard') {
        if (args.by === undefined) {
          throw new Error('view="leaderboard" requires `by` ("volume" or "pnl").')
        }
        const limit = Math.min(args.limit, 200)
        const query: Query = { by: args.by, limit }
        const page = await hd.getBareList<unknown>('/hip3/leaderboard', query)
        return buildResult(
          { data: page.data, meta: { source: '/hip3/leaderboard', by: args.by } },
          { summary: `HIP-3 leaderboard by ${args.by}.`, maxTokens: ctx.config.maxResponseTokens },
        )
      }
      const query: Query = { limit: args.limit, offset: args.offset }
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
      '- "fills": the wallet\'s fills, optionally bound by start_time/end_time and offset-paged via ' +
      'pagination.next_offset.\n' +
      '- "coins": per-coin breakdown for the wallet (volume, fees, trades, PnL), capped at 100, returned ' +
      'in one call.',
    inputSchema: {
      address: addressSchema,
      view: viewSchema(
        ['overview', 'fills', 'coins'],
        'overview = aggregate totals; fills = the wallet fills; coins = per-coin breakdown.',
        'overview',
      ),
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
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoBare',
        startKey: 'start_time',
        endKey: 'end_time',
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
      'view="history" returns the offset-paged snapshot history; bound it with start_time/end_time ' +
      '(ISO-8601 or epoch-ms). Quirk: `winner` is a gossip node IPv4 address, not a wallet; history may ' +
      'also contain duplicate rows per snapshot.',
    inputSchema: {
      view: viewSchema(
        ['status', 'history'],
        'status = live per-slot auction object; history = snapshot history (offset-paged).',
        'status',
      ),
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
            '`winner` is a gossip node IPv4 address, not a wallet address. ' +
              'History may contain duplicate rows per snapshot.',
          ],
        },
        { summary: 'HIP-3 priority-fee gossip history.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),
]
