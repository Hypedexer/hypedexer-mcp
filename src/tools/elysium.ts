import type { Page } from '../core/types.js'
import type { Query } from '../hypedexer/client.js'
import { sanitizeTotalCount } from '../hypedexer/quirks.js'
import { requireHd } from './context.js'
import { buildResult, errorResult, rawResult } from './shared/output.js'
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
 * Elysium testnet indexed data (HypeDexer Data API, APIResponse envelope).
 *
 * Elysium is Kinetiq's Arbitrum Orbit L2 that settles to HyperEVM. Eight tools
 * cover the 22 routes under `/elysium/testnet`: stats, blocks, transactions,
 * logs, the batches posted on HyperEVM, the bridge (transfers, lookup by hash,
 * retryables, token registry, reserves), tokens, and per-address views. Every
 * list is offset-paginated with `limit` up to 1000. Upstream validates enums,
 * addresses and hashes strictly (422); the schemas below reject the same inputs
 * first. Timestamps in rows are UTC without a `Z`. Mainnet will use the same
 * shapes under `/elysium/mainnet`.
 */

const BASE = '/elysium/testnet'
const ELYSIUM_LIMIT_CAP = 1000

const txHashSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 64-hex-character transaction hash')
  .describe('Transaction hash, 0x-prefixed 64 hex chars.')

const BRIDGE_DIRECTIONS = ['deposit', 'withdrawal'] as const
const BRIDGE_STATUSES = [
  'initiated',
  'ticket_created',
  'redeem_failed',
  'expired',
  'completed',
  'executed',
] as const
const BRIDGE_ROUTES = ['native', 'canonical', 'mirror'] as const

function listMeta(page: Page<unknown>, source: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { source, network: 'elysium-testnet' }
  if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs
  const total = sanitizeTotalCount(page.meta.totalCount, page.data.length)
  if (total != null) meta.total_count = total
  return meta
}

function withTime(query: Query, start: string | undefined, end: string | undefined): Query {
  return buildTimeQuery(query, {
    start,
    end,
    target: 'isoSnake',
    startKey: 'start_time',
    endKey: 'end_time',
  })
}

