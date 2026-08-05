import { McpServer } from '@modelcontextprotocol/server'
import type { Config } from './config.js'
import { HypedexerClient } from './hypedexer/client.js'
import { HyperliquidPublicClient } from './hyperliquid/public-client.js'
import { type Logger, createLogger } from './logger.js'
import type { ToolContext } from './tools/context.js'
import { allModules } from './tools/index.js'
import { type RegisterResult, registerAll } from './tools/registry.js'
import { VERSION } from './version.js'

export const SERVER_NAME = 'hypedexer-mcp'
export const SERVER_VERSION = VERSION

export interface BuiltServer {
  server: McpServer
  ctx: ToolContext
  registration: RegisterResult
  logger: Logger
}

/**
 * Assemble the shared tool context: API clients, config, logger. Built once
 * per process; the HTTP transport reuses it across per-request server builds.
 */
export function createContext(
  config: Config,
  logger: Logger = createLogger(config.logLevel),
): ToolContext {
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

  return { hd, hl, config, logger }
}

/**
 * Build a fresh MCP server over an existing context and register every enabled
 * tool. The v2 HTTP entry serves one server instance per request, so this must
 * stay cheap: clients live in the context, only registration happens here.
 */
export function buildServer(ctx: ToolContext): BuiltServer {
  const { config, logger } = ctx
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

/**
 * Convenience for single-server transports (stdio): build the context and one
 * fully-wired server in one call.
 */
export function createServer(
  config: Config,
  logger: Logger = createLogger(config.logLevel),
): BuiltServer {
  return buildServer(createContext(config, logger))
}
