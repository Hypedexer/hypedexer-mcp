import type { Query } from '../hypedexer/client.js'
import { sanitizeTotalCount } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { offsetPagination } from './shared/pagination.js'
import { addressSchema, coinSchema, limitSchema, offsetSchema, z } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * TWAP (time-weighted average price) orders (HypeDexer Data API).
 *
 * A TWAP slices a large order into many small sub-orders executed over time.
 * Three tools cover the surface:
 *   - hd_twaps_search : list TWAP orders, optionally scoped to one trader.
 *   - hd_twaps_stats  : aggregate counts/volumes across all TWAPs.
 *   - hd_twap_detail  : one TWAP by id, optionally with its executed fills.
 *
 * All endpoints use the standard API envelope. List endpoints are offset-paginated.
 */
export const twapsTools: ToolModule = [
  defineTool({
    name: 'hd_twaps_search',
    group: 'twaps',
    title: 'Search Hyperliquid TWAP orders',
    description:
      'List TWAP (time-weighted average price) orders on Hyperliquid. Omit `address` for the ' +
      'market-wide feed (GET /twaps/, page size up to 500); pass an `address` to scope to one ' +
      'trader (GET /twaps/user/{address}, page size up to 200, and each row adds an `executionPct` ' +
      'progress field). On the market-wide feed you can narrow server-side with `coin`, `status`, ' +
      '`hours`, and `order` (these filters are ignored when `address` is set). Offset-paginated: page ' +
      'with pagination.next_offset. Returns each TWAP order with its coin, side, size, status, and ' +
      'start time. Use hd_twap_detail for a single order plus its sub-order fills.',
    inputSchema: {
      address: addressSchema
        .optional()
        .describe(
          'Restrict to one trader (caps page size at 200 and adds `executionPct`). Omit for the market-wide feed.',
        ),
      coin: coinSchema
        .optional()
        .describe(
          'Filter the market-wide feed to one coin (e.g. "BTC"). Server-side filter for GET /twaps/ only; ignored when `address` is set.',
        ),
      status: z
        .enum(['activated', 'finished', 'terminated', 'all'])
        .optional()
        .describe(
          'Filter the market-wide feed by TWAP status. GET /twaps/ only; ignored when `address` is set.',
        ),
      hours: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Restrict the market-wide feed to TWAPs from the last N hours. GET /twaps/ only; ignored when `address` is set.',
        ),
      order: z
        .string()
        .trim()
        .optional()
        .describe(
          'Sort order for the market-wide feed (GET /twaps/ only; ignored when `address` is set).',
        ),
      limit: limitSchema(500),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const cap = args.address ? 200 : 500
      const limit = Math.min(args.limit, cap)
      const path = args.address ? `/twaps/user/${args.address}` : '/twaps/'

      const query: Query = { limit, offset: args.offset }
      // Server-side filters only apply to the market-wide feed (GET /twaps/), not the per-user path.
      if (!args.address) {
        if (args.coin != null) query.coin = args.coin
        if (args.status != null) query.status = args.status
        if (args.hours != null) query.hours = args.hours
        if (args.order != null) query.order = args.order
      }
      const page = await hd.getApiList<unknown>(path, query)
      const pagination = offsetPagination(page, args.offset, limit)

      const meta: Record<string, unknown> = { source: path }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
      const totalCount = sanitizeTotalCount(page.meta.totalCount, page.data.length)
      if (totalCount != null) meta.total_count = totalCount

      const notes = [
        'Some `status` values may be error-prefixed strings (e.g. "error: ...") because the upstream status enum is incomplete.',
        'A `startTime` equal to the 1970 epoch-zero sentinel means "not yet started"; treat it as null rather than a real 1970 date.',
      ]

      return buildResult(
        { data: page.data, pagination, meta, notes },
        {
          summary: `TWAP orders${args.address ? ` for ${args.address}` : ''}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_twaps_stats',
    group: 'twaps',
    title: 'Hyperliquid TWAP aggregate stats',
    description:
      'Aggregate statistics across all TWAP orders (GET /twaps/stats): totals and breakdowns such ' +
      'as counts by status and by coin. Optionally scope the aggregate with `hours` (window length, ' +
      'default last 24h) and/or `coin` (single coin instead of all). Use this for a high-level overview ' +
      'before drilling into individual orders with hd_twaps_search or hd_twap_detail. Returns a single ' +
      'stats object.',
    inputSchema: {
      hours: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Aggregation window in hours (e.g. 24). Defaults to the endpoint default (last 24h) when omitted.',
        ),
      coin: coinSchema
        .optional()
        .describe(
          'Scope the aggregate to one coin (e.g. "BTC"). Defaults to all coins when omitted.',
        ),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = {}
      if (args.hours != null) query.hours = args.hours
      if (args.coin != null) query.coin = args.coin
      const { data } = await hd.getApiSingle<unknown>('/twaps/stats', query)
      return rawResult(
        data,
        'TWAP aggregate stats. Note: the `byStatus` breakdown may expose error-prefixed status strings (e.g. "error: ...") because the upstream status enum is incomplete.',
      )
    },
  }),

  defineTool({
    name: 'hd_twap_detail',
    group: 'twaps',
    title: 'Get one Hyperliquid TWAP order',
    description:
      'Fetch a single TWAP order by id (GET /twaps/{twap_id}), returning its full composite detail. ' +
      "Set include_fills=true to ALSO fetch the order's executed sub-order fills (GET /twaps/{twap_id}/fills, " +
      'offset-paginated up to 1000 per call). Without fills the response is `{ detail }`; with fills the ' +
      'order is returned under `meta.detail` and the fills become the paginated `data` list (page with ' +
      'pagination.next_offset, truncated to the response budget when large). An unknown id returns a 404 ' +
      'error from upstream.',
    inputSchema: {
      twap_id: z
        .union([z.string().trim().min(1), z.number().int().nonnegative()])
        .describe('The TWAP order id (path parameter). Required.'),
      include_fills: z
        .boolean()
        .default(false)
        .describe("Also fetch and merge the TWAP's executed sub-order fills."),
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const { data: detail } = await hd.getApiSingle<unknown>(`/twaps/${args.twap_id}`)

      if (!args.include_fills) {
        return rawResult({ detail }, `TWAP ${args.twap_id} detail.`)
      }

      const query: Query = { limit: args.limit, offset: args.offset }
      const fillsPage = await hd.getApiList<unknown>(`/twaps/${args.twap_id}/fills`, query)
      const pagination = offsetPagination(fillsPage, args.offset, args.limit)

      return buildResult(
        { data: fillsPage.data, pagination, meta: { detail } },
        {
          summary: `TWAP ${args.twap_id} detail with ${fillsPage.data.length} fill(s).`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
