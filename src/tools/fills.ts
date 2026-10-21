import { encodeTime } from '../core/time.js'
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
 *   perp,  no addr, recent=false -> GET /fills/              (spot + perp)
 *   perp,  no addr, recent=true  -> GET /fills/recent        (24h live table, faster)
 *   perp,  address               -> GET /fills/user/{address} (spot + perp)
 *   spot,  no addr               -> GET /fills/spot/
 *   spot,  address               -> GET /fills/spot/user/{address}
 *
 * "perp" endpoints are cursor-paginated; spot endpoints are offset-paginated.
 * The three "perp" endpoints also accept `include_order_type`, which resolves each
 * fill's originating order and adds an `orderType` field; the spot ones do not.
 *
 * hd_fills_count reads X-Total-Count from POST /info type=fills (limit 1) because
 * GET /fills/count ignores coin and time filters live (it always returns the
 * global total). Live 2026-10-21: perp without a user answers 400 "Unknown type:
 * fills" unless a time filter is set, so a missing window becomes startTime 0;
 * spot without a window counts all history; hip3 X-Total-Count only echoes the page.
 */
export const fillsTools: ToolModule = [
  defineTool({
    name: 'hd_fills_search',
    group: 'fills',
    title: 'Search Hyperliquid fills',
    description:
      'Search executed trade fills on Hyperliquid. scope="perp" (default) reads /fills/, /fills/recent and ' +
      '/fills/user/{address}, which despite the name return spot AND perp fills; scope="spot" reads the spot-only ' +
      'endpoints. Filters: trader address, coin (spot also `coins`, several handles), side (B buy | A sell), ' +
      'min notional size_usd (perp scope without address), has_priority_gas, a time window (perp with address ' +
      'also time_range), and order (ASC|DESC). "perp" results page with pagination.next_cursor; spot results page ' +
      'with pagination.next_offset. For the fast last-24h feed, set recent=true (perp scope, no address). Set ' +
      'include_order_type=true (perp scope only) to resolve how each fill was ordered. Caveat: scope="spot" with an ' +
      'address returns nothing unless coin, coins or start_time is given (live upstream behaviour).',
    inputSchema: {
      scope: z.enum(['perp', 'spot']).default('perp').describe('perp fills or spot fills.'),
      address: addressSchema
        .optional()
        .describe('Restrict to one trader. Omit for the market-wide feed.'),
      coin: coinSchema.optional().describe('Filter by asset symbol.'),
      coins: z
        .array(coinSchema)
        .min(1)
        .max(50)
        .optional()
        .describe('Spot scope only: several spot handles (e.g. ["@107","@142"]).'),
      side: z
        .enum(['B', 'A'])
        .optional()
        .describe('B = buy, A = sell. Not on perp scope with address.'),
      size_usd: z
        .number()
        .min(0)
        .optional()
        .describe('Perp scope without address: minimum notional in USD.'),
      has_priority_gas: z
        .boolean()
        .optional()
        .describe('true = only fills that paid priority gas, false = only fills without.'),
      order: z.enum(['ASC', 'DESC']).optional().describe('Sort by time (default DESC).'),
      time_range: z
        .enum(['1h', '24h', '7d', '30d'])
        .optional()
        .describe('Perp scope with address only: preset window (start_time overrides it).'),
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
      if (args.order !== undefined) query.order = args.order
      if (args.has_priority_gas !== undefined) query.has_priority_gas = args.has_priority_gas
      const userPerp = args.scope === 'perp' && args.address !== undefined
      if (args.side !== undefined && args.address === undefined) query.side = args.side
      if (args.size_usd !== undefined && args.scope === 'perp' && !args.address)
        query.size_usd = args.size_usd
      if (args.coins !== undefined && args.scope === 'spot') query.coins = args.coins
      if (args.time_range !== undefined && userPerp) query.time_range = args.time_range
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
      'Count fills without returning them. With a coin, side or time window it reads the exact X-Total-Count of ' +
      'POST /info type=fills: scope="perp" (default; includes HIP-3 "dex:COIN" markets) or "spot" ("@N" handles). ' +
      'Without a window the count is all-time (perp from startTime 0, spot over all history), so ' +
      'coin="@307", scope="spot" gives every fill of that pair since listing. Each trade produces one fill per ' +
      'side: count with side="B" to get the number of trades. With no coin, side or window it returns the global ' +
      'total of indexed fills (GET /fills/count).',
    inputSchema: {
      scope: z.enum(['perp', 'spot']).default('perp').describe('perp (default) or spot fills.'),
      coin: coinSchema.optional(),
      side: z.enum(['B', 'A']).optional().describe('Only buys (B) or sells (A).'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      time_range: z
        .enum(['1h', '24h', '7d', '30d'])
        .optional()
        .describe('Preset window ending now (overrides start_time/end_time).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const hasWindow = Boolean(args.start_time || args.end_time || args.time_range)
      if (args.coin === undefined && args.side === undefined && !hasWindow) {
        const { data } = await hd.getApiSingle<unknown>('/fills/count')
        return rawResult(
          data,
          'Global total of indexed fills (all markets, all time). Pass coin/side/window for a filtered count.',
        )
      }
      const body: Record<string, unknown> = { type: 'fills', market: args.scope, limit: 1 }
      if (args.coin !== undefined) body.coin = args.coin
      if (args.side !== undefined) body.side = args.side
      if (args.time_range !== undefined) body.timeRange = args.time_range
      else {
        if (args.start_time) body.startTime = encodeTime(args.start_time, 'epochCamel')
        if (args.end_time) body.endTime = encodeTime(args.end_time, 'epochCamel')
        if (args.scope === 'perp' && body.startTime === undefined) body.startTime = 0
      }
      const { headers } = await hd.postWithHeaders<unknown>('/info', body)
      const total = headers.get('x-total-count')
      const count = total === null ? null : Number(total)
      const { type: _type, limit: _limit, ...filters } = body
      const notes =
        count === null
          ? ['The upstream sent no X-Total-Count header for this query; the count is unknown.']
          : []
      return rawResult(
        { count, scope: args.scope, filters, notes },
        `Fill count${args.coin ? ` for ${args.coin}` : ''}: ${count ?? 'unknown'}.`,
      )
    },
  }),
]
