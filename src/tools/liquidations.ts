import type { Query } from '../hypedexer/client.js'
import { assertSafeCursorOrder, sanitizeTotalCount } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult } from './shared/output.js'
import { buildTimeQuery, cursorPagination } from './shared/pagination.js'
import {
  addressSchema,
  coinSchema,
  cursorSchema,
  endTimeSchema,
  limitSchema,
  startTimeSchema,
  z,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Liquidation events (HypeDexer Data API).
 *
 * One search tool over two endpoints, selected by `recent`:
 *   recent=false (default) -> GET /liquidations/        (full history)
 *   recent=true            -> GET /liquidations/recent  (last 24h, cached, faster)
 *
 * Both are cursor-paginated. Each row is a single liquidation fill: coin,
 * liquidated_user, size_total, notional_total, fill_px_vwap, mark_px, method,
 * liquidators, liq_dir, and an epoch-ms `time_ms`.
 */
export const liquidationsTools: ToolModule = [
  defineTool({
    name: 'hd_liquidations_search',
    group: 'liquidations',
    title: 'Search Hyperliquid liquidations',
    description:
      'Search Hyperliquid liquidation events (forced position closes). Optionally filter by coin, ' +
      'the liquidated trader address (user), and a time window. Results page with ' +
      'pagination.next_cursor — call again with cursor=pagination.next_cursor while has_more is true. ' +
      'Set recent=true for the fast last-24h cached feed. Ordering is newest-first (order="desc"); ' +
      'ascending order is unsupported because it corrupts the upstream cursor — reverse client-side if you need oldest-first.',
    inputSchema: {
      recent: z
        .boolean()
        .default(false)
        .describe('Use the cached last-24h feed (faster) instead of full history.'),
      coin: coinSchema.optional().describe('Filter by asset symbol.'),
      user: addressSchema
        .optional()
        .describe(
          'Restrict to liquidations of one trader (the liquidated_user). Omit for the market-wide feed.',
        ),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(100),
      cursor: cursorSchema,
      order: z
        .enum(['desc'])
        .default('desc')
        .describe(
          'Result ordering. Only "desc" (newest-first) is supported; ascending corrupts the upstream cursor.',
        ),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      assertSafeCursorOrder(args.order)

      let query: Query = { limit: args.limit, order: args.order }
      if (args.coin !== undefined) query.coin = args.coin
      if (args.user !== undefined) query.user = args.user
      if (args.cursor !== undefined) query.cursor = args.cursor
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })

      const path = args.recent ? '/liquidations/recent' : '/liquidations/'
      const page = await hd.getApiList(path, query)
      const pagination = cursorPagination(page)

      const meta: Record<string, unknown> = { source: path }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
      const totalCount = sanitizeTotalCount(page.meta.totalCount, page.data.length)
      if (totalCount != null) meta.total_count = totalCount

      return buildResult(
        { data: page.data, pagination, meta },
        {
          summary: `Liquidations${args.coin ? ` for ${args.coin}` : ''}${args.user ? ` of ${args.user}` : ''}${args.recent ? ' (last 24h)' : ''}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
