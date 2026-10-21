import { type LiveChannel, collectChannel } from '../hypedexer/ws-client.js'
import type { ToolContext } from './context.js'
import { requireField } from './shared/errors.js'
import { buildResult } from './shared/output.js'
import { addressSchema, coinSchema, z } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Live (mirror) WebSocket channels - Hyperliquid live feeds proxied by HypeDexer
 * on `wss://api.hypedexer.com/ws?mode=mirror`. These differ from the indexed
 * `streams` group: a separate endpoint (`?mode=mirror`), separate subscription
 * types, and a `{ channel, data: {...} }` envelope (one data object per frame,
 * the first usually an `isSnapshot` of current state).
 *
 * Like the `streams` group, each tool is a bounded-window snapshot: it opens the
 * mirror socket, subscribes to one channel, drains frames for `seconds` (or until
 * `max_items`), then closes. For book channels (l2Book/l4Book/bbo) the first
 * frame IS the current book, so a short window already returns useful state.
 */

const secondsSchema = z
  .number()
  .int()
  .min(1)
  .max(30)
  .default(5)
  .describe(
    'How long to listen on the channel before returning, in seconds (1-30, default 5). ' +
      'For book channels the first frame is the current snapshot, so even a short window returns state.',
  )

const maxItemsSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(50)
  .describe(
    'Stop early once this many frames have been collected (1-1000, default 50), even if the time ' +
      'window has not elapsed. Firehose channels (allFills, trades) fill this quickly on busy markets.',
  )

interface LiveArgs {
  seconds: number
  max_items: number
  coin?: string | undefined
  user?: string | undefined
  extra?: Record<string, unknown>
}

/** Shared handler: collect one mirror channel for a window and shape the result. */
async function collectLive(
  channel: LiveChannel,
  args: LiveArgs,
  ctx: ToolContext,
  label: string,
  emptyHint?: string,
): Promise<ReturnType<typeof buildResult>> {
  const apiKey = ctx.config.apiKey
  if (!apiKey) {
    throw new Error('This tool requires a HypeDexer API key. Set HYPEDEXER_API_KEY to enable it.')
  }

  const result = await collectChannel({
    baseUrl: ctx.config.hypedexerBaseUrl,
    apiKey,
    channel,
    mode: 'mirror',
    ...(args.coin ? { coin: args.coin } : {}),
    ...(args.user ? { user: args.user } : {}),
    ...(args.extra ? { extra: args.extra } : {}),
    durationMs: args.seconds * 1000,
    maxItems: args.max_items,
    connectTimeoutMs: ctx.config.requestTimeoutMs,
    ...(ctx.config.wsUrl ? { wsUrl: ctx.config.wsUrl } : {}),
  })

  const meta: Record<string, unknown> = {
    channel: result.channel,
    mode: result.mode,
    message_count: result.message_count,
    item_count: result.item_count,
    window_seconds: args.seconds,
    elapsed_ms: result.elapsed_ms,
    stopped_by: result.stopped_by,
  }
  if (result.coin) meta.coin = result.coin
  if (result.user) meta.user = result.user

  const notes = [
    'Point-in-time Live (mirror) WebSocket snapshot: the stream was opened with ?mode=mirror, ' +
      'subscribed, drained for the window, then closed. Frames flagged isSnapshot:true are a replay ' +
      'of current state (e.g. the full book); later frames are incremental updates.',
    ...result.warnings,
  ]
  if (result.item_count === 0) {
    notes.push(
      emptyHint ??
        'No frames arrived in the window. Verify the coin/user filter and retry with a longer `seconds` window.',
    )
  }

  return buildResult(
    { data: result.items, meta, notes },
    {
      summary: `Collected ${result.item_count} ${label} frame(s) over ${result.elapsed_ms}ms.`,
      maxTokens: ctx.config.maxResponseTokens,
    },
  )
}

const coinRequired = coinSchema.describe('Coin symbol, e.g. "BTC". Required for this channel.')

