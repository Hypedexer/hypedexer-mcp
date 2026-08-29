import type { Query } from '../hypedexer/client.js'
import { sanitizeTotalCount } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { buildTimeQuery, cursorPagination, offsetPagination } from './shared/pagination.js'
import {
  addressSchema,
  coinSchema,
  cursorSchema,
  endTimeSchema,
  limitSchema,
  offsetSchema,
  startTimeSchema,
  z,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Perp + spot trade fills (HypeDexer Data API).
 *
 * Consolidates five endpoints into one search tool via a `scope` (perp|spot) and
 * an optional `address`:
 *   perp,  no addr, recent=false -> GET /fills/
 *   perp,  no addr, recent=true  -> GET /fills/recent       (24h cache, faster)
 *   perp,  address               -> GET /fills/user/{address}
 *   spot,  no addr               -> GET /fills/spot/
 *   spot,  address               -> GET /fills/spot/user/{address}
 *
 * Perp endpoints are cursor-paginated; spot endpoints are offset-paginated.
 * The three perp endpoints also accept `include_order_type`, which resolves each
 * fill's originating order and adds an `orderType` field; the spot ones do not.
 */
export const fillsTools: ToolModule = [
  defineTool({
    name: 'hd_fills_search',
    group: 'fills',
    title: 'Search Hyperliquid fills',
    description:
      'Search executed trade fills on Hyperliquid. Pick scope="perp" (default) or "spot". ' +
      'Optionally filter by a trader address and/or coin, and a time window. Perp results page ' +
      'with pagination.next_cursor; spot results page with pagination.next_offset. For the fast ' +
      'last-24h perp feed, set recent=true (perp, no address). Set include_order_type=true (perp ' +
      'only) to resolve how each fill was ordered.',
    inputSchema: {
      scope: z.enum(['perp', 'spot']).default('perp').describe('perp fills or spot fills.'),
      address: addressSchema
        .optional()
        .describe('Restrict to one trader. Omit for the market-wide feed.'),
      coin: coinSchema.optional().describe('Filter by asset symbol.'),
      recent: z
        .boolean()
        .default(false)
        .describe('Perp only, no address: use the cached last-24h feed (faster).'),
      include_order_type: z
        .boolean()
        .default(false)
        .describe(
          'Perp scope only: add an `orderType` to each fill ("Limit", "Market", "Stop Market", ' +
            '"Take Profit Limit", ...), resolved from the order the fill came from. Null for fills ' +
            'older than order-status coverage (before 2026-06-27). Costs roughly +300 ms per page.',
        ),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000),
      cursor: cursorSchema,
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit }
      if (args.coin !== undefined) query.coin = args.coin
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })

      let path: string
      if (args.scope === 'perp') {
        if (args.cursor !== undefined) query.cursor = args.cursor
        if (args.include_order_type) query.include_order_type = true
        path = args.address
          ? `/fills/user/${args.address}`
          : args.recent
            ? '/fills/recent'
            : '/fills/'
      } else {
        query.offset = args.offset
        path = args.address ? `/fills/spot/user/${args.address}` : '/fills/spot/'
      }

      const page = await hd.getApiList(path, query)
      const pagination =
        args.scope === 'perp'
          ? cursorPagination(page)
          : offsetPagination(page, args.offset, args.limit)

      const meta: Record<string, unknown> = { scope: args.scope, source: path }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
      const totalCount = sanitizeTotalCount(page.meta.totalCount, page.data.length)
      if (totalCount != null) meta.total_count = totalCount

      const notes: string[] = []
      if (args.include_order_type && args.scope === 'spot') {
        notes.push(
          'include_order_type is a perp-only option upstream; spot fills carry no `orderType` and the flag was not sent.',
        )
      }

      return buildResult(
        { data: page.data, pagination, meta, notes },
        {
          summary: `${args.scope} fills${args.address ? ` for ${args.address}` : ''}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_fills_count',
    group: 'fills',
    title: 'Count Hyperliquid fills',
    description:
      'Total count of perp fills matching an optional coin and/or time window - without returning the rows. Use this to size a query before paging.',
    inputSchema: {
      coin: coinSchema.optional(),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = {}
      if (args.coin !== undefined) query.coin = args.coin
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const { data } = await hd.getApiSingle<unknown>('/fills/count', query)
      return rawResult(data, 'Fill count.')
    },
  }),
]
