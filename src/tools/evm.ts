import type { Page } from '../core/types.js'
import type { Query } from '../hypedexer/client.js'
import { sanitizeTotalCount } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { buildTimeQuery, offsetPagination } from './shared/pagination.js'
import {
  addressSchema,
  endTimeSchema,
  limitSchema,
  offsetSchema,
  startTimeSchema,
  viewSchema,
  z,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * HyperEVM indexed data (HypeDexer Data API, APIResponse envelope).
 *
 * Eight tools over the `/evm/*` surface: chain stats, blocks + per-block
 * transactions, the global transaction/log feeds, the L1<->EVM ledger and bridge
 * event streams, per-user ledger views, and the HIP-3 backstop tables. Every
 * endpoint shares the `APIResponse<T>` envelope (`getApiList` / `getApiSingle`)
 * and is offset-paginated — there is no cursor anywhere under `/evm`. Time
 * filters are sent as ISO-8601 snake_case (`start_time`/`end_time`); epoch-ms is
 * silently ignored upstream, so always pass ISO timestamps.
 */

/** All EVM list endpoints cap `limit` at 1000 (>1000 → 422). */
const EVM_LIMIT_CAP = 1000

/** Strictly-enforced ledger-event enum on /evm/user/{address}/ledger-events. */
const LEDGER_EVENT_TYPES = [
  'deposit',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'class_transfer',
  'sub_account',
  'vault',
  'agent_send',
] as const

/** Standard APIResponse list meta: source path, execution time, sanitized total_count (null across EVM). */
function listMeta(page: Page<unknown>, source: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { source }
  if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
  const total = sanitizeTotalCount(page.meta.totalCount, page.data.length)
  if (total != null) meta.total_count = total
  return meta
}

export const evmTools: ToolModule = [
  defineTool({
    name: 'hd_evm_stats',
    group: 'evm',
    title: 'HyperEVM chain stats',
    description:
      'Headline indexer stats for the HyperEVM chain. view="current" (default) returns a single snapshot ' +
      '(total_blocks, total_transactions, total_logs, first/last block + their times) as one object. ' +
      'view="daily" returns a per-day time series (one row per day: blocks, transactions, system_txs, gas_used) ' +
      'for the last `days` days (1-365, default 30); that list is returned in one call (not paginated).',
    inputSchema: {
      view: viewSchema(
        ['current', 'daily'],
        'current = single live snapshot; daily = per-day time series for the last `days` days.',
        'current',
      ),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe('Daily view only: number of past days to return (1-365, default 30).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'current') {
        const { data } = await hd.getApiSingle<unknown>('/evm/stats')
        return rawResult(data, 'Current HyperEVM chain stats.')
      }
      const path = '/evm/stats/daily'
      const page = await hd.getApiList(path, { days: args.days })
      return buildResult(
        { data: page.data, meta: listMeta(page, path) },
        {
          summary: `Daily HyperEVM stats for the last ${args.days} day(s).`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_evm_blocks',
    group: 'evm',
    title: 'HyperEVM blocks',
    description:
      'HyperEVM block data, with three modes selected by your inputs. (1) Omit block_number -> the recent block ' +
      'list, offset-paginated (page with offset=pagination.next_offset). Optionally bound it by an inclusive ' +
      'block-number range (start_block/end_block) and/or a time window (start_time/end_time, ISO-8601). ' +
      '(2) Pass block_number alone -> that single block record (one object; an unknown block 404s). ' +
      '(3) Pass block_number with transactions=true -> the transactions in that block, offset-paginated. ' +
      'Caps: limit up to 1000.',
    inputSchema: {
      block_number: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Target one block. Alone -> that block record; with transactions=true -> its transactions; omit -> the block list.',
        ),
      transactions: z
        .boolean()
        .default(false)
        .describe(
          "Only meaningful with block_number: true returns that block's transactions instead of the block record.",
        ),
      start_block: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Block-list only: inclusive lower bound block number.'),
      end_block: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Block-list only: inclusive upper bound block number.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(EVM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)

      // Mode 2: single block record.
      if (args.block_number !== undefined && !args.transactions) {
        const { data } = await hd.getApiSingle<unknown>(`/evm/blocks/${args.block_number}`)
        return rawResult(data, `HyperEVM block ${args.block_number}.`)
      }

      // Mode 3: transactions in a specific block (no time params on this sub-path).
      if (args.block_number !== undefined && args.transactions) {
        const path = `/evm/blocks/${args.block_number}/transactions`
        const query: Query = { limit: args.limit, offset: args.offset }
        const page = await hd.getApiList(path, query)
        return buildResult(
          {
            data: page.data,
            pagination: offsetPagination(page, args.offset, args.limit),
            meta: listMeta(page, path),
          },
          {
            summary: `Transactions in HyperEVM block ${args.block_number}.`,
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }

      // Mode 1: block list with optional range + time filters.
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.start_block !== undefined) query.start_block = args.start_block
      if (args.end_block !== undefined) query.end_block = args.end_block
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const path = '/evm/blocks'
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        { summary: 'HyperEVM blocks.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_evm_transactions',
    group: 'evm',
    title: 'HyperEVM transactions',
    description:
      'The HyperEVM transaction feed (one row per indexed tx: block_time, block_number, tx_index, tx_type, ' +
      'to_addr, value_wei, gas, success, etc.). Optionally bound by a time window (start_time/end_time, ISO-8601). ' +
      'Offset-paginated: page with offset=pagination.next_offset while pagination.has_more is true. Cap: limit up ' +
      "to 1000. To list one block's transactions instead, use hd_evm_blocks with block_number + transactions=true.",
    inputSchema: {
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(EVM_LIMIT_CAP),
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
      const path = '/evm/transactions'
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
          notes: [
            'Data quirk: `tx_hash` and `from_addr` are empty strings in current data (the indexer does not populate them); reference a tx by its (block_number, tx_index) pair instead.',
            'Time filters only honor ISO-8601; epoch-ms is silently ignored (falls back to no filter), so pass ISO timestamps.',
          ],
        },
        { summary: 'HyperEVM transactions.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_evm_logs',
    group: 'evm',
    title: 'HyperEVM event logs',
    description:
      'The HyperEVM event-log feed (one row per emitted log: block_time, block_number, tx_index, log_index, ' +
      'contract address, topic0-topic3, data). Optionally bound by a time window (start_time/end_time, ISO-8601). ' +
      'Offset-paginated: page with offset=pagination.next_offset while pagination.has_more is true. Cap: limit up to 1000.',
    inputSchema: {
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(EVM_LIMIT_CAP),
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
      const path = '/evm/logs'
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
          notes: [
            'Data quirk: absent topics (topic1/topic2/topic3) are empty strings "", not null — treat "" as "no topic".',
          ],
        },
        { summary: 'HyperEVM event logs.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_evm_transfers',
    group: 'evm',
    title: 'HyperEVM ledger transfers',
    description:
      'The L1<->EVM ledger transfer stream (one row per ledger action: time, action_type, user_from, user_to, ' +
      'token, amount / amount_raw, source/destination dex). Optionally bound by a time window (start_time/end_time, ' +
      'ISO-8601). Offset-paginated: page with offset=pagination.next_offset while pagination.has_more is true. Cap: ' +
      'limit up to 1000.',
    inputSchema: {
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(EVM_LIMIT_CAP),
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
      const path = '/evm/ledger/transfers'
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
          notes: [
            'Data quirk: `block_height` is always 0 (placeholder/unused).',
            'If you filter by action_type, an unrecognized value silently returns an empty list (200), not an error.',
          ],
        },
        { summary: 'HyperEVM ledger transfers.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_evm_bridge_events',
    group: 'evm',
    title: 'HyperEVM bridge events',
    description:
      'The HyperEVM bridge event stream (one row per bridge action: time, event_type, user_addr, validator, amount, ' +
      'destination, nonce, raw). Optionally bound by a time window (start_time/end_time, ISO-8601). Offset-paginated: ' +
      'page with offset=pagination.next_offset while pagination.has_more is true. Cap: limit up to 1000.',
    inputSchema: {
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(EVM_LIMIT_CAP),
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
      const path = '/evm/bridge/events'
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
          notes: [
            'If you filter by event_type, an unrecognized value silently returns an empty list (200), not an error.',
            '`nonce` is a large integer near the JS safe-integer edge; treat it as opaque if you need exactness.',
          ],
        },
        { summary: 'HyperEVM bridge events.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_evm_user',
    group: 'evm',
    title: 'HyperEVM per-user ledger',
    description:
      'One trader\'s HyperEVM ledger, selected by `view`. view="ledger_events" (default) returns the per-user ' +
      'ledger event stream (incoming + outgoing, with counterparty, token, amount, tx_hash) — offset-paginated ' +
      '(page with offset=pagination.next_offset) and filterable by a single `event_type` and/or a time window ' +
      '(start_time/end_time, ISO-8601). view="ledger_summary" returns aggregates per action type ' +
      '(count, total_amount, tokens[]) in one call (not paginated; handy for token discovery). REQUIRES `address`. ' +
      'Cap: limit up to 1000. The endpoint also accepts several event_type values at once upstream; this tool ' +
      'filters by one, so call once per type and merge if you need a union.',
    inputSchema: {
      address: addressSchema,
      view: viewSchema(
        ['ledger_events', 'ledger_summary'],
        'ledger_events = per-user event stream (paginated); ledger_summary = per-action-type aggregates.',
        'ledger_events',
      ),
      event_type: z
        .enum(LEDGER_EVENT_TYPES)
        .optional()
        .describe(
          'ledger_events only: restrict to one event type. Strictly validated upstream (an invalid value 422s).',
        ),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(EVM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)

      if (args.view === 'ledger_summary') {
        const path = `/evm/user/${args.address}/ledger-summary`
        const page = await hd.getApiList(path)
        return buildResult(
          { data: page.data, meta: listMeta(page, path) },
          {
            summary: `HyperEVM ledger summary for ${args.address}.`,
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }

      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.event_type !== undefined) query.event_type = args.event_type
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const path = `/evm/user/${args.address}/ledger-events`
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        {
          summary: `HyperEVM ledger events for ${args.address}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_evm_hip3_backstop',
    group: 'evm',
    title: 'HIP-3 backstop tables',
    description:
      'The HIP-3 backstop surfaces, selected by `view`. "transfers" -> backstop deposit/withdraw transfers ' +
      '(offset-paginated, optional time window). "transfers_summary" -> per-dex transfer aggregates (one call). ' +
      '"health" -> backstop health across all active dexes (one call; only dexes with observed backstop fills ' +
      'appear, a subset of all dexes). "dex_health" -> health for one dex (single object; REQUIRES `dex`). ' +
      '"dex_fills" -> the simplified backstop fill feed for one dex (offset-paginated; REQUIRES `dex`). Cap: limit ' +
      'up to 1000. Note: the transfers / transfers_summary tables are typically empty in current data (no backstop ' +
      'deposits recorded yet). Unknown-dex behavior is inconsistent: dex_fills returns 200 with an empty list, ' +
      'whereas dex_health 404s.',
    inputSchema: {
      view: viewSchema(
        ['transfers', 'transfers_summary', 'health', 'dex_health', 'dex_fills'],
        'transfers / transfers_summary / health = market-wide tables; dex_health / dex_fills = one dex (require `dex`).',
        'health',
      ),
      dex: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Dex id (e.g. "km", "hyna", "flx"). Required for view="dex_health" or "dex_fills"; see view="health" for active dexes.',
        ),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(EVM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)

      if (args.view === 'transfers') {
        let query: Query = { limit: args.limit, offset: args.offset }
        query = buildTimeQuery(query, {
          start: args.start_time,
          end: args.end_time,
          target: 'isoSnake',
          startKey: 'start_time',
          endKey: 'end_time',
        })
        const path = '/evm/hip3/backstop/transfers'
        const page = await hd.getApiList(path, query)
        return buildResult(
          {
            data: page.data,
            pagination: offsetPagination(page, args.offset, args.limit),
            meta: listMeta(page, path),
            notes: [
              'Backstop transfers are typically empty in current data (no deposits recorded yet); an empty list is expected, not an error.',
            ],
          },
          { summary: 'HIP-3 backstop transfers.', maxTokens: ctx.config.maxResponseTokens },
        )
      }

      if (args.view === 'transfers_summary') {
        const path = '/evm/hip3/backstop/transfers-summary'
        const page = await hd.getApiList(path)
        return buildResult(
          {
            data: page.data,
            meta: listMeta(page, path),
            notes: [
              'Backstop transfer summaries are typically empty in current data; an empty list is expected, not an error.',
            ],
          },
          { summary: 'HIP-3 backstop transfer summary.', maxTokens: ctx.config.maxResponseTokens },
        )
      }

      if (args.view === 'health') {
        const path = '/evm/hip3/backstop/health'
        const page = await hd.getApiList(path)
        return buildResult(
          {
            data: page.data,
            meta: listMeta(page, path),
            notes: [
              'Only dexes with observed backstop fills appear here (a subset of all dexes), so a missing dex means "no backstop activity", not "no such dex".',
            ],
          },
          {
            summary: 'HIP-3 backstop health across active dexes.',
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }

      if (args.view === 'dex_health') {
        if (args.dex === undefined) {
          throw new Error(
            'view="dex_health" requires `dex` (e.g. "km"). Use view="health" to list active dexes.',
          )
        }
        const { data } = await hd.getApiSingle<unknown>(
          `/evm/hip3/backstop/${encodeURIComponent(args.dex)}/health`,
        )
        return rawResult(
          data,
          `HIP-3 backstop health for dex ${args.dex}. Note: an unknown dex 404s here.`,
        )
      }

      // view === 'dex_fills'
      if (args.dex === undefined) {
        throw new Error(
          'view="dex_fills" requires `dex` (e.g. "km"). Use view="health" to list active dexes.',
        )
      }
      let query: Query = { limit: args.limit, offset: args.offset }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'isoSnake',
        startKey: 'start_time',
        endKey: 'end_time',
      })
      const path = `/evm/hip3/backstop/${encodeURIComponent(args.dex)}/fills`
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
          notes: [
            'This is a simplified backstop fill shape (coin namespaced as "<dex>:<symbol>"). An unknown dex returns 200 with an empty list here (unlike dex_health, which 404s).',
          ],
        },
        {
          summary: `HIP-3 backstop fills for dex ${args.dex}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