export const liveTools: ToolModule = [
  defineTool({
    name: 'hd_live_all_fills',
    group: 'live',
    title: 'Stream the live perp-fill firehose (Live WS)',
    description:
      'Live mirror channel `allFills`: every perp fill on Hyperliquid, globally - the firehose. Opens ' +
      'wss://.../ws?mode=mirror, subscribes, and collects fills for a bounded window. High volume on ' +
      'busy markets, so it usually fills `max_items` fast. Point-in-time snapshot; call again for a ' +
      'fresh window. For one wallet use hd_live_user_fills.',
    inputSchema: { seconds: secondsSchema, max_items: maxItemsSchema },
    async handler(args, ctx) {
      return collectLive('allFills', args, ctx, 'fill')
    },
  }),

  defineTool({
    name: 'hd_live_user_fills',
    group: 'live',
    title: 'Stream live fills for one wallet (Live WS)',
    description:
      'Live mirror channel `userFills`: fills for a single address as they happen. Opens the mirror ' +
      'socket, subscribes scoped to `user`, and collects fills for a bounded window. Point-in-time ' +
      'snapshot; call again for a fresh window.',
    inputSchema: {
      user: addressSchema.describe('Wallet address (0x...) to stream fills for. Required.'),
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      return collectLive('userFills', args, ctx, 'fill')
    },
  }),

  defineTool({
    name: 'hd_live_bbo',
    group: 'live',
    title: 'Stream best bid/offer (Live WS)',
    description:
      'Live mirror channel `bbo`: top-of-book best bid and offer for one coin, one frame per change ' +
      '({coin, time, bbo: [bid, ask]} with px, sz, n). Live-verified 2026-10-21 (the 2026-07-01 gap where ' +
      'no frames arrived is gone). Point-in-time snapshot; call again for a fresh window.',
    inputSchema: { coin: coinRequired, seconds: secondsSchema, max_items: maxItemsSchema },
    async handler(args, ctx) {
      return collectLive(
        'bbo',
        args,
        ctx,
        'bbo',
        'No bbo frame arrived in the window. Retry, or use hd_live_l2_book and read the top level of ' +
          'each side.',
      )
    },
  }),

  defineTool({
    name: 'hd_live_l2_book',
    group: 'live',
    title: 'Stream the L2 order book (Live WS)',
    description:
      'Live mirror channel `l2Book`: the aggregated L2 order book for one coin (price levels with ' +
      'summed size). The first frame is a full snapshot of the current book; later frames are updates. ' +
      'Opens the mirror socket, subscribes scoped to `coin`, and collects for a bounded window. For ' +
      'just the current book, a 1-2s window is enough.',
    inputSchema: { coin: coinRequired, seconds: secondsSchema, max_items: maxItemsSchema },
    async handler(args, ctx) {
      return collectLive('l2Book', args, ctx, 'l2Book')
    },
  }),

  defineTool({
    name: 'hd_live_l4_book',
    group: 'live',
    title: 'Stream the L4 order book (Live WS)',
    description:
      'Live mirror channel `l4Book`: the raw per-order L4 book for one coin (individual resting orders, ' +
      'not aggregated levels). First frame is the snapshot, then updates. Opens the mirror socket, ' +
      'subscribes scoped to `coin`, and collects for a bounded window. For incremental deltas only, use ' +
      'hd_live_l4_book_updates. NOTE: a deep L4 snapshot can exceed the native runtime WebSocket ' +
      'decompression limit and fail with "Max decompressed message size exceeded" (seen on BTC, ' +
      '2026-07-01); for reliable aggregated depth use hd_live_l2_book.',
    inputSchema: { coin: coinRequired, seconds: secondsSchema, max_items: maxItemsSchema },
    async handler(args, ctx) {
      return collectLive('l4Book', args, ctx, 'l4Book')
    },
  }),

  defineTool({
    name: 'hd_live_l4_book_updates',
    group: 'live',
    title: 'Stream incremental L4 book deltas (Live WS)',
    description:
      'Live mirror channel `l4BookUpdates`: incremental per-order L4 book deltas (adds, cancels, fills ' +
      'against resting orders). CAVEAT: live on 2026-10-21 the subscription was acknowledged but no data ' +
      'frame arrived (with or without coin, on /ws and on mirror), so expect an empty result; for order-level ' +
      'activity use hd_order_book view=diffs (REST, recent book diffs with user and oid).',
    inputSchema: { coin: coinRequired, seconds: secondsSchema, max_items: maxItemsSchema },
    async handler(args, ctx) {
      return collectLive('l4BookUpdates', args, ctx, 'l4 update')
    },
  }),

  defineTool({
    name: 'hd_live_trades',
    group: 'live',
    title: 'Stream public trade prints (Live WS)',
    description:
      'Live mirror channel `trades`: public trade prints for one coin as they execute (coin, side, px, sz, ' +
      'time, hash, tid, users); the first frame is a snapshot of recent trades. Live-verified 2026-10-21 (the ' +
      '2026-07-01 rejection is gone). Opens the mirror socket, subscribes scoped to `coin`, and collects for ' +
      'a bounded window. For a one-shot REST read use hd_order_book view=trades.',
    inputSchema: { coin: coinRequired, seconds: secondsSchema, max_items: maxItemsSchema },
    async handler(args, ctx) {
      return collectLive('trades', args, ctx, 'trade')
    },
  }),

  defineTool({
    name: 'hd_live_all_mids',
    group: 'live',
    title: 'Stream mid prices for all coins (Live WS)',
    description:
      'Live mirror channel `allMids`: mid prices for every coin, updated live. Opens the mirror socket, ' +
      'subscribes, and collects mid-price frames for a bounded window. For a one-shot snapshot without a ' +
      'socket you can also use hd_exchange_info view=all_mids or the keyless hl_public_all_mids. `dex` ' +
      'narrows to one HIP-3 dex (e.g. "xyz"). Point-in-time snapshot; call again for a fresh window.',
    inputSchema: {
      dex: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Only the mids of this perp dex, e.g. "xyz".'),
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      return collectLive(
        'allMids',
        {
          seconds: args.seconds,
          max_items: args.max_items,
          ...(args.dex ? { extra: { dex: args.dex } } : {}),
        },
        ctx,
        'mids',
      )
    },
  }),

  defineTool({
    name: 'hd_live_feed',
    group: 'live',
    title: 'Stream other live channels (Live WS)',
    description:
      'Bounded snapshot of the remaining Live mirror channels, picked with `channel`:\n' +
      '- candle (coin; interval 5s|30s|1m|5m|15m|30m|1h|4h|1d, default 1m): live OHLCV for one coin; closed ' +
      'buckets carry closed:true. allCandles (interval): the same frames for every coin (high volume).\n' +
      '- activeAssetCtx (coin): mark, oracle, mid, funding, open interest, 24h volumes for one coin.\n' +
      '- fundingRates: current funding rate per coin. setOracleUpdates: oracle price sets (HIP-3 dexs included).\n' +
      '- allTwapStatusUpdates: TWAP status events for all users (snapshot then updates).\n' +
      '- orderUpdates (user): order status changes. userEvents (user): liquidations and one frame per funding ' +
      'payment (can be silent for a while). userFundings (user): the 100 most recent funding payments, then ' +
      'one frame per hourly settlement. userNonFundingLedgerUpdates (user): the 100 most recent ledger entries, ' +
      'then new ones.\n' +
      'Opens wss://.../ws?mode=mirror, subscribes, collects frames for `seconds` or `max_items`, closes.',
    inputSchema: {
      channel: z
        .enum([
          'candle',
          'allCandles',
          'activeAssetCtx',
          'fundingRates',
          'setOracleUpdates',
          'allTwapStatusUpdates',
          'orderUpdates',
          'userEvents',
          'userFundings',
          'userNonFundingLedgerUpdates',
        ])
        .describe('The live channel.'),
      coin: coinSchema.optional().describe('candle and activeAssetCtx (required there).'),
      user: addressSchema
        .optional()
        .describe(
          'orderUpdates, userEvents, userFundings, userNonFundingLedgerUpdates (required there).',
        ),
      interval: z
        .enum(['5s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1d'])
        .optional()
        .describe('candle / allCandles bucket (default 1m).'),
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      const needsCoin = args.channel === 'candle' || args.channel === 'activeAssetCtx'
      const needsUser = [
        'orderUpdates',
        'userEvents',
        'userFundings',
        'userNonFundingLedgerUpdates',
      ].includes(args.channel)
      const live: LiveArgs = { seconds: args.seconds, max_items: args.max_items }
      if (needsCoin) live.coin = requireField(args.coin, 'coin', `channel=${args.channel}`)
      if (needsUser) live.user = requireField(args.user, 'user', `channel=${args.channel}`)
      if (args.channel === 'candle' || args.channel === 'allCandles')
        live.extra = { interval: args.interval ?? '1m' }
      return collectLive(args.channel, live, ctx, args.channel)
    },
  }),
]
