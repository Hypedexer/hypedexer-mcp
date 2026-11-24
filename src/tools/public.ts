import { encodeTime } from '../core/time.js'
import { normalizeCoin } from '../hyperliquid/coin-format.js'
import { rawResult } from './shared/output.js'
import { coinSchema, viewSchema, z } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Keyless tools over the FREE Hyperliquid public info API
 * (POST https://api.hyperliquid.xyz/info). These need no HypeDexer API key, so
 * the server boots and smoke-tests end-to-end out of the box. Namespaced
 * `hl_public_*` to signal "free public Hyperliquid surface", distinct from the
 * `hd_*` HypeDexer data-API tools.
 */

const CANDLE_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const

interface PublicSpotToken {
  name: string
  index: number
  fullName?: string | null
  deployerLabel?: string
}
interface PublicSpotPair {
  name: string
  index: number
  tokens: number[]
}
interface PublicSpotMeta {
  tokens: PublicSpotToken[]
  universe: PublicSpotPair[]
}
interface PublicSpotCtx {
  coin: string
  markPx?: string
  midPx?: string | null
  prevDayPx?: string
  dayNtlVlm?: string
}

/**
 * Compact spot rows from spotMeta (and spotMetaAndAssetCtxs contexts, joined on the pair name).
 * The raw universe is far over the response budget, so callers get one small row per pair,
 * optionally filtered by handle, token name or a keyword in the base token name / full name.
 */
export function spotRows(
  meta: PublicSpotMeta,
  ctxs: PublicSpotCtx[],
  query?: string,
): Record<string, unknown>[] {
  const byIndex = new Map(meta.tokens.map((t) => [t.index, t]))
  const ctxByCoin = new Map(ctxs.map((c) => [c.coin, c]))
  const q = query?.trim().toLowerCase()
  const handle = q ? /^@(\d+)$/.exec(q) : null
  const rows = meta.universe
    .filter((p) => {
      if (!q) return true
      if (handle) return p.index === Number(handle[1])
      const base = byIndex.get(p.tokens[0] ?? -1)
      return [base?.name, base?.fullName, base?.deployerLabel, p.name].some(
        (field) => typeof field === 'string' && field.toLowerCase().includes(q),
      )
    })
    .map((p) => {
      const base = byIndex.get(p.tokens[0] ?? -1)
      const quote = byIndex.get(p.tokens[1] ?? -1)
      const row: Record<string, unknown> = {
        // Hyperliquid's coin id is the pair name: "@N", or "PURR/USDC" for canonical pairs.
        coin: p.name,
        pair: `${base?.name ?? p.tokens[0]}/${quote?.name ?? p.tokens[1]}`,
        base_full_name: base?.fullName ?? null,
      }
      if (base?.deployerLabel) row.deployer = base.deployerLabel
      const c = ctxByCoin.get(p.name)
      if (c) {
        row.mark_px = c.markPx ?? null
        row.prev_day_px = c.prevDayPx ?? null
        row.day_ntl_vlm = c.dayNtlVlm ?? null
      }
      return row
    })
  if (ctxs.length > 0) {
    rows.sort((a, b) => Number(b.day_ntl_vlm ?? 0) - Number(a.day_ntl_vlm ?? 0))
  }
  return rows
}

export const publicTools: ToolModule = [
  defineTool({
    name: 'hl_public_all_mids',
    group: 'public',
    title: 'Hyperliquid mid prices (all coins)',
    description:
      'Current mid price for every Hyperliquid perp and spot asset, as a map of coin -> mid price string. Free, no API key. Use this for a fast price snapshot across the whole market.',
    inputSchema: {},
    async handler(_args, ctx) {
      const data = await ctx.hl.info({ type: 'allMids' })
      return rawResult(data, 'Current mid prices for all Hyperliquid assets.')
    },
  }),

  defineTool({
    name: 'hl_public_perp_meta',
    group: 'public',
    title: 'Hyperliquid perp metadata',
    description:
      'Perpetuals universe metadata: every perp asset with its name, size decimals, max leverage. Set view="contexts" to also include per-asset market context (mark/oracle price, funding, open interest, 24h volume). Free, no API key.',
    inputSchema: {
      view: viewSchema(
        ['universe', 'contexts'],
        'universe = asset list only; contexts = list + live market context.',
        'universe',
      ),
    },
    async handler(args, ctx) {
      const type = args.view === 'contexts' ? 'metaAndAssetCtxs' : 'meta'
      const data = await ctx.hl.info({ type })
      return rawResult(
        data,
        `Hyperliquid perp ${args.view === 'contexts' ? 'metadata + market contexts' : 'metadata'}.`,
      )
    },
  }),

  defineTool({
    name: 'hl_public_spot_meta',
    group: 'public',
    title: 'Hyperliquid spot pairs (and 24h volume)',
    description:
      'Spot pairs as compact rows: coin handle ("@N", the id to pass to candles / fills), pair label ' +
      '("TSLAX/USDC") and base token full name. view="contexts" adds price and 24h notional volume ' +
      '(day_ntl_vlm, USD) per pair, sorted by volume. Filter with `query`: a handle ("@712"), a token ' +
      'name ("TSLAX") or a family keyword matched inside the base token name or full name ("xStock", "EQX"). ' +
      'The full spot universe (1000+ pairs) is too large for one response, so filter or use `limit`. ' +
      'Free, no API key.',
    inputSchema: {
      view: viewSchema(
        ['universe', 'contexts'],
        'universe = pairs; contexts = pairs + price and 24h volume.',
        'universe',
      ),
      query: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Filter: "@712", "TSLAX", or a keyword in the base token name or full name ("xStock").',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Max rows (default 100). contexts rows are sorted by 24h volume first.'),
    },
    async handler(args, ctx) {
      const contexts = args.view === 'contexts'
      const raw = await ctx.hl.info({ type: contexts ? 'spotMetaAndAssetCtxs' : 'spotMeta' })
      const meta = (contexts ? (raw as unknown[])[0] : raw) as PublicSpotMeta
      const ctxs = contexts ? ((raw as unknown[])[1] as PublicSpotCtx[]) : []
      const rows = spotRows(meta, ctxs, args.query)
      const limit = args.limit ?? 100
      const shown = rows.slice(0, limit)
      const filter = args.query ? ` matching "${args.query}"` : ''
      const more =
        rows.length > shown.length
          ? ` Showing ${shown.length} of ${rows.length}: raise limit or filter with query.`
          : ''
      return rawResult(
        shown,
        `Hyperliquid spot pairs${filter}${contexts ? ', by 24h notional volume' : ''}: ${rows.length} found.${more}`,
      )
    },
  }),

  defineTool({
    name: 'hl_public_l2_book',
    group: 'public',
    title: 'Hyperliquid L2 order book',
    description:
      'Level-2 order book (aggregated bids/asks) for one coin. Free, no API key. Use a perp ticker like "BTC" or a spot handle like "@107".',
    inputSchema: {
      coin: coinSchema,
      n_sig_figs: z
        .number()
        .int()
        .min(2)
        .max(5)
        .optional()
        .describe('Price aggregation significant figures (2-5). Omit for full precision.'),
    },
    async handler(args, ctx) {
      const body: Record<string, unknown> = { type: 'l2Book', coin: normalizeCoin(args.coin) }
      if (args.n_sig_figs !== undefined) body.nSigFigs = args.n_sig_figs
      const data = await ctx.hl.info(body)
      return rawResult(data, `L2 order book for ${normalizeCoin(args.coin)}.`)
    },
  }),

  defineTool({
    name: 'hl_public_candles',
    group: 'public',
    title: 'Hyperliquid candlestick snapshot',
    description:
      'OHLCV candles for one coin over a time window. Free, no API key. Provide an interval and a start time; end time defaults to now.',
    inputSchema: {
      coin: coinSchema,
      interval: z.enum(CANDLE_INTERVALS).describe('Candle interval, e.g. "1m", "1h", "1d".'),
      start_time: z.string().describe('Window start, ISO-8601 or epoch-ms.'),
      end_time: z
        .string()
        .optional()
        .describe('Window end, ISO-8601 or epoch-ms. Defaults to now.'),
    },
    async handler(args, ctx) {
      const req: Record<string, unknown> = {
        coin: normalizeCoin(args.coin),
        interval: args.interval,
        startTime: encodeTime(args.start_time, 'epochCamel'),
      }
      if (args.end_time !== undefined) req.endTime = encodeTime(args.end_time, 'epochCamel')
      const data = await ctx.hl.info({ type: 'candleSnapshot', req })
      return rawResult(data, `${args.interval} candles for ${normalizeCoin(args.coin)}.`)
    },
  }),

  defineTool({
    name: 'hl_public_funding_history',
    group: 'public',
    title: 'Hyperliquid funding-rate history',
    description: 'Historical funding rates for one perp coin over a time window. Free, no API key.',
    inputSchema: {
      coin: coinSchema,
      start_time: z.string().describe('Window start, ISO-8601 or epoch-ms.'),
      end_time: z.string().optional().describe('Window end, ISO-8601 or epoch-ms.'),
    },
    async handler(args, ctx) {
      const body: Record<string, unknown> = {
        type: 'fundingHistory',
        coin: normalizeCoin(args.coin),
        startTime: encodeTime(args.start_time, 'epochCamel'),
      }
      if (args.end_time !== undefined) body.endTime = encodeTime(args.end_time, 'epochCamel')
      const data = await ctx.hl.info(body)
      return rawResult(data, `Funding history for ${normalizeCoin(args.coin)}.`)
    },
  }),

  defineTool({
    name: 'hl_public_predicted_fundings',
    group: 'public',
    title: 'Hyperliquid predicted fundings',
    description: 'Predicted next funding rates across venues for all coins. Free, no API key.',
    inputSchema: {},
    async handler(_args, ctx) {
      const data = await ctx.hl.info({ type: 'predictedFundings' })
      return rawResult(data, 'Predicted funding rates across venues.')
    },
  }),

  defineTool({
    name: 'hl_public_clearinghouse_state',
    group: 'public',
    title: 'Hyperliquid account state (perps)',
    description:
      "A user's perps clearinghouse state: margin summary, account value, and open positions. Free, no API key. Pass the wallet address.",
    inputSchema: {
      user: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 40-hex address')
        .describe('Wallet address, 0x-prefixed 40 hex chars.'),
    },
    async handler(args, ctx) {
      const data = await ctx.hl.info({ type: 'clearinghouseState', user: args.user })
      return rawResult(data, `Perps account state for ${args.user}.`)
    },
  }),
]
