import type { Query } from '../hypedexer/client.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { offsetPagination } from './shared/pagination.js'
import { addressSchema, limitSchema, offsetSchema, viewSchema, z } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Builder-code analytics (HypeDexer Data API, `APIResponse` envelope).
 *
 * Three tools cover the six `/builders/*` endpoints:
 *   hd_builders        -> /builders/top (leaderboard) + /builders/list (registry)
 *   hd_builder_stats   -> /builders/stats, /stats/all-timeframes, /{addr}/stats
 *   hd_builder_users   -> /builders/{addr}/users (top users per builder)
 *
 * Quirk handled here: `/builders/top` and `/builders/{addr}/users` ship their
 * list inside an object (`data: {timeframe, sort, builders[]}` /
 * `data: {timeframe, builder, users[]}`), so we fetch the wrapper with
 * `getApiSingle` and page the inner array. `/builders/list` is a flat array.
 */

const TIMEFRAMES = ['1h', '24h', '7d', '30d'] as const
const TOP_SORTS = ['volume', 'fees', 'builder_fees', 'fills', 'users'] as const

const timeframeField = z
  .enum(TIMEFRAMES)
  .optional()
  .describe('Aggregation window: "1h", "24h" (default upstream), "7d", or "30d".')

interface BuilderTopRow {
  builder: string
  builderName: string | null
  fillCount: number
  totalVolume: number
  totalFees: number
  totalBuilderFees: number
  uniqueUsers: number
  uniqueCoins: number
}

interface BuilderTopData {
  timeframe?: string
  sort?: string
  builders?: BuilderTopRow[]
}

interface BuilderListRow {
  address: string
  name: string | null
  referredBy: string | null
  referrerStage: string | null
}

interface BuilderUserRow {
  user: string
  fillCount: number
  totalVolume: number
  totalFees: number
  totalBuilderFees: number
  uniqueCoins: number
}

interface BuilderUsersData {
  timeframe?: string
  builder?: string
  users?: BuilderUserRow[]
}

