import type { Query } from '../hypedexer/client.js'
import { requireHd } from './context.js'
import { buildResult } from './shared/output.js'
import { buildTimeQuery, timeWindowPagination } from './shared/pagination.js'
import {
  addressSchema,
  coinSchema,
  endTimeSchema,
  limitSchema,
  startTimeSchema,
} from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Funding-rate tools (HypeDexer Data API, bare-envelope `/funding/*`).
 *
 *   GET /funding/predictedFundings  -> predicted next-funding snapshot (none-list)
 *   GET /funding/fundingHistory     -> realized funding history for one coin (time-window)
 *   GET /funding/userFunding        -> a user's funding payments/receipts (time-window)
 *
 * The history endpoints are time-window paginated: each row carries an epoch-ms
 * `time`, and you page backwards by passing the returned next_end_time as end_time.
 */
export const fundingTools: ToolModule = [
  defineTool({
    name: 'hd_funding_predicted',
    group: 'funding',
    title: 'Predicted funding rates (all coins)',
    description:
      'Snapshot of predicted next funding rates across venues for every perp coin (~230 entries; ' +
      'some carry a zero rate). Returns the full list in one shot — there is no pagination and no ' +
      'inputs. Use this for a market-wide view of upcoming funding; for realized history of a single ' +
      'coin use hd_funding_history.',
    inputSchema: {},
    async handler(_args, ctx) {
      const hd = requireHd(ctx)
      const page = await hd.getBareList<unknown>('/funding/predictedFundings')
      return buildResult(
        { data: page.data, meta: { source: '/funding/predictedFundings' } },
        {
          summary: 'Predicted funding rates across venues.',
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_funding_history',
    group: 'funding',
    title: 'Funding-rate history for a coin',
    description:
      'Realized funding-rate history for one perp coin over an optional time window. `coin` is ' +
      'required (a perp ticker like "BTC"). Rows carry a string-encoded funding rate and premium plus ' +
      'an epoch-ms `time`. Time-window paginated: results run newest-first, and pagination.next_end_time ' +
      'is the cursor — call again with end_time=pagination.next_end_time to fetch older records.',
    inputSchema: {
      coin: coinSchema,
      start_time: startTimeSchema,
      end_time: endTimeSchema,
      limit: limitSchema(5000),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      let query: Query = { coin: args.coin, limit: args.limit }
      query = buildTimeQuery(query, {
        start: args.start_time,
        end: args.end_time,
        target: 'epochCamel',
        startKey: 'startTime',
        endKey: 'endTime',
      })

      const page = await hd.getBareList<unknown>('/funding/fundingHistory', query)
      const pagination = timeWindowPagination(page, 'time')

      return buildResult(
        { data: page.data, pagination, meta: { source: '/funding/fundingHistory' } },
        {
          summary: `Funding history for ${args.coin}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_user_funding',
    group: 'funding',
    title: 'User funding payments',
    description:
      "A wallet's perp funding payments and receipts over an optional time window. `user` (a wallet " +
      'address) is required. Rows carry an epoch-ms `time`. Time-window paginated: results run ' +
      'newest-first, and pagination.next_end_time is the cursor — call again with ' +
      'end_time=pagination.next_end_time to fetch older records. Note: this endpoint is frequently ' +
      'empty for many users, so an empty result does not necessarily indicate an error.',
    inputSchema: {
      user: addressSchema,
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

      const page = await hd.getBareList<unknown>('/funding/userFunding', query)
      const pagination = timeWindowPagination(page, 'time')

      const notes: string[] = []
      if (page.data.length === 0) {
        notes.push(
          'No funding records returned. This endpoint is frequently empty for many users; ' +
            'this is not necessarily an error.',
        )
      }

      return buildResult(
        { data: page.data, pagination, meta: { source: '/funding/userFunding' }, notes },
        {
          summary: `Funding payments for ${args.user}.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
