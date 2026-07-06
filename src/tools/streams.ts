import { type WsChannel, collectChannel } from '../hypedexer/ws-client.js'
import type { ToolContext } from './context.js'
import { buildResult } from './shared/output.js'
import { addressSchema, z } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Live WebSocket channels (HypeDexer Data API, wss://.../ws).
 *
 * MCP tools are request/response, while these channels push continuously. Each
 * tool here opens the socket, subscribes to one channel, collects pushed
 * messages for a bounded window (`seconds`, or until `max_items`), then closes
 * and returns the batch. The result is a point-in-time snapshot, not a standing
 * subscription; call again for a fresh window. All five channels from the
 * server's `welcome` frame are covered:
 *   - completed_trades : closed round-trip trades (user-scopable).
 *   - fills_spot       : spot fills, low-latency push. The REST /fills/spot/*
 *                        endpoints (hd_fills_search scope=spot) work again
 *                        upstream since 2026-07-06 and cover history.
 *   - recent_activity  : multiplexed firehose; each item carries a `stream` field.
 *   - liquidation      : liquidation events (note the singular channel name).
 *   - hip4_events      : HIP-4 prediction-market events.
 */

const secondsSchema = z
  .number()
  .int()
  .min(1)
  .max(30)
  .default(5)
  .describe(
    'How long to listen on the channel before returning, in seconds (1-30, default 5). ' +
      'The tool opens the socket, collects pushed messages for this window, then closes.',
  )

const maxItemsSchema = z
  .number()
  .int()
  .min(1)
  .max(2000)
  .default(200)
  .describe(
    'Stop early once this many items have been collected (1-2000, default 200), even if the ' +
      'time window has not fully elapsed. Guards against high-volume channels flooding the result.',
  )

interface StreamArgs {
  seconds: number
  max_items: number
  user?: string | undefined
}

/** Shared handler body: collect one channel for a window and shape the result. */
async function collect(
  channel: WsChannel,
  args: StreamArgs,
  ctx: ToolContext,
  label: string,
): Promise<ReturnType<typeof buildResult>> {
  const apiKey = ctx.config.apiKey
  if (!apiKey) {
    throw new Error('This tool requires a HypeDexer API key. Set HYPEDEXER_API_KEY to enable it.')
  }

  const result = await collectChannel({
    baseUrl: ctx.config.hypedexerBaseUrl,
    apiKey,
    channel,
    ...(args.user ? { user: args.user } : {}),
    durationMs: args.seconds * 1000,
    maxItems: args.max_items,
    connectTimeoutMs: ctx.config.requestTimeoutMs,
    ...(ctx.config.wsUrl ? { wsUrl: ctx.config.wsUrl } : {}),
  })

  const meta: Record<string, unknown> = {
    channel: result.channel,
    message_count: result.message_count,
    item_count: result.item_count,
    window_seconds: args.seconds,
    elapsed_ms: result.elapsed_ms,
    stopped_by: result.stopped_by,
  }
  if (result.user) meta.user = result.user

  const notes = [
    'Point-in-time WebSocket snapshot: the stream was opened, subscribed, drained for the window, ' +
      'then closed. This is not a continuous subscription — call again for a fresh window.',
    ...result.warnings,
  ]
  if (result.item_count === 0) {
    notes.push(
      'No messages arrived in the window. This channel can be low-frequency (e.g. liquidation and ' +
        'hip4_events are often idle); retry with a longer `seconds` window.',
    )
  }

  return buildResult(
    { data: result.items, meta, notes },
    {
      summary: `Collected ${result.item_count} ${label} item(s) over ${result.elapsed_ms}ms (${result.message_count} push frame(s)).`,
      maxTokens: ctx.config.maxResponseTokens,
    },
  )
}

export const streamsTools: ToolModule = [
  defineTool({
    name: 'hd_stream_completed_trades',
    group: 'streams',
    title: 'Stream completed trades (live WS)',
    description:
      'Open the HypeDexer WebSocket, subscribe to the `completed_trades` channel, and collect closed ' +
      'round-trip trades pushed live for a bounded window. This is a high-volume channel (~2 msgs/s ' +
      'market-wide), so it usually fills `max_items` quickly. Pass `user` to scope to one wallet. Each ' +
      'item has the same shape as a REST trade-history row. Returns a point-in-time batch, not a ' +
      'standing subscription — call again for a fresh window.',
    inputSchema: {
      user: addressSchema
        .optional()
        .describe(
          'Scope to one wallet (0x...). Only this channel supports user scoping. Omit for market-wide.',
        ),
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      return collect('completed_trades', args, ctx, 'completed trade')
    },
  }),

  defineTool({
    name: 'hd_stream_fills_spot',
    group: 'streams',
    title: 'Stream spot fills (live WS)',
    description:
      'Open the HypeDexer WebSocket, subscribe to the `fills_spot` channel, and collect spot fills ' +
      'pushed live for a bounded window. Best for the freshest pushes; for historical or filtered ' +
      'spot fills use hd_fills_search with scope="spot" (REST, offset-paginated). Items use ' +
      'spot coin handles (e.g. coin "@107" with a coin_meaning like "HYPE"). Returns a point-in-time ' +
      'batch; call again for a fresh window.',
    inputSchema: {
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      return collect('fills_spot', args, ctx, 'spot fill')
    },
  }),

  defineTool({
    name: 'hd_stream_recent_activity',
    group: 'streams',
    title: 'Stream recent activity firehose (live WS)',
    description:
      'Open the HypeDexer WebSocket, subscribe to the `recent_activity` channel, and collect the ' +
      'multiplexed activity firehose for a bounded window. This channel re-emits the other channels ' +
      '(completed_trades, fills_spot, ...) with an extra `stream` field on each item telling you which ' +
      'underlying channel it came from. Use it for a single combined feed; use the per-channel tools ' +
      'when you only want one stream. Returns a point-in-time batch; call again for a fresh window.',
    inputSchema: {
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      return collect('recent_activity', args, ctx, 'activity')
    },
  }),

  defineTool({
    name: 'hd_stream_liquidations',
    group: 'streams',
    title: 'Stream liquidations (live WS)',
    description:
      'Open the HypeDexer WebSocket, subscribe to the `liquidation` channel (note: singular upstream ' +
      'channel name), and collect liquidation events pushed live for a bounded window. This is a ' +
      'low-frequency channel and is often idle, so an empty result is normal — use a longer `seconds` ' +
      'window if you need to catch events. Returns a point-in-time batch; call again for a fresh window.',
    inputSchema: {
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      return collect('liquidation', args, ctx, 'liquidation')
    },
  }),

  defineTool({
    name: 'hd_stream_hip4_events',
    group: 'streams',
    title: 'Stream HIP-4 events (live WS)',
    description:
      'Open the HypeDexer WebSocket, subscribe to the `hip4_events` channel, and collect HIP-4 ' +
      'prediction-market events pushed live for a bounded window. This is a low-frequency channel and ' +
      'is often idle, so an empty result is normal — use a longer `seconds` window if you need to catch ' +
      'events. Returns a point-in-time batch; call again for a fresh window.',
    inputSchema: {
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      return collect('hip4_events', args, ctx, 'HIP-4 event')
    },
  }),
]
