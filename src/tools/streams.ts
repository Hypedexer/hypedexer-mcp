import { type WsChannel, collectChannel } from '../hypedexer/ws-client.js'
import type { ToolContext } from './context.js'
import { buildResult } from './shared/output.js'
import { addressSchema, z } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Indexed WebSocket channel (HypeDexer Data API, wss://.../ws, multiplex envelope).
 *
 * MCP tools are request/response, while the channel pushes continuously. The tool
 * opens the socket, subscribes, collects pushed messages for a bounded window
 * (`seconds`, or until `max_items`), then closes and returns the batch.
 *
 * Live 2026-10-21: the public endpoint serves `liquidations` (plural), with
 * optional filters user, users (up to 50), amount_dollars and builder. The former
 * completed_trades, fills_spot, recent_activity and hip4_events channels, and the
 * singular `liquidation`, are refused ("Unsupported subscription"), so their tools
 * were removed: use hd_completed_trades_search, hd_fills_search scope=spot and
 * hd_hip4_fills (REST) instead.
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
  extra?: Record<string, unknown>
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
    ...(args.extra ? { extra: args.extra } : {}),
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
      'then closed. This is not a continuous subscription - call again for a fresh window.',
    ...result.warnings,
  ]
  if (result.item_count === 0) {
    notes.push(
      'No liquidation matched in the window (the replayed cache empties after ~10 minutes without ' +
        'events, and filters narrow it further); retry with a longer `seconds` window or use ' +
        'hd_liquidations_search for history.',
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
    name: 'hd_stream_liquidations',
    group: 'streams',
    title: 'Stream liquidations (live WS)',
    description:
      'Open the HypeDexer WebSocket, subscribe to `liquidations`, and collect liquidation events for a ' +
      'bounded window. Right after subscribing the server replays up to 200 cached recent events (newest ' +
      'first), then streams new ones. One item per liquidated position, aggregated across liquidators: ' +
      'coin, liquidated_user, size_total, notional_total, fill_px_vwap, mark_px, liq_dir, liquidators, ' +
      'liquidator_count, fee_total_liquidated, builder, tid, time_ms. Filters: user (liquidated user or a ' +
      'liquidator), users (up to 50, combined with user), amount_dollars (minimum notional in USD), builder ' +
      '(builder code on the fills). Returns a point-in-time batch; for history use hd_liquidations_search.',
    inputSchema: {
      user: addressSchema
        .optional()
        .describe('Only liquidations where this address is liquidated or a liquidator.'),
      users: z
        .array(addressSchema)
        .min(1)
        .max(50)
        .optional()
        .describe('Up to 50 addresses (combined with `user`).'),
      amount_dollars: z
        .number()
        .min(0)
        .optional()
        .describe('Only liquidations with notional_total >= this USD amount.'),
      builder: addressSchema
        .optional()
        .describe('Only liquidations whose fills carried this builder code.'),
      seconds: secondsSchema,
      max_items: maxItemsSchema,
    },
    async handler(args, ctx) {
      const extra: Record<string, unknown> = {}
      if (args.users !== undefined) extra.users = args.users
      if (args.amount_dollars !== undefined) extra.amount_dollars = args.amount_dollars
      if (args.builder !== undefined) extra.builder = args.builder
      return collect(
        'liquidations',
        { seconds: args.seconds, max_items: args.max_items, user: args.user, extra },
        ctx,
        'liquidation',
      )
    },
  }),
]
