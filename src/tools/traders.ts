import type { Page } from '../core/types.js'
import type { Query } from '../hypedexer/client.js'
import { nullifyEpochSentinel, sanitizeTotalCount } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { buildTimeQuery, offsetPagination } from './shared/pagination.js'
import {
  addressSchema,
  coinSchema,
  endTimeSchema,
  limitSchema,
  offsetSchema,
  startTimeSchema,
  viewSchema,
  z,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Trader-centric views over the HypeDexer Data API (`hd_*`, APIResponse envelope):
 * per-user account profiles, per-coin aggregates, the global trader leaderboard,
 * the active-trader feed, and the completed-trades (round-trip) surface with its
 * per-trade fill breakdown. All read-only.
 */

/** Lookback window shared by the leaderboard and active-trader feeds (server caps at 168h, defaults to 1h). */
const hoursSchema = z
  .number()
  .int()
  .min(1)
  .max(168)
  .optional()
  .describe('Lookback window in hours (1-168). Omit to use the server default of 1 hour.')

/** Standard list meta: source path, execution time, and a sanitized total_count (dropped when it merely echoes the page size). */
function listMeta(page: Page<unknown>, source: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { source }
  if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
  const total = sanitizeTotalCount(page.meta.totalCount, page.data.length)
  if (total != null) meta.total_count = total
  return meta
}

export const tradersTools: ToolModule = [
  defineTool({
    name: 'hd_user_profile',
    group: 'traders',
    title: 'Trader account profile',
    description:
      'A single trader\'s account profile. view="overview" (default) returns headline account stats ' +
      '(volume, fills, fees, last_activity, etc.); view="performance" returns trading-quality metrics ' +
      '(win rate, profit factor, avg win/loss, max drawdown, avg holding time, total PnL). Requires the ' +
      'wallet `user`. Optionally scope to a time window with start_time/end_time. Returns one object (not a list). ' +
      'Caveats: an invalid/never-active address still returns 200 with all-zero fields (validate the address ' +
      'before trusting zeros); a "never" last_activity is normalized to null; total_priority_gas is always 0; ' +
      'performance.avg_holding_time_s is inflated upstream (it counts never-closed positions).',
    inputSchema: {
      user: addressSchema,
      view: viewSchema(
        ['overview', 'performance'],
        'overview = headline account stats; performance = trading-quality metrics (win rate, PnL, drawdown).',
        'overview',
      ),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query = buildTimeQuery(
        {},
        {
          start: args.start_time,
          end: args.end_time,
          target: 'isoSnake',
          startKey: 'start_time',
          endKey: 'end_time',
        },
      )
      const path =
        args.view === 'performance'
          ? `/users/${args.user}/performance`
          : `/users/${args.user}/overview`

      const { data } = await hd.getApiSingle<Record<string, unknown>>(path, query)
      let out: unknown = data
      if (data && typeof data === 'object' && 'last_activity' in data) {
        out = {
          ...data,
          last_activity: nullifyEpochSentinel(data.last_activity as string | number | null),
        }
      }

      const summary =
        args.view === 'performance'
          ? `Performance metrics for ${args.user}. Note: avg_holding_time_s is inflated (includes never-closed positions).`
          : `Account overview for ${args.user}. Note: an unknown/never-active address returns 200 with zeroed fields, and total_priority_gas is always 0.`
      return rawResult(out, summary)
    },
  }),

  defineTool({
    name: 'hd_user_coins',
    group: 'traders',
    title: 'Trader per-coin breakdown',
    description:
      'Per-coin trading aggregates for one trader: for each coin traded, total volume, fill count, fees, ' +
      'average price, price range, and total PnL. Requires the wallet `user`. Optionally scope to a time window. ' +
      'Offset-paginated (cap 100/page): when pagination.has_more is true, call again with offset=pagination.next_offset.',
    inputSchema: {
      user: addressSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(100),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit, offset: args.offset }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const path = `/users/${args.user}/coins`
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        {
          summary: `Per-coin breakdown for ${args.user}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_traders_leaderboard',
    group: 'traders',
    title: 'Trader leaderboard',
    description:
      'Top traders ranked by a chosen metric over a recent window. Requires `by` — the ranking key, which also ' +
      'shapes each row: "volume" (total_volume, fill_count, unique_coins), "pnl" (total_pnl, trade_count), ' +
      '"trades" (fill_count, total_volume), or "priority_fees" (total_priority_gas, fill_count). An unrecognized ' +
      '`by` is rejected with a 422. Set `hours` (1-168, default 1) for the window and `limit` (cap 100) for the size. ' +
      'Returns a single ranked page (not paginated).',
    inputSchema: {
      by: z
        .string()
        .trim()
        .min(1)
        .describe(
          'Ranking key. Known values: "volume", "pnl", "trades", "priority_fees". Bogus values 422.',
        ),
      hours: hoursSchema,
      limit: limitSchema(100),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { by: args.by, limit: args.limit }
      if (args.hours !== undefined) query.hours = args.hours
      const path = '/users/leaderboard'
      const page = await hd.getApiList(path, query)
      return buildResult(
        { data: page.data, meta: listMeta(page, path) },
        { summary: `Trader leaderboard by ${args.by}.`, maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_traders_active',
    group: 'traders',
    title: 'Recently active traders',
    description:
      'Traders active in the recent window, each with fill_count, total_volume, unique_coins, and last_activity. ' +
      'Set `hours` (1-168, default 1) for the window and `limit` (cap 100) for the page size. Offset-paginated: ' +
      'when pagination.has_more is true, call again with offset=pagination.next_offset.',
    inputSchema: {
      hours: hoursSchema,
      limit: limitSchema(100),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { limit: args.limit, offset: args.offset }
      if (args.hours !== undefined) query.hours = args.hours
      const path = '/users/active'
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        { summary: 'Recently active traders.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_completed_trades_search',
    group: 'traders',
    title: 'Search completed (round-trip) trades',
    description:
      'Completed round-trip trades (entry-to-exit) across the market. view="list" (default) returns individual ' +
      'trades; view="summary" returns aggregate stats over the same filters as one object. Optionally filter by ' +
      '`coin`, a time window, and (list only) `sort_by`. The list is offset-paginated — page with ' +
      'offset=pagination.next_offset. Notes: this endpoint has NO server-side limit cap, so `limit` is clamped to ' +
      '1000 (default 100) here to protect the response budget; an unrecognized `sort_by` is silently ignored ' +
      'upstream (falls back to the default sort); summary.avg_pnl_pct is in percent units and summary.avg_duration_s ' +
      'is inflated.',
    inputSchema: {
      view: viewSchema(
        ['list', 'summary'],
        'list = individual completed trades (paginated); summary = aggregate stats for the same filters.',
        'list',
      ),
      coin: coinSchema
        .optional()
        .describe('Filter by asset symbol. An unknown coin returns an empty result (200).'),
      sort_by: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'List-only sort key (e.g. "pnl", "time", "volume", "duration"). Unrecognized values fall back silently.',
        ),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000, 100),
      offset: offsetSchema,
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

      if (args.view === 'summary') {
        const { data } = await hd.getApiSingle<unknown>('/completed-trades/summary', query)
        return rawResult(
          data,
          `Completed-trades summary${args.coin ? ` for ${args.coin}` : ''}. Note: avg_pnl_pct is in percent units and avg_duration_s is inflated.`,
        )
      }

      query.limit = args.limit
      query.offset = args.offset
      if (args.sort_by !== undefined) query.sort_by = args.sort_by
      const path = '/completed-trades/'
      const page = await hd.getApiList(path, query)
      const notes: string[] = []
      if (args.sort_by !== undefined) {
        notes.push(
          'An unrecognized sort_by is ignored upstream (the result falls back to the default sort).',
        )
      }
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
          notes,
        },
        {
          summary: `Completed trades${args.coin ? ` for ${args.coin}` : ''}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_completed_trade_fills',
    group: 'traders',
    title: 'Fills for one completed trade',
    description:
      'The individual fills that compose one completed (round-trip) trade. Requires `trade_id` (the string id from ' +
      'hd_completed_trades_search, e.g. "trade_hyna:BTC_858bdd2c"; it may contain ":" and is URL-encoded for you). ' +
      'Returns a single list of fills (not paginated). Notes: an unknown trade_id returns 200 with an empty list ' +
      '(no 404), so an empty result may just mean the id was not found; the `feeUsdc` and `typeTrade` fields are ' +
      'mis-mapped upstream on this endpoint and should not be trusted.',
    inputSchema: {
      trade_id: z
        .string()
        .trim()
        .min(1)
        .describe('Completed-trade id (may contain ":"), e.g. "trade_hyna:BTC_858bdd2c".'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const path = `/completed-trades/${encodeURIComponent(args.trade_id)}/fills`
      const page = await hd.getApiList(path)
      // The feeUsdc and typeTrade fields are corrupt (shifted keys) on this endpoint; drop them.
      const data = (page.data as Record<string, unknown>[]).map(
        ({ feeUsdc, typeTrade, ...rest }) => rest,
      )
      return buildResult(
        {
          data,
          meta: listMeta(page, path),
          notes: [
            'An unknown trade_id returns 200 with an empty list (no 404).',
            'The feeUsdc and typeTrade fields are mis-mapped upstream on this endpoint and have been dropped; use fee and feeToken instead.',
          ],
        },
        {
          summary: `Fills for completed trade ${args.trade_id}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
