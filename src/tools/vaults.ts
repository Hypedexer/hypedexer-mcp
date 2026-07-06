import type { Query } from '../hypedexer/client.js'
import { requireHd } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { buildTimeQuery, offsetPagination, timeWindowPagination } from './shared/pagination.js'
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
 * Hyperliquid vault discovery + history (HypeDexer Data API, bare envelope).
 *
 * Covers the six `/vaults/*` REST endpoints:
 *   - vaultSummaries  -> hd_vaults_list          (offset-paginated leaderboard)
 *   - vaultDetails    -> hd_vault_details         (single record + commission history)
 *   - daily/equity/ledger snapshots -> hd_vault_snapshots (time-window history)
 *   - userVaultEquities -> hd_user_vault_equities (a depositor's per-vault equity)
 *
 * Time params are epoch-ms camelCase (`startTime`/`endTime`); row `time` fields
 * are epoch-ms numbers, so time-window paging decrements `end_time` past the
 * oldest row.
 */

const SNAPSHOT_PATHS = {
  daily: '/vaults/dailySnapshots',
  equity: '/vaults/equitySnapshots',
  ledger: '/vaults/vaultLedger',
} as const

export const vaultsTools: ToolModule = [
  defineTool({
    name: 'hd_vaults_list',
    group: 'vaults',
    title: 'List Hyperliquid vaults',
    description:
      'Browse the Hyperliquid vault directory (the "vaultSummaries" leaderboard), one row per vault with ' +
      'vaultAddress, name, leader, leaderCommission, isClosed, followerCount, snapshotTime and createTime. ' +
      'Rows come pre-sorted by followerCount descending, so the first page is the most-followed vaults. ' +
      'Closed vaults are excluded by default; set include_closed=true to include them. Offset-paginated: ' +
      'page with offset=pagination.next_offset (cap 5000). Use this to find a vaultAddress to feed into ' +
      'hd_vault_details or hd_vault_snapshots.',
    inputSchema: {
      include_closed: z
        .boolean()
        .optional()
        .describe('Include closed/wound-down vaults. Omit (default) to list only open vaults.'),
      limit: limitSchema(5000),
      offset: offsetSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const query: Query = { limit: args.limit, offset: args.offset }
      if (args.include_closed !== undefined) query.includeClosed = args.include_closed

      const page = await hd.getBareList<unknown>('/vaults/vaultSummaries', query)
      const pagination = offsetPagination(page, args.offset, args.limit)

      const meta: Record<string, unknown> = { source: '/vaults/vaultSummaries' }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs

      return buildResult(
        { data: page.data, pagination, meta },
        {
          summary: `Hyperliquid vaults${args.include_closed ? ' (incl. closed)' : ''}, by follower count.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_vault_details',
    group: 'vaults',
    title: 'Get Hyperliquid vault details',
    description:
      'Full detail for one vault by vaultAddress: name, leader, leaderCommission, isClosed, ' +
      'lockupDurationSeconds, allowDeposits, followerCount, snapshotTime, createTime, plus a `portfolio` ' +
      'array. Note: that `portfolio` array is actually the leader commission history (time-series of ' +
      "followerCount + leaderCommission), NOT the vault's asset holdings. Optional start_time/end_time " +
      'narrow the commission-history window. Returns a single object (not paginated). Passing the zero ' +
      'address (0x000...000) yields a 404 "not found". Find a vaultAddress with hd_vaults_list.',
    inputSchema: {
      vault_address: addressSchema.describe(
        'Vault address, 0x-prefixed 40 hex chars. The zero address returns 404.',
      ),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { vaultAddress: args.vault_address }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'epochCamel',
        startKey: 'startTime',
        endKey: 'endTime',
      })

      const { data } = await hd.getBareSingle<unknown>('/vaults/vaultDetails', query)
      return rawResult(
        data,
        `Vault details for ${args.vault_address}. The "portfolio" array is the leader commission history (followerCount + leaderCommission over time), not asset holdings.`,
      )
    },
  }),

  defineTool({
    name: 'hd_vault_snapshots',
    group: 'vaults',
    title: 'Hyperliquid vault history snapshots',
    description:
      'Historical snapshots for one vault, selected via view: ' +
      '"daily" (one row per day: time, day, totalDeposits, accountValue, totalNotional, totalRawPnl, ' +
      'nPositions, followerCount), "equity" (same fields, higher-frequency, no `day`), or "ledger" ' +
      '(deposit/withdraw transfers: time, txHash, userFrom, userTo, amount, token). For "ledger" each row ' +
      'gets a synthesized `kind` ("deposit" when userTo == vaultAddress, else "withdraw"). Time-window ' +
      'paginated (cap 5000): rows run newest-first, page older with end_time=pagination.next_end_time.',
    inputSchema: {
      vault_address: addressSchema.describe('Vault address, 0x-prefixed 40 hex chars.'),
      view: viewSchema(
        ['daily', 'equity', 'ledger'],
        'daily = per-day equity snapshots (adds `day`); equity = higher-frequency snapshots; ledger = deposit/withdraw transfers.',
      ),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(5000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { vaultAddress: args.vault_address, limit: args.limit }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'epochCamel',
        startKey: 'startTime',
        endKey: 'endTime',
      })

      const path = SNAPSHOT_PATHS[args.view]
      const page = await hd.getBareList<Record<string, unknown>>(path, query)

      const notes: string[] = []
      let rows: Array<Record<string, unknown>> = page.data
      if (args.view === 'ledger') {
        const vault = args.vault_address.toLowerCase()
        rows = page.data.map((row) => {
          const userTo = typeof row.userTo === 'string' ? row.userTo.toLowerCase() : ''
          return { ...row, kind: userTo === vault ? 'deposit' : 'withdraw' }
        })
        notes.push(
          'Ledger rows carry a synthesized `kind`: "deposit" when userTo == vaultAddress, else "withdraw".',
        )
      } else if (args.view === 'daily') {
        notes.push(
          'Daily snapshots include a `day` (ISO date) field; the "equity" view is higher-frequency without it.',
        )
      }

      const pagination = timeWindowPagination(page, 'time')
      const meta: Record<string, unknown> = { view: args.view, source: path }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs

      return buildResult(
        { data: rows, pagination, meta, notes },
        {
          summary: `Vault ${args.view} snapshots for ${args.vault_address}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_user_vault_equities',
    group: 'vaults',
    title: "A user's vault equity history",
    description:
      'Per-vault equity time-series for one depositor address (which vaults they hold and how much). ' +
      'Time-window paginated: newest-first, page older with end_time=pagination.next_end_time. Note: this ' +
      'is frequently empty - only addresses that actively deposit into vaults return rows, so an empty ' +
      'result usually means "this user holds no vault equity", not an error.',
    inputSchema: {
      user: addressSchema.describe('Depositor wallet address, 0x-prefixed 40 hex chars.'),
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(5000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { user: args.user, limit: args.limit }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'epochCamel',
        startKey: 'startTime',
        endKey: 'endTime',
      })

      const page = await hd.getBareList<unknown>('/vaults/userVaultEquities', query)
      const pagination = timeWindowPagination(page, 'time')

      const notes: string[] = []
      if (page.data.length === 0) {
        notes.push(
          'No vault equity rows for this user. This is common: only active vault depositors return data.',
        )
      }

      const meta: Record<string, unknown> = { source: '/vaults/userVaultEquities' }
      if (page.meta.executionMs != null) meta.execution_ms = page.meta.executionMs

      return buildResult(
        { data: page.data, pagination, meta, notes },
        {
          summary: `Vault equities for ${args.user}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
