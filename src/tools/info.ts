import { unwrapInfo } from '../hypedexer/envelope.js'
import { requireHd } from './context.js'
import { rawResult } from './shared/output.js'
import { z } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * Escape hatch over the HypeDexer `POST /info` discriminated dispatcher.
 *
 * A single advanced tool that forwards any documented `/info` request type to the
 * backing handler. Most callers should prefer the dedicated typed tools (fills,
 * funding, vaults, hip3, ...) which validate inputs and normalize quirks; this
 * exists only to reach types that have no first-class tool yet.
 */

/**
 * The dispatcher returns `currentFundingRates` and `vaultList` wrapped in an API
 * envelope where REST serves them bare; only these two are auto-unwrapped for
 * parity. Every other type keeps its envelope (next_cursor/has_more/total_count).
 */
const INFO_BARE_TYPES = new Set(['currentFundingRates', 'vaultList'])

export const infoTools: ToolModule = [
  defineTool({
    name: 'hd_info_raw',
    group: 'info',
    title: 'Raw HypeDexer /info dispatcher',
    description:
      'Advanced raw passthrough to the HypeDexer POST /info dispatcher. Send any documented info ' +
      'request `type` (the discriminator, e.g. "fills", "liqHistory", "hip3Summary") plus an ' +
      'optional `params` object of extra fields, which are merged into the request body alongside ' +
      'the type. Returns the upstream payload directly. Most users should prefer the dedicated ' +
      'typed tools (hd_fills_search, funding, vaults, hip3, ...) which validate inputs, paginate, ' +
      'and repair known quirks - reach for this only for a type with no first-class tool yet. ' +
      'Note: the dispatcher wraps `currentFundingRates` and `vaultList` in an API envelope where ' +
      'REST returns them bare; both are auto-unwrapped here for parity, so you always get the raw data.',
    inputSchema: {
      type: z
        .string()
        .trim()
        .min(1)
        .describe('The /info request discriminator, e.g. "fills", "liqHistory", "hip3Summary".'),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Optional passthrough object of extra request fields merged into the body alongside `type` ' +
            '(e.g. { user: "0x...", coin: "BTC" }). Keys depend on the chosen type.',
        ),
    },
    async handler(args, ctx) {
      const hd = requireHd(ctx)
      const body = { type: args.type, ...(args.params ?? {}) }
      const raw = await hd.post('/info', body)
      const payload = INFO_BARE_TYPES.has(args.type) ? unwrapInfo(raw) : raw
      return rawResult(payload, `Raw /info response for type "${args.type}".`)
    },
  }),
]
