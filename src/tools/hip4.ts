import type { Page } from '../core/types.js'
import type { Query } from '../hypedexer/client.js'
import { notYetLiveNote, sanitizeTotalCount } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult } from './shared/output.js'
import { buildTimeQuery, offsetPagination } from './shared/pagination.js'
import {
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
 * HIP-4 outcome / prediction markets (HypeDexer Data API, Hip4 envelope).
 *
 * Every endpoint here is normalized with `getHip4`, whose `Page.meta.status` may
 * be `'not_yet_live'`. When it is, the underlying surface returns no rows today -
 * we attach a human note (via `notYetLiveNote`) so an empty array is never
 * mistaken for "no data found". All list endpoints are offset-paginated
 * (page with `offset`/`limit`); only `/hip4/fee-scales` returns its full list in
 * a single call.
 */

/** Common HIP-4 meta + not_yet_live note derivation for a Hip4 page. */
function hip4Meta(page: Page<unknown>): { meta: Record<string, unknown>; notes: string[] } {
  const meta: Record<string, unknown> = {}
  if (page.meta.status === 'not_yet_live') meta.status = page.meta.status
  if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
  const totalCount = sanitizeTotalCount(page.meta.totalCount, page.data.length)
  if (totalCount != null) meta.total_count = totalCount
  const note = notYetLiveNote(page.meta.status, page.meta.testnetDocs)
  return { meta, notes: note ? [note] : [] }
}

export const hip4Tools: ToolModule = [
  defineTool({
    name: 'hd_hip4_markets',
    group: 'hip4',
    title: 'HIP-4 outcome markets',
    description:
      'List HIP-4 outcome (prediction) markets - one row per market with its identifying metadata. ' +
      'This is the same data served by /hip4/outcomes (an alias). Offset-paginated: page with ' +
      'offset=pagination.next_offset while pagination.has_more is true. Note: a coin= filter is ' +
      'silently ignored upstream, so it is intentionally not exposed here - filter client-side instead.',
    inputSchema: {
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { limit: args.limit, offset: args.offset }
      const page = await hd.getHip4('/hip4/markets', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const { meta, notes } = hip4Meta(page)
      return buildResult(
        { data: page.data, pagination, meta, notes },
        { summary: 'HIP-4 outcome markets.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip4_questions',
    group: 'hip4',
    title: 'HIP-4 market questions',
    description:
      'List the questions backing HIP-4 outcome markets (the human-readable proposition each market resolves). ' +
      'Offset-paginated: page with offset=pagination.next_offset while pagination.has_more is true. ' +
      'Quirk: each row\'s `description` field is pipe-delimited ("a|b|c") rather than free text - split on "|" to read the parts.',
    inputSchema: {
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { limit: args.limit, offset: args.offset }
      const page = await hd.getHip4('/hip4/questions', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const { meta, notes } = hip4Meta(page)
      notes.push(
        'Each row\'s `description` is pipe-delimited ("a|b|c"); split on "|" to read the parts.',
      )
      return buildResult(
        { data: page.data, pagination, meta, notes },
        { summary: 'HIP-4 market questions.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip4_outcome_tokens',
    group: 'hip4',
    title: 'HIP-4 outcome tokens',
    description:
      'List the tradable outcome tokens for HIP-4 markets (the per-outcome spot instruments). ' +
      'Optionally filter to a single token by its spot handle via coin="@N" (this filter works on this endpoint). ' +
      'Offset-paginated: page with offset=pagination.next_offset while pagination.has_more is true.',
    inputSchema: {
      coin: coinSchema
        .optional()
        .describe('Filter to one outcome token by spot handle, e.g. "@290". Omit for all.'),
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { limit: args.limit, offset: args.offset }
      if (args.coin !== undefined) query.coin = args.coin
      const page = await hd.getHip4('/hip4/outcome-tokens', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const { meta, notes } = hip4Meta(page)
      return buildResult(
        { data: page.data, pagination, meta, notes },
        { summary: 'HIP-4 outcome tokens.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip4_fills',
    group: 'hip4',
    title: 'HIP-4 fills',
    description:
      'Executed trade fills on HIP-4 outcome markets. Optionally bound by a time window (start_time/end_time, ' +
      'ISO-8601 or epoch-ms - sent to the server as bare ISO dates). Each row carries an epoch-ms `time_ms` and a ' +
      '`feeToken` of "USDH" or a "+NNN" token id. Offset-paginated: page with offset=pagination.next_offset while ' +
      'pagination.has_more is true.',
    inputSchema: {
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit, offset: args.offset }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoBare',
        startKey: 'start',
        endKey: 'end',
      })
      const page = await hd.getHip4('/hip4/fills', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const { meta, notes } = hip4Meta(page)
      return buildResult(
        { data: page.data, pagination, meta, notes },
        { summary: 'HIP-4 fills.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip4_fees',
    group: 'hip4',
    title: 'HIP-4 fees',
    description:
      'Daily fee records for HIP-4 markets. Each row is keyed by a `date` in YYYY-MM-DD. Optionally bound by a ' +
      'time window (start_time/end_time, ISO-8601 or epoch-ms - sent as bare ISO dates). Offset-paginated: page ' +
      'with offset=pagination.next_offset while pagination.has_more is true.',
    inputSchema: {
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit, offset: args.offset }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoBare',
        startKey: 'start',
        endKey: 'end',
      })
      const page = await hd.getHip4('/hip4/fees', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const { meta, notes } = hip4Meta(page)
      return buildResult(
        { data: page.data, pagination, meta, notes },
        { summary: 'HIP-4 daily fees.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip4_settlements',
    group: 'hip4',
    title: 'HIP-4 settlements',
    description:
      'Settlement events for resolved HIP-4 outcome markets. Optionally bound by a time window (start_time/end_time, ' +
      'ISO-8601 or epoch-ms - sent as bare ISO dates). Offset-paginated: page with offset=pagination.next_offset ' +
      'while pagination.has_more is true. Quirk: rows can be duplicated; de-duplicate on the (outcome_id, nonce) pair.',
    inputSchema: {
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit, offset: args.offset }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoBare',
        startKey: 'start',
        endKey: 'end',
      })
      const page = await hd.getHip4('/hip4/settlements', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const { meta, notes } = hip4Meta(page)
      notes.push('Rows may be duplicated; de-duplicate on the (outcome_id, nonce) pair.')
      return buildResult(
        { data: page.data, pagination, meta, notes },
        { summary: 'HIP-4 settlements.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip4_analytics',
    group: 'hip4',
    title: 'HIP-4 analytics',
    description:
      'Aggregated analytics rows for HIP-4 markets, each carrying a `bucket` timestamp. Optionally choose the bucket ' +
      'granularity with interval (1h/4h/1d; the server applies a default when omitted), and filter by coin (integer ' +
      'csv, e.g. "290,291") and/or outcome_id. Optionally bound by a time window (start_time/end_time, ISO-8601 or ' +
      'epoch-ms - sent as bare ISO dates). Offset-paginated with a higher cap (up to 2000 per page): page with ' +
      'offset=pagination.next_offset while pagination.has_more is true.',
    inputSchema: {
      interval: z
        .enum(['1h', '4h', '1d'])
        .optional()
        .describe('Bucket granularity for analytics aggregation.'),
      coin: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Filter analytics to one or more coins by integer id, comma-separated (e.g. "290,291").',
        ),
      outcome_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Filter analytics to a specific outcome by its id.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(2000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.interval !== undefined) query.interval = args.interval
      if (args.coin !== undefined) query.coin = args.coin
      if (args.outcome_id !== undefined) query.outcome_id = args.outcome_id
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoBare',
        startKey: 'start',
        endKey: 'end',
      })
      const page = await hd.getHip4('/hip4/analytics', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const { meta, notes } = hip4Meta(page)
      return buildResult(
        { data: page.data, pagination, meta, notes },
        { summary: 'HIP-4 analytics.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_hip4_preview',
    group: 'hip4',
    title: 'HIP-4 preview surfaces (fee scales / user actions)',
    description:
      'Access the two preview HIP-4 surfaces, selected by `view`: "fee_scales" -> GET /hip4/fee-scales (the full ' +
      'fee-scale list in one call, no paging) or "user_actions" -> GET /hip4/user-actions (offset-paginated, page ' +
      'with offset=pagination.next_offset). Both surfaces are NOT yet live on mainnet today and return an empty ' +
      'list - an explanatory note is attached so the empty result is understood as expected, not an error.',
    inputSchema: {
      view: viewSchema(
        ['fee_scales', 'user_actions'],
        'fee_scales = full fee-scale list (none-list); user_actions = paginated user-action feed.',
        'fee_scales',
      ),
      limit: limitSchema(1000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'fee_scales') {
        const page = await hd.getHip4('/hip4/fee-scales')
        const { meta, notes } = hip4Meta(page)
        return buildResult(
          { data: page.data, meta, notes },
          { summary: 'HIP-4 fee scales.', maxTokens: ctx.config.maxResponseTokens },
        )
      }
      const query: Query = { limit: args.limit, offset: args.offset }
      const page = await hd.getHip4('/hip4/user-actions', query)
      const pagination = offsetPagination(page, args.offset, args.limit)
      const { meta, notes } = hip4Meta(page)
      return buildResult(
        { data: page.data, pagination, meta, notes },
        { summary: 'HIP-4 user actions.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),
]
