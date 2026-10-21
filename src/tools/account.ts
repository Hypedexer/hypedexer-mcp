import { encodeTime } from '../core/time.js'
import { requireHd } from './context.js'
import { requireField } from './shared/errors.js'
import { buildResult, rawResult } from './shared/output.js'
import { type PaginationOut, epochAt, settlementSafePage } from './shared/pagination.js'
import {
  addressSchema,
  coinSchema,
  cursorSchema,
  endTimeSchema,
  startTimeSchema,
  viewSchema,
  z,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * One wallet's account state and history over HypeDexer POST /info
 * (live-verified 2026-10-21).
 *
 *   hd_account_state   -> proxied Hyperliquid account types, returned as-is:
 *                         clearinghouseState (user | users[], dex), spotClearinghouseState,
 *                         openOrders, frontendOpenOrders (dex), subAccounts, userFees,
 *                         userRateLimit, userRole, approvedBuilders, maxBuilderFee (builder),
 *                         extraAgents, userToMultiSigSigners, userAbstraction,
 *                         userDexAbstraction (dex), borrowLendUserState, delegatorSummary,
 *                         delegations, activeAssetData (coin), userVaultEquities, webData2
 *   hd_account_history -> indexed history: historicalOrders (header-paged window mode),
 *                         orderStatus, userNonFundingLedgerUpdates, userTwapSliceFills
 *
 * Live shapes differ from the doc in places: userAbstraction answers a bare string,
 * userDexAbstraction a bare boolean, extraAgents objects {name, address, validUntil},
 * userToMultiSigSigners null for a normal account.
 */

const STATE_VIEWS = [
  'clearinghouse',
  'spot_balances',
  'open_orders',
  'frontend_open_orders',
  'sub_accounts',
  'fees',
  'rate_limit',
  'role',
  'approved_builders',
  'max_builder_fee',
  'extra_agents',
  'multisig_signers',
  'abstraction',
  'dex_abstraction',
  'borrow_lend',
  'delegator_summary',
  'delegations',
  'active_asset',
  'vault_equities',
  'web_data',
] as const

const STATE_TYPE: Record<(typeof STATE_VIEWS)[number], string> = {
  clearinghouse: 'clearinghouseState',
  spot_balances: 'spotClearinghouseState',
  open_orders: 'openOrders',
  frontend_open_orders: 'frontendOpenOrders',
  sub_accounts: 'subAccounts',
  fees: 'userFees',
  rate_limit: 'userRateLimit',
  role: 'userRole',
  approved_builders: 'approvedBuilders',
  max_builder_fee: 'maxBuilderFee',
  extra_agents: 'extraAgents',
  multisig_signers: 'userToMultiSigSigners',
  abstraction: 'userAbstraction',
  dex_abstraction: 'userDexAbstraction',
  borrow_lend: 'borrowLendUserState',
  delegator_summary: 'delegatorSummary',
  delegations: 'delegations',
  active_asset: 'activeAssetData',
  vault_equities: 'userVaultEquities',
  web_data: 'webData2',
}

const DEX_VIEWS = new Set([
  'clearinghouse',
  'open_orders',
  'frontend_open_orders',
  'dex_abstraction',
])

export const accountTools: ToolModule = [
  defineTool({
    name: 'hd_account_state',
    group: 'account',
    title: 'Wallet account state (live)',
    description:
      'Live state of one wallet, proxied to a Hyperliquid node through HypeDexer POST /info. One `view`:\n' +
      '- clearinghouse: perp margin summary and positions (dex optional for a HIP-3 dex). Pass `users` (up to 50) ' +
      'instead of `user` to get a map {address: state} in one call.\n' +
      '- spot_balances: spot token balances (total, hold, entryNtl).\n' +
      '- open_orders / frontend_open_orders (dex optional): resting orders; frontend adds orderType, trigger and ' +
      'TP/SL flags. A busy market maker can have thousands; large lists are truncated to the response budget.\n' +
      '- sub_accounts, fees (fee schedule + daily volume), rate_limit, role ("user" or "agent"), approved_builders, ' +
      'max_builder_fee (builder required; tenths of a basis point), extra_agents (API wallets), multisig_signers ' +
      '(null if none), abstraction, dex_abstraction (dex optional), borrow_lend, delegator_summary, delegations, ' +
      'active_asset (coin required: leverage, max trade sizes, available to trade), vault_equities, web_data ' +
      '(the frontend aggregate; large).\n' +
      'Returns the upstream payload as-is. For history (orders, ledger, TWAP slices) use hd_account_history.',
    inputSchema: {
      view: viewSchema(STATE_VIEWS, 'Which account dataset.'),
      user: addressSchema
        .optional()
        .describe('The wallet (required unless view=clearinghouse with users).'),
      users: z
        .array(addressSchema)
        .min(1)
        .max(50)
        .optional()
        .describe('view=clearinghouse only: several wallets in one call (this tool caps at 50).'),
      dex: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Perp dex name for clearinghouse, open_orders, frontend_open_orders, dex_abstraction.',
        ),
      coin: coinSchema.optional().describe('view=active_asset: the coin (required).'),
      builder: addressSchema.optional().describe('view=max_builder_fee: the builder (required).'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const body: Record<string, unknown> = { type: STATE_TYPE[args.view] }
      if (args.view === 'clearinghouse' && args.users !== undefined) body.users = args.users
      else body.user = requireField(args.user, 'user', `view=${args.view}`)
      if (DEX_VIEWS.has(args.view) && args.dex !== undefined) body.dex = args.dex
      if (args.view === 'active_asset')
        body.coin = requireField(args.coin, 'coin', 'view=active_asset')
      if (args.view === 'max_builder_fee')
        body.builder = requireField(args.builder, 'builder', 'view=max_builder_fee')
      const raw = await hd.post<unknown>('/info', body)
      const who = args.users ? `${args.users.length} wallets` : String(body.user)
      return rawResult(raw, `Account view=${args.view} for ${who}.`, {
        maxTokens: ctx.config.maxResponseTokens,
      })
    },
  }),

  defineTool({
    name: 'hd_account_history',
    group: 'account',
    title: 'Wallet order, ledger and TWAP history',
    description:
      'Indexed history of one wallet over HypeDexer POST /info. One `view`:\n' +
      '- orders (historicalOrders): orders with their latest status, Hyperliquid shape. Default mode returns the ' +
      '`limit` most recent orders (limit 1-5000, default 2000; lookback_days 1-365 optional). Window mode ' +
      '(start_time and/or end_time) walks the window by oid desc: page with cursor=pagination.next_cursor. ' +
      'Coverage from 2026-06-27; trigger-order states from 2026-09-30.\n' +
      '- order_status (oid required): status of one order, live orders first then the archive ' +
      '({status:"unknownOid"} when not found).\n' +
      '- ledger (userNonFundingLedgerUpdates): every balance change except funding and fills (deposits, ' +
      'withdrawals, sends, spot/internal/sub-account/class transfers, vault ops, liquidations, borrow/lend, staking, ' +
      'rewards, gas auctions), newest first; default window the last 30 days; coverage from 2025-09-27 09:29 UTC.\n' +
      '- twap_slice_fills (userTwapSliceFills): fills of the wallet TWAP orders as {fill, twapId}, newest first; ' +
      'default window the last 7 days (pass start_time for older TWAPs); twap_id narrows to one parent; from 2025-09-01.\n' +
      'ledger and twap_slice_fills page backwards with end_time=pagination.next_end_time.',
    inputSchema: {
      view: viewSchema(['orders', 'order_status', 'ledger', 'twap_slice_fills'], 'Which history.'),
      user: addressSchema.describe('The wallet.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Max rows (1-5000). Defaults: orders 2000, ledger 500, twap_slice_fills 500.'),
      lookback_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe('view=orders default mode: only statuses from the last N days.'),
      cursor: cursorSchema.describe('view=orders window mode: pagination.next_cursor (an oid).'),
      oid: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('view=order_status: the order id (required).'),
      twap_id: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('view=twap_slice_fills: only slices of this TWAP.'),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const user = args.user

      if (args.view === 'order_status') {
        const oid = requireField(args.oid, 'oid', 'view=order_status')
        const raw = await hd.post<unknown>('/info', { type: 'orderStatus', user, oid })
        return rawResult(raw, `Order ${oid} status for ${user}.`, {
          maxTokens: ctx.config.maxResponseTokens,
        })
      }

      const body: Record<string, unknown> = { user }
      if (args.start_time) body.startTime = encodeTime(args.start_time, 'epochCamel')
      if (args.end_time) body.endTime = encodeTime(args.end_time, 'epochCamel')

      if (args.view === 'orders') {
        body.type = 'historicalOrders'
        if (args.limit !== undefined) body.limit = args.limit
        if (args.lookback_days !== undefined) body.lookbackDays = args.lookback_days
        if (args.cursor !== undefined) body.cursor = args.cursor
        const { data, headers } = await hd.postWithHeaders<unknown>('/info', body)
        const rows = Array.isArray(data) ? data : []
        const hasMore = headers.get('x-has-more') === 'true'
        const next = headers.get('x-next-cursor')
        const pagination: PaginationOut = { returned: rows.length, has_more: hasMore }
        if (hasMore && next) {
          pagination.next_cursor = next
          pagination.hint =
            'More orders in this window. Call again with the same start_time/end_time and cursor=pagination.next_cursor.'
        }
        return buildResult(
          { data: rows, pagination, meta: { source: 'POST /info historicalOrders' } },
          { summary: `Historical orders for ${user}.`, maxTokens: ctx.config.maxResponseTokens },
        )
      }

      const limit = args.limit ?? 500
      body.limit = limit
      if (args.view === 'ledger') body.type = 'userNonFundingLedgerUpdates'
      else {
        body.type = 'userTwapSliceFills'
        if (args.twap_id !== undefined) body.twapId = args.twap_id
      }
      const raw = await hd.post<unknown>('/info', body)
      const timePath = args.view === 'ledger' ? 'time' : 'fill.time'
      const { rows, pagination } = settlementSafePage(Array.isArray(raw) ? raw : [], limit, (r) =>
        epochAt(r, timePath),
      )
      const notes: string[] = []
      if (rows.length === 0 && !args.start_time) {
        notes.push(
          args.view === 'ledger'
            ? 'Empty for the default window (last 30 days). Pass start_time for older entries (coverage from 2025-09-27).'
            : 'Empty for the default window (last 7 days). Pass start_time for older TWAPs (coverage from 2025-09-01).',
        )
      }
      return buildResult(
        { data: rows, pagination, meta: { source: `POST /info ${String(body.type)}` }, notes },
        {
          summary: `${args.view === 'ledger' ? 'Non-funding ledger' : 'TWAP slice fills'} for ${user}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