export const elysiumTools: ToolModule = [
  defineTool({
    name: 'hd_elysium_stats',
    group: 'elysium',
    title: 'Elysium testnet chain stats',
    description:
      'Headline stats for Elysium testnet (Kinetiq L2 on Hyperliquid). view="current" (default) returns one ' +
      'snapshot: total_blocks, total_transactions, user_transactions (excludes ArbOS system, bridge-delivered ' +
      'and known spam txs), spam_transactions, bridge_transactions, unique_senders, contracts_created, first/last ' +
      'block and time, last_batch_number, last_batched_block (last block posted on HyperEVM). view="daily" returns ' +
      'one row per UTC day for the last `days` days (blocks, transactions, user_transactions, active_addresses, ' +
      'contracts_created, gas_used). The current UTC day is partial until midnight.',
    inputSchema: {
      view: viewSchema(
        ['current', 'daily'],
        'current = single snapshot; daily = per-UTC-day series.',
        'current',
      ),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe('Daily view only: number of past days (1-365, default 30).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'current') {
        const { data } = await hd.getApiSingle<unknown>(`${BASE}/stats`)
        return rawResult(data, 'Current Elysium testnet stats.')
      }
      const path = `${BASE}/stats/daily`
      const page = await hd.getApiList(path, { days: args.days })
      return buildResult(
        {
          data: page.data,
          meta: listMeta(page, path),
          notes: ['The most recent row is the current UTC day and is partial until midnight UTC.'],
        },
        {
          summary: `Daily Elysium testnet stats for the last ${args.days} day(s).`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_elysium_blocks',
    group: 'elysium',
    title: 'Elysium testnet blocks',
    description:
      'Elysium testnet blocks, three modes. (1) Omit block_number -> block list, newest first, offset-paginated, ' +
      'optionally bounded by start_block/end_block (inclusive) and/or start_time/end_time (ISO-8601). ' +
      '(2) block_number alone -> that block, with batch_number (the HyperEVM batch containing it, null until ' +
      'posted); unknown block 404s. (3) block_number with transactions=true -> every transaction in that block.',
    inputSchema: {
      block_number: z.number().int().min(0).optional().describe('Target one block.'),
      transactions: z
        .boolean()
        .default(false)
        .describe("With block_number: true returns the block's transactions instead of the block."),
      start_block: z.number().int().min(0).optional().describe('List only: inclusive lower bound.'),
      end_block: z.number().int().min(0).optional().describe('List only: inclusive upper bound.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(ELYSIUM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.block_number !== undefined && !args.transactions) {
        const { data } = await hd.getApiSingle<unknown>(`${BASE}/blocks/${args.block_number}`)
        return rawResult(data, `Elysium testnet block ${args.block_number}.`)
      }
      if (args.block_number !== undefined && args.transactions) {
        const path = `${BASE}/blocks/${args.block_number}/transactions`
        const page = await hd.getApiList(path, {})
        return buildResult(
          { data: page.data, meta: listMeta(page, path) },
          {
            summary: `Transactions in Elysium testnet block ${args.block_number}.`,
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.start_block !== undefined) query.start_block = args.start_block
      if (args.end_block !== undefined) query.end_block = args.end_block
      query = withTime(query, args.start_time, args.end_time)
      const path = `${BASE}/blocks`
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        { summary: 'Elysium testnet blocks.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_elysium_transactions',
    group: 'elysium',
    title: 'Elysium testnet transactions',
    description:
      'Elysium testnet transactions. Pass tx_hash -> that transaction with its receipt fields, event logs, ' +
      'decoded token transfers and HyperEVM batch (a tx listed seconds ago can briefly 404: retry shortly). ' +
      'Otherwise -> the transaction feed, newest first, filterable by block_number, from_addr, to_addr, ' +
      'method_id (4-byte selector), tx_type (e.g. 0x2; ArbOS system txs are 0x6a) and a time window. ' +
      'include_system and include_spam default to true: set them to false to keep only user activity. ' +
      'success, is_system and is_spam are 0/1. Offset-paginated, limit up to 1000.',
    inputSchema: {
      tx_hash: txHashSchema.optional(),
      block_number: z.number().int().min(0).optional().describe('Feed only: one block.'),
      from_addr: addressSchema.optional(),
      to_addr: addressSchema.optional(),
      method_id: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{8}$/, 'must be a 0x-prefixed 4-byte selector')
        .optional()
        .describe('Feed only: 4-byte function selector, e.g. 0xa9059cbb.'),
      tx_type: z.string().trim().optional().describe('Feed only: hex type byte, e.g. 0x2 or 0x6a.'),
      include_system: z.boolean().optional().describe('Feed only: false drops ArbOS system txs.'),
      include_spam: z.boolean().optional().describe('Feed only: false drops known spam.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(ELYSIUM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.tx_hash !== undefined) {
        const { data } = await hd.getApiSingle<unknown>(`${BASE}/transactions/${args.tx_hash}`)
        return rawResult(data, `Elysium testnet transaction ${args.tx_hash}.`)
      }
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.block_number !== undefined) query.block_number = args.block_number
      if (args.from_addr !== undefined) query.from_addr = args.from_addr
      if (args.to_addr !== undefined) query.to_addr = args.to_addr
      if (args.method_id !== undefined) query.method_id = args.method_id
      if (args.tx_type !== undefined) query.tx_type = args.tx_type
      if (args.include_system !== undefined) query.include_system = args.include_system
      if (args.include_spam !== undefined) query.include_spam = args.include_spam
      query = withTime(query, args.start_time, args.end_time)
      const path = `${BASE}/transactions`
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        { summary: 'Elysium testnet transactions.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_elysium_logs',
    group: 'elysium',
    title: 'Elysium testnet event logs',
    description:
      'Elysium testnet event logs, newest first: block_time, block_number, tx_index, log_index, tx_hash, ' +
      'emitting contract address, topic0-topic3 (empty string when absent), data. Filter by emitting contract ' +
      '(address), topic0 (event signature hash), tx_hash, block_number and/or a time window. ' +
      'Offset-paginated, limit up to 1000.',
    inputSchema: {
      address: addressSchema.optional(),
      topic0: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte topic')
        .optional()
        .describe('Event signature hash, e.g. the ERC-20 Transfer topic.'),
      tx_hash: txHashSchema.optional(),
      block_number: z.number().int().min(0).optional().describe('One block.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(ELYSIUM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.address !== undefined) query.address = args.address
      if (args.topic0 !== undefined) query.topic0 = args.topic0
      if (args.tx_hash !== undefined) query.tx_hash = args.tx_hash
      if (args.block_number !== undefined) query.block_number = args.block_number
      query = withTime(query, args.start_time, args.end_time)
      const path = `${BASE}/logs`
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        { summary: 'Elysium testnet event logs.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_elysium_batches',
    group: 'elysium',
    title: 'Elysium batches posted on HyperEVM',
    description:
      'Sequencer batches Elysium testnet posted to the SequencerInbox on HyperEVM testnet: batch_number, the ' +
      'HyperEVM block/time/tx of the post, the Elysium block range it contains (first_block, last_block, ' +
      'block_count) and posting_delay_s (posting time minus the time of its last block). Pass batch_number for ' +
      'one batch; otherwise the list, newest first, offset-paginated, limit up to 1000.',
    inputSchema: {
      batch_number: z.number().int().min(0).optional().describe('One batch.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(ELYSIUM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.batch_number !== undefined) {
        const { data } = await hd.getApiSingle<unknown>(`${BASE}/batches/${args.batch_number}`)
        return rawResult(data, `Elysium batch ${args.batch_number}.`)
      }
      const query = withTime(
        { limit: args.limit, offset: args.offset },
        args.start_time,
        args.end_time,
      )
      const path = `${BASE}/batches`
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        { summary: 'Elysium batches posted on HyperEVM.', maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_elysium_bridge',
    group: 'elysium',
    title: 'Elysium <-> HyperEVM bridge',
    description:
      'The HyperEVM <-> Elysium bridge, tracked on both chains (l1 = HyperEVM, l2 = Elysium). ' +
      'view="transfers" (default): deposits and withdrawals, filterable by address, direction, status ' +
      '(initiated, ticket_created, redeem_failed, expired, completed, executed), asset (native, token, message), ' +
      'route (native, canonical, mirror), token and a time window; include_messages adds value-less messages. ' +
      'view="track": pass tx_hash (any hash of the journey: HyperEVM tx, retryable ticket or Elysium redeem) to ' +
      'get every transfer it belongs to. view="retryables": deposits delivered through retryable tickets ' +
      '(status pending, failed, expired, redeemed); a failed auto-redeem can be redeemed by hand for 7 days. ' +
      'view="tokens": tokens that crossed, with both addresses and transfer counts (route canonical or mirror). ' +
      'view="reserves": latest proof-of-backing snapshot (every 15 min), backed=true when HyperEVM escrow covers ' +
      'the Elysium supply; filter by route, only_unbacked=true for exceptions. Lists are offset-paginated.',
    inputSchema: {
      view: viewSchema(
        ['transfers', 'track', 'retryables', 'tokens', 'reserves'],
        'transfers | track | retryables | tokens | reserves',
        'transfers',
      ),
      tx_hash: txHashSchema
        .optional()
        .describe('view=track only: any hash of the transfer journey.'),
      address: addressSchema.optional(),
      direction: z
        .enum(BRIDGE_DIRECTIONS)
        .optional()
        .describe('view=transfers: deposit or withdrawal.'),
      status: z
        .enum([...BRIDGE_STATUSES, 'pending', 'failed', 'redeemed'])
        .optional()
        .describe(
          'view=transfers: initiated | ticket_created | redeem_failed | expired | completed | executed. ' +
            'view=retryables: pending | failed | expired | redeemed.',
        ),
      asset: z.enum(['native', 'token', 'message']).optional().describe('view=transfers only.'),
      route: z
        .enum(BRIDGE_ROUTES)
        .optional()
        .describe('transfers/reserves: native | canonical | mirror. tokens: canonical | mirror.'),
      token: addressSchema.optional().describe('view=transfers only: token address.'),
      include_messages: z.boolean().optional().describe('view=transfers only.'),
      only_unbacked: z.boolean().optional().describe('view=reserves only.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(ELYSIUM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const page = { limit: args.limit, offset: args.offset }

      if (args.view === 'track') {
        if (args.tx_hash === undefined) {
          return errorResult(
            'view=track needs tx_hash.',
            'Pass any hash of the transfer journey: the HyperEVM tx, the retryable ticket or the Elysium redeem.',
          )
        }
        const path = `${BASE}/bridge/transfers/${args.tx_hash}`
        const res = await hd.getApiList(path, {})
        return buildResult(
          { data: res.data, meta: listMeta(res, path) },
          {
            summary: `Bridge transfers for ${args.tx_hash}.`,
            maxTokens: ctx.config.maxResponseTokens,
          },
        )
      }

      let path = `${BASE}/bridge/transfers`
      let query: Query = { ...page }
      let summary = 'Elysium bridge transfers.'
      const notes: string[] = []

      const retryableStatuses: readonly string[] = ['pending', 'failed', 'expired', 'redeemed']
      if (args.status !== undefined) {
        const allowed: readonly string[] =
          args.view === 'retryables' ? retryableStatuses : BRIDGE_STATUSES
        if (args.view === 'tokens' || args.view === 'reserves' || !allowed.includes(args.status)) {
          return errorResult(
            `status="${args.status}" does not apply to view="${args.view}".`,
            `view=transfers takes ${BRIDGE_STATUSES.join(' | ')}; view=retryables takes ${retryableStatuses.join(' | ')}.`,
          )
        }
      }
      if (args.view === 'tokens' && args.route === 'native') {
        return errorResult(
          'route="native" does not apply to view="tokens".',
          'Use route=canonical or route=mirror.',
        )
      }

      if (args.view === 'transfers') {
        if (args.address !== undefined) query.address = args.address
        if (args.direction !== undefined) query.direction = args.direction
        if (args.status !== undefined) query.status = args.status
        if (args.asset !== undefined) query.asset = args.asset
        if (args.route !== undefined) query.route = args.route
        if (args.token !== undefined) query.token = args.token
        if (args.include_messages !== undefined) query.include_messages = args.include_messages
        query = withTime(query, args.start_time, args.end_time)
      } else if (args.view === 'retryables') {
        path = `${BASE}/bridge/retryables`
        summary = 'Elysium retryable tickets (deposits).'
        if (args.status !== undefined) query.status = args.status
        if (args.address !== undefined) query.address = args.address
        query = withTime(query, args.start_time, args.end_time)
      } else if (args.view === 'tokens') {
        path = `${BASE}/bridge/tokens`
        summary = 'Tokens bridged between HyperEVM and Elysium.'
        if (args.route !== undefined) query.route = args.route
      } else {
        path = `${BASE}/bridge/reserves`
        summary = 'Latest Elysium bridge reserves snapshot.'
        query = {}
        if (args.route !== undefined) query.route = args.route
        if (args.only_unbacked !== undefined) query.only_unbacked = args.only_unbacked
        if (args.route === undefined) {
          notes.push(
            'Without route, the list was observed to stop at 1000 rows (2026-09-28); pass route to get every row.',
          )
        }
      }

      const res = await hd.getApiList(path, query)
      return buildResult(
        {
          data: res.data,
          ...(args.view === 'reserves'
            ? {}
            : { pagination: offsetPagination(res, args.offset, args.limit) }),
          meta: listMeta(res, path),
          ...(notes.length > 0 ? { notes } : {}),
        },
        { summary, maxTokens: ctx.config.maxResponseTokens },
      )
    },
  }),

  defineTool({
    name: 'hd_elysium_tokens',
    group: 'elysium',
    title: 'Elysium testnet tokens',
    description:
      'Elysium testnet tokens. Without address -> the token list, filterable by standard (erc20, erc721, erc1155), ' +
      'origin (native, canonical = bridged) and search (name, symbol or address). With address: view="detail" ' +
      '(default) -> metadata, bridge origin, supply, holder and transfer counts; view="holders" -> current holders ' +
      'by balance with share of supply; view="transfers" -> the token transfers, optionally for one holder and a ' +
      'time window. Lists are offset-paginated, limit up to 1000.',
    inputSchema: {
      address: addressSchema
        .optional()
        .describe('Token contract address. Omit for the token list.'),
      view: viewSchema(
        ['detail', 'holders', 'transfers'],
        'With address: detail | holders | transfers.',
        'detail',
      ),
      standard: z.enum(['erc20', 'erc721', 'erc1155']).optional().describe('List only.'),
      origin: z
        .enum(['native', 'canonical'])
        .optional()
        .describe('List only: canonical = bridged from HyperEVM.'),
      search: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe('List only: name, symbol or address.'),
      holder: addressSchema
        .optional()
        .describe('view=transfers only: transfers involving this address.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(ELYSIUM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const pageQuery: Query = { limit: args.limit, offset: args.offset }

      if (args.address === undefined) {
        const query: Query = { ...pageQuery }
        if (args.standard !== undefined) query.standard = args.standard
        if (args.origin !== undefined) query.origin = args.origin
        if (args.search !== undefined) query.search = args.search
        const path = `${BASE}/tokens`
        const page = await hd.getApiList(path, query)
        return buildResult(
          {
            data: page.data,
            pagination: offsetPagination(page, args.offset, args.limit),
            meta: listMeta(page, path),
          },
          { summary: 'Elysium testnet tokens.', maxTokens: ctx.config.maxResponseTokens },
        )
      }

      if (args.view === 'detail') {
        const { data } = await hd.getApiSingle<unknown>(`${BASE}/tokens/${args.address}`)
        return rawResult(data, `Elysium token ${args.address}.`)
      }

      let query: Query = { ...pageQuery }
      let path = `${BASE}/tokens/${args.address}/holders`
      if (args.view === 'transfers') {
        path = `${BASE}/tokens/${args.address}/transfers`
        if (args.holder !== undefined) query.holder = args.holder
        query = withTime(query, args.start_time, args.end_time)
      }
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        {
          summary: `Elysium token ${args.address}: ${args.view}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_elysium_user',
    group: 'elysium',
    title: 'Elysium testnet address',
    description:
      'One address on Elysium testnet. view="balances" (default): native HYPE (from the archive node) and every ' +
      'token balance rebuilt from Transfer events; pass block to read a past state. view="activity": ' +
      'transactions, token transfers and bridge transfers involving the address, newest first. view="bridge": ' +
      'its HyperEVM <-> Elysium bridge history, filterable by direction and status. Lists are offset-paginated, ' +
      'limit up to 1000. For HyperCore <-> HyperEVM movements of the same address use hd_evm_user.',
    inputSchema: {
      address: addressSchema,
      view: viewSchema(
        ['balances', 'activity', 'bridge'],
        'balances | activity | bridge',
        'balances',
      ),
      block: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('view=balances only: read balances at this block.'),
      direction: z.enum(BRIDGE_DIRECTIONS).optional().describe('view=bridge only.'),
      status: z.enum(BRIDGE_STATUSES).optional().describe('view=bridge only.'),
      include_messages: z.boolean().optional().describe('view=bridge only.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(ELYSIUM_LIMIT_CAP),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      if (args.view === 'balances') {
        const query: Query = {}
        if (args.block !== undefined) query.block = args.block
        const { data } = await hd.getApiSingle<unknown>(
          `${BASE}/user/${args.address}/balances`,
          query,
        )
        return rawResult(data, `Elysium balances of ${args.address}.`)
      }
      let query: Query = { limit: args.limit, offset: args.offset }
      if (args.view === 'bridge') {
        if (args.direction !== undefined) query.direction = args.direction
        if (args.status !== undefined) query.status = args.status
        if (args.include_messages !== undefined) query.include_messages = args.include_messages
      }
      query = withTime(query, args.start_time, args.end_time)
      const path = `${BASE}/user/${args.address}/${args.view}`
      const page = await hd.getApiList(path, query)
      return buildResult(
        {
          data: page.data,
          pagination: offsetPagination(page, args.offset, args.limit),
          meta: listMeta(page, path),
        },
        {
          summary: `Elysium ${args.view} of ${args.address}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
