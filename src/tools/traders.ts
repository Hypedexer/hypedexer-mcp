import type { Page } from '../core/types.js'
import type { Query } from '../hypedexer/client.js'
import { fromApiList } from '../hypedexer/envelope.js'
import { nullifyEpochSentinel, sanitizeTotalCount } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { type PaginationOut, buildTimeQuery, offsetPagination } from './shared/pagination.js'
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

/** Lookback window shared by the leaderboard (live mode) and active-trader feeds (server caps at 168h). */
const hoursSchema = z
  .number()
  .int()
  .min(1)
  .max(168)
  .optional()
  .describe('Lookback window in hours (1-168). Omit for the server default (24 hours).')

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
      'One trader, one `view` (all need the wallet `user`):\n' +
      '- overview (default): headline account stats (volume, fills, fees, last_activity). start_time/end_time optional.\n' +
      '- performance: round-trip statistics (win rate, total PnL, volume, avg holding time, long/short ratio, profit ' +
      'factor, best/worst trade, realized max_drawdown, equity_max_drawdown_usd/pct). `window` 7d (default) | 30d | ' +
      '90d | all; start_time/end_time override it (window then reads "custom"). Round trips from 2025-09-10.\n' +
      '- account: latest hourly snapshot of the perp account: account_value, cash, position_value, unrealized_pnl, ' +
      'account_leverage, funding_all_time and every open position with leverage, leverage_type, entry/mark px, roe.\n' +
      '- equity_history: perp account value over time (`window`, `interval` 1h | 1d) with a summary (change, max ' +
      'drawdown). Spot and HIP-3 excluded; snapshots from 2026-09-06.\n' +
      '- pnl_calendar: one row per trading day (realized_pnl, fees, funding, net_pnl, cumulative_net_pnl, fills, ' +
      'volume, equity_close) plus totals with profitable/losing days. `window` default 30d here; fills from 2024-03-15.\n' +
      '- top_trades: best round trips (`sort` pnl | pnl_abs | notional | loss, `limit` 1-50, `window` default all, ' +
      '`include_open` default true ranks open positions by unrealized PnL). Leverage null before 2026-09-06.\n' +
      'Returns one object. Caveats: an invalid/never-active address still returns 200 with zeroed fields; a "never" ' +
      'last_activity is normalized to null; overview total_priority_gas is always 0; performance total_fees and ' +
      'total_funding read 0 live; avg_holding_time_s runs high (never-closed positions count).',
    inputSchema: {
      user: addressSchema,
      view: viewSchema(
        ['overview', 'performance', 'account', 'equity_history', 'pnl_calendar', 'top_trades'],
        'Which profile view.',
        'overview',
      ),
      window: z
        .enum(['7d', '30d', '90d', 'all'])
        .optional()
        .describe(
          'performance / equity_history (default 7d), pnl_calendar (default 30d), top_trades (default all).',
        ),
      interval: z.enum(['1h', '1d']).optional().describe('view=equity_history: default 1h.'),
      sort: z
        .enum(['pnl', 'pnl_abs', 'notional', 'loss'])
        .optional()
        .describe('view=top_trades: ranking (default pnl).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('view=top_trades: number of trades (1-50, default 5).'),
      include_open: z
        .boolean()
        .optional()
        .describe('view=top_trades: rank open positions too (default true).'),
      start_time: startTimeSchema.describe('view=overview|performance: window start.'),
      end_time: endTimeSchema.describe('view=overview|performance: window end.'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = {}
      if (args.view === 'overview' || args.view === 'performance') {
        query = buildTimeQuery(query, {
          start: args.start_time,
          end: args.end_time,
          target: 'isoSnake',
          startKey: 'start_time',
          endKey: 'end_time',
        })
      }
      if (args.window !== undefined && args.view !== 'overview' && args.view !== 'account')
        query.window = args.window
      if (args.view === 'equity_history' && args.interval !== undefined)
        query.interval = args.interval
      if (args.view === 'top_trades') {
        if (args.sort !== undefined) query.sort = args.sort
        if (args.limit !== undefined) query.limit = args.limit
        if (args.include_open !== undefined) query.include_open = args.include_open
      }
      const segment = {
        overview: 'overview',
        performance: 'performance',
        account: 'account',
        equity_history: 'equity-history',
        pnl_calendar: 'pnl-calendar',
        top_trades: 'top-trades',
      }[args.view]
      const path = `/users/${args.user}/${segment}`

      const { data } = await hd.getApiSingle<Record<string, unknown>>(path, query)
      let out: unknown = data
      if (data && typeof data === 'object' && 'last_activity' in data) {
        out = {
          ...data,
          last_activity: nullifyEpochSentinel(data.last_activity as string | number | null),
        }
      }

      const summaries: Record<string, string> = {
        overview: `Account overview for ${args.user}. Note: an unknown/never-active address returns 200 with zeroed fields, and total_priority_gas is always 0.`,
        performance: `Performance metrics for ${args.user}. Note: avg_holding_time_s runs high (includes never-closed positions).`,
        account: `Latest account snapshot for ${args.user}.`,
        equity_history: `Equity history for ${args.user}.`,
        pnl_calendar: `Daily PnL calendar for ${args.user}.`,
        top_trades: `Top trades for ${args.user}.`,
      }
      return rawResult(out, summaries[args.view] ?? '', {
        maxTokens: ctx.config.maxResponseTokens,
      })
    },
  }),

  defineTool({
    name: 'hd_users_batch_performance',
    group: 'traders',
    title: 'Performance for many wallets',
    description:
      'Round-trip performance stats (same fields as hd_user_profile view=performance) for up to 500 wallets in one ' +
      'call (POST /users/batch/performance), one entry per address in submission order; duplicates are ignored. ' +
      '`window` 7d (default) | 30d | 90d | all. include_drawdown=true adds max_drawdown on the realized-PnL curve ' +
      '(equity drawdown is not computed in batch). Costs 3 credits per wallet.',
    inputSchema: {
      users: z.array(addressSchema).min(1).max(500).describe('1 to 500 wallet addresses.'),
      window: z.enum(['7d', '30d', '90d', 'all']).optional().describe('Default 7d.'),
      include_drawdown: z
        .boolean()
        .optional()
        .describe('Add realized max_drawdown (default false).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const body: Record<string, unknown> = { users: args.users }
      if (args.window !== undefined) body.window = args.window
      if (args.include_drawdown !== undefined) body.include_drawdown = args.include_drawdown
      const raw = await hd.post<unknown>('/users/batch/performance', body)
      const page = fromApiList<unknown>(raw)
      return buildResult(
        { data: page.data, meta: listMeta(page, '/users/batch/performance') },
        {
          summary: `Batch performance for ${args.users.length} wallet(s).`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_user_coins',
    group: 'traders',
    title: 'Trader per-coin breakdown',
    description:
      'Per-coin trading aggregates for one trader: for each coin traded, total volume, fill count, fees, ' +
      'average price, price range, and total PnL, highest volume first. Requires the wallet `user`. Optionally ' +
      'scope to a time window. Returns the top `limit` coins (max 100) in one page: the endpoint has no paging ' +
      '(an offset is ignored upstream), so for a full per-coin split use hd_user_coin_distribution.',
    inputSchema: {
      user: addressSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(100),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit }
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
        { data: page.data, meta: listMeta(page, path) },
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
      'Traders ranked by `by` (default volume). Two modes:\n' +
      '- window mode (`window` 7d | 30d | all): pre-computed ranking over every address, paged with `page` and ' +
      '`limit` up to 500; rows carry fill_count, total_volume, realized_pnl, fees, total_pnl, trade_count, wins, ' +
      'losses, win_rate, pnl_pct, unrealized_pnl, account_value, rank. 7d/30d refresh every 5 minutes, all every ' +
      'hour; all covers fills since 2025-03-22. by=win_rate / pnl_pct need `min_trades` round trips (default 10). ' +
      'Page with page=pagination.next_page.\n' +
      '- live mode (no window): last `hours` hours (1-168, documented default 24), top 100 max, by volume | pnl | ' +
      'trades | priority_fees only.\n' +
      'win_rate, pnl_pct and unrealized_pnl require window mode.',
    inputSchema: {
      by: z
        .enum(['volume', 'pnl', 'trades', 'win_rate', 'pnl_pct', 'unrealized_pnl', 'priority_fees'])
        .optional()
        .describe('Ranking metric (default volume).'),
      window: z
        .enum(['7d', '30d', 'all'])
        .optional()
        .describe('Window mode ranking; omit for live mode over `hours`.'),
      page: z.number().int().min(1).optional().describe('Window mode page (default 1).'),
      min_trades: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Window mode, by=win_rate|pnl_pct: minimum round trips (default 10).'),
      hours: hoursSchema.describe('Live mode lookback in hours (1-168, documented default 24).'),
      limit: limitSchema(500).describe(
        'Rows (window mode max 500, live mode max 100; default 50).',
      ),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { limit: args.window ? args.limit : Math.min(args.limit, 100) }
      if (args.by !== undefined) query.by = args.by
      if (args.window !== undefined) {
        query.window = args.window
        if (args.page !== undefined) query.page = args.page
        if (args.min_trades !== undefined) query.min_trades = args.min_trades
      } else if (args.hours !== undefined) query.hours = args.hours
      const path = '/users/leaderboard'
      const page = await hd.getApiList(path, query)
      const meta = listMeta(page, path)
      if (args.window !== undefined && page.meta.totalCount != null)
        meta.total_count = page.meta.totalCount
      const pagination: PaginationOut = {
        returned: page.data.length,
        has_more: Boolean(page.meta.hasMore),
      }
      const nextPage = Number(page.meta.nextCursor)
      if (args.window !== undefined && page.meta.hasMore && Number.isInteger(nextPage)) {
        pagination.next_page = nextPage
        pagination.hint = 'More ranks exist. Call again with page=pagination.next_page.'
      }
      return buildResult(
        { data: page.data, pagination, meta },
        {
          summary: `Trader leaderboard by ${args.by ?? 'volume'}${args.window ? ` over ${args.window}` : ''}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_traders_active',
    group: 'traders',
    title: 'Recently active traders',
    description:
      'Most active traders in the recent window, each with fill_count, total_volume, unique_coins, and ' +
      'last_activity. Set `hours` (1-168, default 24) for the window and `limit` (cap 100) for the size. ' +
      'Returns one ranked page: the endpoint has no paging (an offset is ignored upstream).',
    inputSchema: {
      hours: hoursSchema.describe('Lookback window in hours (1-168, default 24).'),
      limit: limitSchema(100),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { limit: args.limit }
      if (args.hours !== undefined) query.hours = args.hours
      const path = '/users/active'
      const page = await hd.getApiList(path, query)
      return buildResult(
        { data: page.data, meta: listMeta(page, path) },
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
      'trades; view="summary" returns aggregate stats over the same filters as one object (with no time window ' +
      'it covers all history). Filters: `user`, `coin`, `direction` (long|short), a time window, and (list only) ' +
      '`min_pnl`/`max_pnl`, `sort_by` (a row field, default end_time, e.g. "pnl_realized") and `sort_dir` (ASC|DESC, ' +
      'default DESC). The list defaults to the last 24h when no time filter is given and is offset-paginated - ' +
      'page with offset=pagination.next_offset. Notes: this endpoint has NO server-side limit cap, so `limit` is ' +
      'clamped to 1000 (default 100) here to protect the response budget; an unrecognized `sort_by` is silently ' +
      'ignored upstream (falls back to the default sort); summary.avg_pnl_pct is in percent units and ' +
      'summary.avg_duration_s is inflated. Spot pairs are not covered (coin "@N" returns 0 trades).',
    inputSchema: {
      view: viewSchema(
        ['list', 'summary'],
        'list = individual completed trades (paginated); summary = aggregate stats for the same filters.',
        'list',
      ),
      user: addressSchema.optional().describe('Only this trader.'),
      coin: coinSchema
        .optional()
        .describe('Filter by asset symbol. An unknown coin returns an empty result (200).'),
      direction: z.enum(['long', 'short']).optional().describe('Only long or short round trips.'),
      min_pnl: z.number().optional().describe('List only: minimum pnl_realized.'),
      max_pnl: z.number().optional().describe('List only: maximum pnl_realized.'),
      sort_by: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'List-only sort key: a row field such as "end_time" (default) or "pnl_realized". Unrecognized values fall back silently.',
        ),
      sort_dir: z
        .enum(['ASC', 'DESC'])
        .optional()
        .describe('List-only sort direction (default DESC).'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000, 100),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = {}
      if (args.user !== undefined) query.user = args.user
      if (args.coin !== undefined) query.coin = args.coin
      if (args.direction !== undefined) query.direction = args.direction
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
      if (args.sort_dir !== undefined) query.sort_dir = args.sort_dir
      if (args.min_pnl !== undefined) query.min_pnl = args.min_pnl
      if (args.max_pnl !== undefined) query.max_pnl = args.max_pnl
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
