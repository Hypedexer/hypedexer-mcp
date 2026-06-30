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
    title: 'Hyperliquid spot metadata',
    description:
      'Spot universe metadata: tokens and trading pairs. Set view="contexts" to also include per-pair market context (price, volume). Free, no API key.',
    inputSchema: {
      view: viewSchema(
        ['universe', 'contexts'],
        'universe = tokens + pairs; contexts = + live market context.',
        'universe',
      ),
    },
    async handler(args, ctx) {
      const type = args.view === 'contexts' ? 'spotMetaAndAssetCtxs' : 'spotMeta'
      const data = await ctx.hl.info({ type })
      return rawResult(
        data,
        `Hyperliquid spot ${args.view === 'contexts' ? 'metadata + market contexts' : 'metadata'}.`,
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
