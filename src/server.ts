import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config } from './config.js'
import { HypedexerClient } from './hypedexer/client.js'
import { HyperliquidPublicClient } from './hyperliquid/public-client.js'
import { type Logger, createLogger } from './logger.js'
import type { ToolContext } from './tools/context.js'
import { allModules } from './tools/index.js'
import { type RegisterResult, registerAll } from './tools/registry.js'

export const SERVER_NAME = 'hypedexer-mcp'
export const SERVER_VERSION = '0.1.0'

export interface BuiltServer {
  server: McpServer
  ctx: ToolContext
  registration: RegisterResult
  logger: Logger
}

/**
 * Build a fully-wired MCP server: construct the clients, assemble the tool
 * context, and register every enabled tool. Transport-agnostic - the caller
 * connects the returned `server` to stdio or HTTP.
 */
export function createServer(
  config: Config,
  logger: Logger = createLogger(config.logLevel),
): BuiltServer {
  const hl = new HyperliquidPublicClient({
    baseUrl: config.hyperliquidBaseUrl,
    timeoutMs: config.requestTimeoutMs,
    userAgent: config.userAgent,
  })

  const hd = config.apiKey
    ? new HypedexerClient({
        apiKey: config.apiKey,
        baseUrl: config.hypedexerBaseUrl,
        timeoutMs: config.requestTimeoutMs,
        userAgent: config.userAgent,
      })
    : null

  if (!hd) {
    logger.warn('no HYPEDEXER_API_KEY set - only the keyless `public` tool group is enabled')
  }

  const ctx: ToolContext = { hd, hl, config, logger }

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'HypeDexer MCP server: read-only access to Hyperliquid market, trading, HIP-3, HIP-4, ' +
        'EVM and builder analytics via the HypeDexer data API, plus keyless Hyperliquid public ' +
        'tools (hl_public_*). List tools return a `pagination` handle - follow its `hint` to page. ' +
        'Pass response_format="detailed" when you need ids to chain follow-up calls.',
    },
  )

  const registration = registerAll(server, ctx, allModules, config, logger)
  return { server, ctx, registration, logger }
}