export const buildersTools: ToolModule = [
  defineTool({
    name: 'hd_builders',
    group: 'builders',
    title: 'Hyperliquid builders',
    description:
      'List Hyperliquid builder-code operators. view="top" (default) returns the builder leaderboard ' +
      'for a timeframe, ranked by a sort metric (volume, fees, builder_fees, fills, or users), with ' +
      'per-builder fillCount/totalVolume/totalFees/totalBuilderFees/uniqueUsers/uniqueCoins; page it with ' +
      'limit (max 100) + offset via pagination.next_offset. view="list" returns the full registry of ' +
      '~640 builders (address, name, referredBy, referrerStage) in a single call with no pagination. ' +
      'timeframe, sort, limit, and offset apply to view="top" only and are ignored for view="list".',
    inputSchema: {
      view: viewSchema(
        ['top', 'list'],
        'top = ranked leaderboard (paged); list = full builder registry in one call.',
        'top',
      ),
      timeframe: timeframeField,
      sort: z
        .enum(TOP_SORTS)
        .optional()
        .describe('Leaderboard ranking metric (view="top"). Defaults upstream to "volume".'),
      limit: limitSchema(100),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)

      if (args.view === 'list') {
        const page = await hd.getApiList<BuilderListRow>('/builders/list')
        const meta: Record<string, unknown> = { source: '/builders/list' }
        if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
        return buildResult(
          { data: page.data, meta },
          { summary: 'Full builder registry.', maxTokens: ctx.config.maxResponseTokens },
        )
      }

      const query: Query = { limit: args.limit, offset: args.offset }
      if (args.timeframe !== undefined) query.timeframe = args.timeframe
      if (args.sort !== undefined) query.sort = args.sort

      const single = await hd.getApiSingle<BuilderTopData>('/builders/top', query)
      const builders = single.data.builders
      const rows = Array.isArray(builders) ? builders : []
      const pagination = offsetPagination(
        { data: rows, meta: single.meta },
        args.offset,
        args.limit,
      )

      const meta: Record<string, unknown> = { source: '/builders/top' }
      if (single.data.timeframe != null) meta.timeframe = single.data.timeframe
      if (single.data.sort != null) meta.sort = single.data.sort
      if (single.meta.executionMs != null) meta.execution_ms = single.meta.executionMs

      return buildResult(
        { data: rows, pagination, meta },
        {
          summary: `Top builders${single.data.timeframe != null ? ` (${single.data.timeframe})` : ''}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_builder_stats',
    group: 'builders',
    title: 'Hyperliquid builder stats',
    description:
      'Aggregate builder-fee statistics with current-vs-previous-period deltas. view="global" (default) ' +
      'returns market-wide builder stats for one timeframe (current/previous totals + variations percentages). ' +
      'view="all_timeframes" returns the same blocks keyed by 1h/24h/7d/30d in a single call. view="one" ' +
      'returns stats for a single builder address (REQUIRES address) and adds a per-coin breakdown. Note: any ' +
      'valid 0x address is queryable — an unknown/unregistered builder still returns 200 with builderName=null, ' +
      'and variations.*Pct fields are null when the previous period was zero. Returns the raw stats object.',
    inputSchema: {
      view: viewSchema(
        ['global', 'all_timeframes', 'one'],
        'global = market-wide one timeframe; all_timeframes = every timeframe at once; one = a single builder (needs address).',
        'global',
      ),
      address: addressSchema.optional().describe('Builder address. Required when view="one".'),
      timeframe: timeframeField,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = {}
      let path: string
      let summary: string

      if (args.view === 'one') {
        if (!args.address) {
          throw new Error(
            'view="one" requires `address` (the builder to look up). Provide a 0x address, or use view="global"/"all_timeframes".',
          )
        }
        path = `/builders/${args.address}/stats`
        summary = `Builder stats for ${args.address}.`
        if (args.timeframe !== undefined) query.timeframe = args.timeframe
      } else if (args.view === 'all_timeframes') {
        path = '/builders/stats/all-timeframes'
        summary = 'Builder stats across all timeframes.'
      } else {
        path = '/builders/stats'
        summary = 'Global builder stats.'
        if (args.timeframe !== undefined) query.timeframe = args.timeframe
      }

      const { data } = await hd.getApiSingle<unknown>(path, query)
      return rawResult(data, summary)
    },
  }),

  defineTool({
    name: 'hd_builder_users',
    group: 'builders',
    title: 'Builder top users',
    description:
      'Top trading users routed through a specific builder code, for a timeframe. Requires the builder ' +
      'address. Each row carries the user address with fillCount/totalVolume/totalFees/totalBuilderFees/uniqueCoins. ' +
      'Offset-paginated: page with limit + offset via pagination.next_offset.',
    inputSchema: {
      address: addressSchema.describe(
        'Builder address whose top users to list, 0x-prefixed 40 hex chars.',
      ),
      timeframe: timeframeField,
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { limit: args.limit, offset: args.offset }
      if (args.timeframe !== undefined) query.timeframe = args.timeframe

      const path = `/builders/${args.address}/users`
      const single = await hd.getApiSingle<BuilderUsersData>(path, query)
      const users = single.data.users
      const rows = Array.isArray(users) ? users : []
      const pagination = offsetPagination(
        { data: rows, meta: single.meta },
        args.offset,
        args.limit,
      )

      const meta: Record<string, unknown> = { source: path }
      if (single.data.timeframe != null) meta.timeframe = single.data.timeframe
      if (single.data.builder != null) meta.builder = single.data.builder
      if (single.meta.executionMs != null) meta.execution_ms = single.meta.executionMs

      return buildResult(
        { data: rows, pagination, meta },
        {
          summary: `Top users for builder ${args.address}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
