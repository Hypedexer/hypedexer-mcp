import { encodeTime } from '../core/time.js'
import type { Query } from '../hypedexer/client.js'
import { requireHd } from './context.js'
import { requireField } from './shared/errors.js'
import { buildResult, rawResult } from './shared/output.js'
import { buildTimeQuery, offsetPagination } from './shared/pagination.js'
import {
  coinSchema,
  endTimeSchema,
  offsetSchema,
  startTimeSchema,
  viewSchema,
  z,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Exchange-level market data served by HypeDexer (keyed), live-verified 2026-10-21.
 *
 *   hd_candles         -> POST /info type=candleSnapshot (HypeDexer, adds 5s/30s)
 *   hd_exchange_info   -> POST /info: dataCoverage, metaAndAssetCtxs (per coin),
 *                         allMids (dex), perpDexs, allPerpMetas, meta (dex),
 *                         perpDexLimits, perpDexStatus, perpsAtOpenInterestCap,
 *                         perpDeployAuctionStatus, spotPairDeployAuctionStatus,
 *                         exchangeStatus, liquidatable, maxMarketOrderNtls,
 *                         allBorrowLendReserveStates, borrowLendReserveHistory,
 *                         validatorL1Votes
 *   hd_order_book      -> POST /info: l2Book, currentDepth, marketLiquidity,
 *                         l2BookDiffSnapshot, trades
 *   hd_market_history  -> GET /market/coins | bbo | spread | depth | slippage |
 *                         book | liquidity-report (archive Apr 2024 - Feb 2026,
 *                         node full book since 23 Sep 2026)
 *   hd_spot_meta       -> POST /info spotMeta (resolve) | GET /spot/pairs |
 *                         /spot/tokens | /spot/auctions/live | /spot/auctions/hist
 *
 * Quirks seen live: candleSnapshot accepts only 5s,30s,1m,5m,15m,30m,1h,4h,1d
 * (any other interval answers 400 "Unknown type: candleSnapshot") and returns at
 * most 5000 candles counted from startTime. Candles carry base volume `v` and
 * trade count `n`, never a quote/USD volume.
 */

const CANDLE_INTERVALS = ['5s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const
const CANDLE_CAP = 5000

interface Candle {
  t: number
  T: number
  s: string
  i: string
  o: string
  c: string
  h: string
  l: string
  v: string
  n: number
}

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/** Aggregate a candle series in-process so an all-time total costs one call. */
export function summarizeCandles(candles: Candle[]): Record<string, unknown> {
  if (candles.length === 0) return { candles: 0 }
  const first = candles[0] as Candle
  const last = candles[candles.length - 1] as Candle
  let base = 0
  let trades = 0
  let estQuote = 0
  let high = Number.NEGATIVE_INFINITY
  let low = Number.POSITIVE_INFINITY
  for (const c of candles) {
    const v = Number(c.v)
    const h = Number(c.h)
    const l = Number(c.l)
    const cl = Number(c.c)
    base += v
    trades += c.n
    estQuote += (v * (h + l + cl)) / 3
    if (h > high) high = h
    if (l < low) low = l
  }
  return {
    coin: first.s,
    interval: first.i,
    candles: candles.length,
    from: new Date(first.t).toISOString(),
    to: new Date(last.T).toISOString(),
    open: Number(first.o),
    close: Number(last.c),
    high,
    low,
    base_volume: round(base, 8),
    trades,
    est_quote_volume: round(estQuote, 2),
  }
}

const INFO_VIEWS = [
  'data_coverage',
  'asset_context',
  'all_mids',
  'perp_dexs',
  'all_perp_metas',
  'perp_meta',
  'perp_dex_limits',
  'perp_dex_status',
  'perps_at_oi_cap',
  'perp_deploy_auction',
  'spot_pair_deploy_auction',
  'exchange_status',
  'liquidatable',
  'max_market_order_notionals',
  'borrow_lend_reserves',
  'borrow_lend_history',
  'validator_l1_votes',
] as const

const INFO_TYPE: Record<(typeof INFO_VIEWS)[number], string> = {
  data_coverage: 'dataCoverage',
  asset_context: 'metaAndAssetCtxs',
  all_mids: 'allMids',
  perp_dexs: 'perpDexs',
  all_perp_metas: 'allPerpMetas',
  perp_meta: 'meta',
  perp_dex_limits: 'perpDexLimits',
  perp_dex_status: 'perpDexStatus',
  perps_at_oi_cap: 'perpsAtOpenInterestCap',
  perp_deploy_auction: 'perpDeployAuctionStatus',
  spot_pair_deploy_auction: 'spotPairDeployAuctionStatus',
  exchange_status: 'exchangeStatus',
  liquidatable: 'liquidatable',
  max_market_order_notionals: 'maxMarketOrderNtls',
  borrow_lend_reserves: 'allBorrowLendReserveStates',
  borrow_lend_history: 'borrowLendReserveHistory',
  validator_l1_votes: 'validatorL1Votes',
}

/** Views that take an optional or required perp `dex` name. */
const DEX_VIEWS = new Set(['all_mids', 'perp_meta', 'perps_at_oi_cap'])
const DEX_REQUIRED_VIEWS = new Set(['perp_dex_limits', 'perp_dex_status'])

/** Unwrap the `{result: ...}` wrapper the HypeDexer-native /info types use. */
function unwrapResult(raw: unknown): unknown {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'result' in raw) {
    return (raw as { result: unknown }).result
  }
  return raw
}

interface SpotToken {
  name: string
  index: number
  tokenId?: string
  szDecimals?: number
  weiDecimals?: number
  fullName?: string | null
  evmContract?: unknown
  isCanonical?: boolean
  deployerTradingFeeShare?: string
}

interface SpotPair {
  name: string
  index: number
  tokens: number[]
  isCanonical?: boolean
}

interface SpotMeta {
  universe: SpotPair[]
  tokens: SpotToken[]
}

/** Resolve a spot handle (`@307`), pair name (`PURR/USDC`) or token name (`HTAO`) from spotMeta. */
export function resolveSpot(meta: SpotMeta, query: string): Record<string, unknown>[] {
  const q = query.trim()
  const byIndex = new Map(meta.tokens.map((t) => [t.index, t]))
  const describe = (pair: SpotPair) => {
    const baseIdx = pair.tokens[0] ?? -1
    const quoteIdx = pair.tokens[1] ?? -1
    const base = byIndex.get(baseIdx)
    const quote = byIndex.get(quoteIdx)
    return {
      coin: `@${pair.index}`,
      pair_name: pair.name,
      pair_index: pair.index,
      is_canonical: pair.isCanonical ?? null,
      base: base ?? { index: baseIdx },
      quote: quote ?? { index: quoteIdx },
      label: `${base?.name ?? baseIdx}/${quote?.name ?? quoteIdx}`,
    }
  }
  const handle = /^@(\d+)$/.exec(q)
  if (handle) {
    const idx = Number(handle[1])
    return meta.universe.filter((p) => p.index === idx).map(describe)
  }
  const upper = q.toUpperCase()
  const pairHits = meta.universe.filter((p) => p.name.toUpperCase() === upper)
  if (pairHits.length > 0) return pairHits.map(describe)
  const tokenIdx = new Set(
    meta.tokens.filter((t) => t.name.toUpperCase() === upper).map((t) => t.index),
  )
  return meta.universe.filter((p) => p.tokens.some((t) => tokenIdx.has(t))).map(describe)
}

export const exchangeTools: ToolModule = [
  defineTool({
    name: 'hd_candles',
    group: 'exchange',
    title: 'HypeDexer candles + volume totals',
    description:
      'OHLCV candles for one market from HypeDexer (POST /info candleSnapshot), plus an in-process ' +
      '`summary` over every returned candle: base_volume (sum of v, in base units), trades (sum of n), ' +
      'open/close/high/low, and est_quote_volume (sum of v * (h+l+c)/3; an ESTIMATE, candles carry no ' +
      'quote volume). This is the one-call answer to "total / all-time volume of coin X": use ' +
      'interval="1d", omit start_time (defaults to the first candle) and set include_candles=false. ' +
      'Works for perps ("BTC"), spot handles ("@107"; resolve names with hd_spot_meta view=resolve) and ' +
      'HIP-3 ("xyz:TSLA"). Intervals: 5s, 30s, 1m, 5m, 15m, 30m, 1h, 4h, 1d (others are rejected upstream). ' +
      'At most 5000 candles are returned, counted from start_time: if summary.candles is 5000 the window ' +
      'was clipped, continue with start_time = summary.to. Main perps start 2025-03-22.',
    inputSchema: {
      coin: coinSchema.describe(
        'Market: perp ticker ("BTC"), spot handle ("@307") or HIP-3 "dex:TICKER" ("xyz:TSLA"). Case is kept as given.',
      ),
      interval: z
        .enum(CANDLE_INTERVALS)
        .default('1d')
        .describe('Candle interval (default 1d). 5s and 30s are HypeDexer additions.'),
      start_time: startTimeSchema.describe(
        'Window start, ISO-8601 or epoch-ms. Omit for the first available candle (all-time).',
      ),
      end_time: endTimeSchema.describe('Window end, ISO-8601 or epoch-ms. Defaults to now.'),
      include_candles: z
        .boolean()
        .default(true)
        .describe('false = return only the summary (cheapest way to get totals).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const coin = args.coin.trim()
      const req: Record<string, unknown> = {
        coin,
        interval: args.interval,
        startTime: args.start_time ? encodeTime(args.start_time, 'epochCamel') : 0,
      }
      if (args.end_time) req.endTime = encodeTime(args.end_time, 'epochCamel')
      const raw = await hd.post<unknown>('/info', { type: 'candleSnapshot', req })
      const candles = (Array.isArray(raw) ? raw : []) as Candle[]
      const summary = summarizeCandles(candles)
      const notes: string[] = [
        'est_quote_volume is an estimate (candle base volume x typical price); base_volume and trades are exact sums of the candles.',
      ]
      if (candles.length >= CANDLE_CAP) {
        notes.push(
          `The upstream returned its ${CANDLE_CAP}-candle maximum: the window is clipped. Continue with start_time=${String(summary.to)} or use a coarser interval.`,
        )
      }
      if (candles.length === 0) {
        notes.push(
          'No candles. Check the coin format (spot is "@N", HIP-3 is "dex:TICKER") and the window.',
        )
      }
      return buildResult(
        {
          data: args.include_candles ? candles : summary,
          meta: args.include_candles
            ? { source: 'POST /info candleSnapshot', summary }
            : { source: 'POST /info candleSnapshot' },
          notes,
        },
        {
          summary: `${args.interval} candles for ${coin}: base_volume ${String(summary.base_volume ?? 0)}, trades ${String(summary.trades ?? 0)}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_exchange_info',
    group: 'exchange',
    title: 'HypeDexer exchange metadata and state',
    description:
      'Exchange-level reference data and state over HypeDexer POST /info, one `view` per type:\n' +
      '- data_coverage: per dataset (fills, spotFills, orders, twaps, userFunding, ledger, liquidations) the ' +
      'start of complete coverage, latest event and delay. Use it to tell "no data" from "not covered".\n' +
      '- asset_context (coin required): funding, open interest, mark/oracle/mid, 24h volumes for one coin. ' +
      'Spot handles return only midPx/impactPxs (volume fields null).\n' +
      '- all_mids (dex optional; omitted returns perps plus "@" spot and "#" outcome mids, "ALL_DEXS" adds HIP-3, ' +
      'a dex name returns only that dex).\n' +
      '- perp_dexs, all_perp_metas, perp_meta (dex optional), perp_dex_limits / perp_dex_status (dex required), ' +
      'perps_at_oi_cap (dex optional), perp_deploy_auction, spot_pair_deploy_auction.\n' +
      '- exchange_status, liquidatable, max_market_order_notionals ([leverage, max notional] tiers), validator_l1_votes.\n' +
      '- borrow_lend_reserves (current state, [token index, state] pairs), borrow_lend_history (token, interval, ' +
      'start/end, limit; sampled every minute since 2026-09-23; token 0 USDC, 150 HYPE, 197 UBTC, 268 USDT0, 360 USDH).\n' +
      'Returns the upstream payload (large payloads are clipped to the response budget).',
    inputSchema: {
      view: viewSchema(INFO_VIEWS, 'Which exchange dataset to read.'),
      coin: coinSchema.optional().describe('view=asset_context: the coin (required).'),
      dex: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Perp dex name (e.g. "xyz"). Optional for all_mids (also "ALL_DEXS"), perp_meta, perps_at_oi_cap; required for perp_dex_limits and perp_dex_status.',
        ),
      token: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('view=borrow_lend_history: HL token index; omit for every reserve.'),
      interval: z
        .enum(['1m', '5m', '15m', '1h', '4h', '1d'])
        .optional()
        .describe('view=borrow_lend_history: bucket (last sample per bucket); omit for raw 1m.'),
      start_time: startTimeSchema.describe(
        'view=borrow_lend_history: window start (default now - 7 days).',
      ),
      end_time: endTimeSchema.describe('view=borrow_lend_history: window end.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .describe(
          'view=borrow_lend_history: max samples (1-10000, default 1000, keeps most recent).',
        ),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const body: Record<string, unknown> = { type: INFO_TYPE[args.view] }
      if (args.view === 'asset_context') {
        body.coin = requireField(args.coin, 'coin', 'view=asset_context')
      }
      if (DEX_REQUIRED_VIEWS.has(args.view)) {
        body.dex = requireField(args.dex, 'dex', `view=${args.view}`)
      } else if (DEX_VIEWS.has(args.view) && args.dex !== undefined) {
        body.dex = args.dex
      }
      if (args.view === 'borrow_lend_history') {
        if (args.token !== undefined) body.token = args.token
        if (args.interval !== undefined) body.interval = args.interval
        if (args.start_time) body.startTime = encodeTime(args.start_time, 'epochCamel')
        if (args.end_time) body.endTime = encodeTime(args.end_time, 'epochCamel')
        if (args.limit !== undefined) body.limit = args.limit
      }
      const raw = await hd.post<unknown>('/info', body)
      return rawResult(
        args.view === 'asset_context' ? unwrapResult(raw) : raw,
        `Exchange info view=${args.view}${body.dex ? ` dex=${String(body.dex)}` : ''}${body.coin ? ` coin=${String(body.coin)}` : ''}.`,
        { maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_order_book',
    group: 'exchange',
    title: 'HypeDexer live order book and trades',
    description:
      'Live book state from HypeDexer POST /info, one `view` per type:\n' +
      '- l2 (coin): L2 snapshot, levels [[bids],[asks]] of {px, sz, n}, top 20 per side.\n' +
      '- depth (coin): cumulative USD depth within 10/50/100 bps of mid. Bands are computed from the top-20 L2 levels, ' +
      'so the three bands can be identical on deep books.\n' +
      '- liquidity (coin, or coins up to 20): spread, depth bands and simulated slippage for 10k/100k/1M USD.\n' +
      '- diffs (coin; start_time, limit 1-5000): recent raw book-diff events (order adds/removes with user and oid) ' +
      'from the last ~3 hours, newest first.\n' +
      '- trades (coin optional; start_time/end_time, limit): recent trades with px, sz, side, tid, hash, users.\n' +
      'For history use hd_market_history (book at a past minute, depth/spread/slippage series).',
    inputSchema: {
      view: viewSchema(['l2', 'depth', 'liquidity', 'diffs', 'trades'], 'Which book view.'),
      coin: coinSchema
        .optional()
        .describe('The market (required except view=liquidity with coins, and trades).'),
      coins: z
        .array(coinSchema)
        .min(1)
        .max(20)
        .optional()
        .describe('view=liquidity: up to 20 markets in one call.'),
      start_time: startTimeSchema.describe('view=diffs|trades: window start.'),
      end_time: endTimeSchema.describe('view=trades: window end.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('view=diffs (default 1000, max 5000) | trades (default 100): max rows.'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const type = {
        l2: 'l2Book',
        depth: 'currentDepth',
        liquidity: 'marketLiquidity',
        diffs: 'l2BookDiffSnapshot',
        trades: 'trades',
      }[args.view]
      const body: Record<string, unknown> = { type }
      if (args.view === 'liquidity' && args.coins !== undefined) body.coins = args.coins
      else if (args.view === 'trades') {
        if (args.coin !== undefined) body.coin = args.coin
      } else body.coin = requireField(args.coin, 'coin', `view=${args.view}`)
      if ((args.view === 'diffs' || args.view === 'trades') && args.start_time)
        body.startTime = encodeTime(args.start_time, 'epochCamel')
      if (args.view === 'trades' && args.end_time)
        body.endTime = encodeTime(args.end_time, 'epochCamel')
      if ((args.view === 'diffs' || args.view === 'trades') && args.limit !== undefined)
        body.limit = args.limit
      const raw = unwrapResult(await hd.post<unknown>('/info', body))
      return rawResult(
        raw,
        `Order book view=${args.view}${body.coin ? ` for ${String(body.coin)}` : ''}.`,
        { maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_market_history',
    group: 'exchange',
    title: 'HypeDexer market history (book, spread, depth, slippage)',
    description:
      'Historical market microstructure from HypeDexer /market/*, one `view` per endpoint:\n' +
      '- coins (kind optional: perp|spot|hip3): markets covered by the archive with first/last trade, trade count ' +
      'and traded notional_usd. The archive spans April 2024 to February 2026 only, so markets listed after that ' +
      '(e.g. spot @307) are absent; use hd_candles for later totals.\n' +
      '- bbo (coin, start_time; interval 1m|1h|1d): mid OHLC, spread bps, sizes at the touch. April 2024 to February 2026.\n' +
      '- spread (coin, start_time): spread distribution (median/p10/p90), coverage, by hour. April 2024 to February 2026.\n' +
      '- depth (coin, start_time; interval): USD depth within 10/50/100 bps, imbalance, levels.\n' +
      '- slippage (coin, start_time; interval, size_usd 10000|100000|1000000): estimated market-order cost in bps.\n' +
      '- liquidity_report (coin, start_time; period day|week): spread, depth, slippage per period + hour-of-day profile.\n' +
      '- book (coin, at; levels 1-50, source minute|snapshot): the order book at a past minute.\n' +
      'Book-based views (depth, slippage, liquidity_report, book) cover April 2024 to February 2026 (archive, top ~20 ' +
      'levels) and continuously since 2026-09-23 (node, full book); there is no book data between 2026-02-10 and ' +
      '2026-09-23. Window caps: 1m max 7 days, 1h max 180 days, 1d max 730 days (larger answers 400).',
    inputSchema: {
      view: viewSchema(
        ['coins', 'bbo', 'spread', 'depth', 'slippage', 'liquidity_report', 'book'],
        'Which /market endpoint.',
      ),
      coin: coinSchema
        .optional()
        .describe('Market (required except view=coins): "BTC", "@107", "xyz:TSLA".'),
      kind: z
        .enum(['perp', 'spot', 'hip3'])
        .optional()
        .describe('view=coins: filter by market kind.'),
      start_time: startTimeSchema.describe(
        'Window start (required for bbo, spread, depth, slippage, liquidity_report).',
      ),
      end_time: endTimeSchema.describe('Window end (default start + max window, or + 30 days).'),
      interval: z
        .enum(['1m', '1h', '1d'])
        .optional()
        .describe(
          'view=bbo|depth|slippage: bucket size (bbo/depth default 1m, slippage default 1h).',
        ),
      size_usd: z
        .union([z.literal(10000), z.literal(100000), z.literal(1000000)])
        .optional()
        .describe('view=slippage: one order size (default all three).'),
      period: z.enum(['day', 'week']).optional().describe('view=liquidity_report: default day.'),
      at: z.string().optional().describe('view=book (required): the minute, ISO-8601 or epoch-ms.'),
      levels: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('view=book: levels per side (default 20; max 20 for minute, 50 for snapshot).'),
      source: z
        .enum(['minute', 'snapshot'])
        .optional()
        .describe('view=book: minute-reconstructed book (default) or nearest full snapshot.'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'coins') {
        const query: Query = {}
        if (args.kind !== undefined) query.kind = args.kind
        const page = await hd.getApiList<unknown>('/market/coins', query)
        return buildResult(
          {
            data: page.data,
            meta: { source: '/market/coins', archive: 'April 2024 to February 2026' },
          },
          {
            summary: `Archive-covered markets${args.kind ? ` (${args.kind})` : ''}.`,
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }
      const coin = requireField(args.coin, 'coin', `view=${args.view}`)
      const enc = encodeURIComponent(coin)
      if (args.view === 'book') {
        const at = requireField(args.at, 'at', 'view=book')
        const query: Query = { at: String(encodeTime(at, 'isoSnake')) }
        if (args.levels !== undefined) query.levels = args.levels
        if (args.source !== undefined) query.source = args.source
        const { data } = await hd.getApiSingle<unknown>(`/market/book/${enc}`, query)
        return rawResult(data, `Order book for ${coin} at ${String(query.at)}.`, {
          maxTokens: ctx.config.maxResponseTokens,
        })
      }
      const start = requireField(args.start_time, 'start_time', `view=${args.view}`)
      let query: Query = {}
      if (args.interval !== undefined && ['bbo', 'depth', 'slippage'].includes(args.view))
        query.interval = args.interval
      if (args.view === 'slippage' && args.size_usd !== undefined) query.size_usd = args.size_usd
      if (args.view === 'liquidity_report' && args.period !== undefined) query.period = args.period
      query = buildTimeQuery(query, {
        start,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const segment = args.view === 'liquidity_report' ? 'liquidity-report' : args.view
      const path = `/market/${segment}/${enc}`
      if (args.view === 'spread' || args.view === 'liquidity_report') {
        const { data } = await hd.getApiSingle<unknown>(path, query)
        return rawResult(data, `Market ${args.view} for ${coin}.`, {
          maxTokens: ctx.config.maxResponseTokens,
        })
      }
      const page = await hd.getApiList<unknown>(path, query)
      return buildResult(
        {
          data: page.data,
          meta: { source: `/market/${segment}/{coin}`, message: page.meta.message },
        },
        { summary: `Market ${args.view} for ${coin}.`, maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_spot_meta',
    group: 'exchange',
    title: 'HypeDexer spot pairs, tokens and deploy auctions',
    description:
      'Spot reference data, one `view`:\n' +
      '- resolve (query required): map a spot handle ("@307"), pair name ("PURR/USDC") or token name ("HTAO") to ' +
      'its pair(s) with base/quote token metadata, from the live spotMeta. Use it before hd_candles / fills on a ' +
      'spot coin, and to name an "@N" handle.\n' +
      '- pairs: GET /spot/pairs (pair_index, base/quote names and token ids). Live it returned 200 rows while pair ' +
      'indexes go above 1000 and no paging param is documented, so it may be partial: prefer view=resolve.\n' +
      '- tokens (search, limit 1-500, offset): GET /spot/tokens; rows can repeat per snapshot (same token_index).\n' +
      '- auctions_live (freshness_sec): spot deploy auctions running now ([] when none).\n' +
      '- auctions_history (lookback_hours default 48, limit, offset): past spot deploy auctions.',
    inputSchema: {
      view: viewSchema(
        ['resolve', 'pairs', 'tokens', 'auctions_live', 'auctions_history'],
        'Which spot dataset.',
        'resolve',
      ),
      query: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('view=resolve: "@307", "PURR/USDC" or a token name like "HTAO".'),
      search: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('view=tokens: search by token name or symbol.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('view=tokens (max 500, default 100) | auctions_history (default 1000).'),
      offset: offsetSchema,
      lookback_hours: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('view=auctions_history: lookback window in hours (default 48).'),
      freshness_sec: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('view=auctions_live: max snapshot age in seconds (default 600).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'resolve') {
        const q = requireField(args.query, 'query', 'view=resolve')
        const meta = await hd.post<SpotMeta>('/info', { type: 'spotMeta' })
        const hits = resolveSpot(meta, q)
        const notes =
          hits.length === 0
            ? [`No spot pair matches "${q}". Check the handle (@N) or token name.`]
            : []
        return buildResult(
          { data: hits, meta: { source: 'POST /info spotMeta', query: q }, notes },
          { summary: `Spot resolve "${q}".`, maxTokens: ctx.config.maxResponseTokens },
        )
      }
      if (args.view === 'pairs') {
        const page = await hd.getBareList<unknown>('/spot/pairs')
        return buildResult(
          {
            data: page.data,
            meta: { source: '/spot/pairs' },
            notes: [
              'May be partial (no documented paging); use view=resolve for an authoritative lookup.',
            ],
          },
          { summary: 'Spot pairs.', maxTokens: ctx.config.maxResponseTokens },
        )
      }
      if (args.view === 'tokens') {
        const limit = Math.min(args.limit ?? 100, 500)
        const query: Query = { limit, offset: args.offset }
        if (args.search !== undefined) query.search = args.search
        const page = await hd.getBareList<unknown>('/spot/tokens', query)
        return buildResult(
          {
            data: page.data,
            pagination: offsetPagination(page, args.offset, limit),
            meta: { source: '/spot/tokens' },
          },
          {
            summary: `Spot tokens${args.search ? ` matching "${args.search}"` : ''}.`,
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }
      if (args.view === 'auctions_live') {
        const query: Query = {}
        if (args.freshness_sec !== undefined) query.freshness_sec = args.freshness_sec
        const page = await hd.getBareList<unknown>('/spot/auctions/live', query)
        return buildResult(
          { data: page.data, meta: { source: '/spot/auctions/live' } },
          { summary: 'Live spot deploy auctions.', maxTokens: ctx.config.maxResponseTokens },
        )
      }
      const limit = args.limit ?? 1000
      const query: Query = { limit, offset: args.offset }
      if (args.lookback_hours !== undefined) query.lookback_hours = args.lookback_hours
      const page = await hd.getBareList<unknown>('/spot/auctions/hist', query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, limit),
          meta: { source: '/spot/auctions/hist' },
        },
        { summary: 'Past spot deploy auctions.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),
]
