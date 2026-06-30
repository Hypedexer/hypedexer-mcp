import type { Config } from '../config.js'
import type { HypedexerClient } from '../hypedexer/client.js'
import type { HyperliquidPublicClient } from '../hyperliquid/public-client.js'
import type { Logger } from '../logger.js'

/**
 * The runtime dependencies every tool handler receives. `hd` is `null` when no
 * HypeDexer API key is configured — only `public`-group tools (which use `hl`)
 * run in that mode, and they are the only ones registered, so a handler that
 * needs `hd` can assert it.
 */
export interface ToolContext {
  hd: HypedexerClient | null
  hl: HyperliquidPublicClient
  config: Config
  logger: Logger
}

/** Narrowing helper: assert and return the keyed HypeDexer client. */
export function requireHd(ctx: ToolContext): HypedexerClient {
  if (!ctx.hd) {
    throw new Error('This tool requires a HypeDexer API key. Set HYPEDEXER_API_KEY to enable it.')
  }
  return ctx.hd
}
