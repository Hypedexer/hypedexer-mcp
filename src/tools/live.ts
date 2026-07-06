import { type LiveChannel, collectChannel } from '../hypedexer/ws-client.js'
import type { ToolContext } from './context.js'
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
      'Live mirror channel `bbo`: top-of-book best bid and offer for one coin. NOTE: as of 2026-07-01 ' +
      'the upstream mirror hub accepts the bbo subscription but does not emit bbo frames (verified: it ' +
      'stays silent while l2Book for the same coin streams normally). For reliable top-of-book, use ' +
      'hd_live_l2_book and read the first level of each side. This tool is kept for when the upstream ' +
      'channel starts emitting. Point-in-time snapshot; call again for a fresh window.',
    inputSchema: { coin: coinRequired, seconds: secondsSchema, max_items: maxItemsSchema },
    async handler(args, ctx) {
      return collectLive(
        'bbo',
        args,
        ctx,
        'bbo',
        'The upstream mirror hub did not emit any bbo frames (a known gap as of 2026-07-01: the ' +
          'subscription is accepted but no data is pushed). Use hd_live_l2_book and read the top level ' +
          'of each side for best bid/offer instead.',
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
      'Live mirror channel `l4BookUpdates`: incremental per-order L4 book deltas for one coin (adds, ' +
      'cancels, fills against resting orders), without re-sending the full book. Opens the mirror ' +
      'socket, subscribes scoped to `coin`, and collects deltas for a bounded window. Point-in-time ' +
      'snapshot; call again for a fresh window.',
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
      'Live mirror channel `trades`: raw public trade prints for one coin as they execute. NOTE: as of ' +
      '2026-07-01 the upstream mirror hub rejects this subscription ("Unsupported subscription: trades"), ' +
      'so this tool currently errors. Use hd_stream_completed_trades (indexed round-trip trades) or ' +
      'hd_live_l2_book instead. Kept for when the upstream channel is enabled. Opens the mirror socket, ' +
      'subscribes scoped to `coin`, and collects for a bounded window.',
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
      'socket you can also use the keyless hl_public_all_mids REST tool. Point-in-time snapshot; call ' +
      'again for a fresh window.',
    inputSchema: { seconds: secondsSchema, max_items: maxItemsSchema },
    async handler(args, ctx) {
      return collectLive('allMids', args, ctx, 'mids')
    },
  }),
]
