import { McpServer } from '@modelcontextprotocol/server'
import { type Config, resolveGroups } from './config.js'
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

  if (!hd && config.authMode !== 'apikey') {
    logger.warn('no HYPEDEXER_API_KEY set - only the keyless `public` tool group is enabled')
  }

  return { hd, hl, config, logger }
}

/**
 * Derive a per-request context from the process-wide one (apikey auth mode).
 * The caller's bearer becomes the upstream X-API-Key, so the edge bills the
 * caller's own plan and credits. `callId` is sent as X-MCP-Call on every
 * upstream request of this MCP exchange: the edge counts one tool call per
 * distinct id (a tool that fans out into several REST calls meters once).
 * The X-MCP-Server secret, when configured, marks traffic as coming from the
 * hosted server, which is what authorizes MCP-only keys.
 *
 * Without a bearer the request is keyless: public tools only, `hd` null.
 * The shared `hl` client is reused; only the keyed client is per-request.
 */
export function createRequestContext(
  base: ToolContext,
  apiKey: string | undefined,
  callId: string,
): ToolContext {
  const { config, logger, hl } = base
  const upstreamHeaders: Record<string, string> = { 'X-MCP-Call': callId }
  if (config.upstreamSecret) upstreamHeaders['X-MCP-Server'] = config.upstreamSecret

  const hd = apiKey
    ? new HypedexerClient({
        apiKey,
        baseUrl: config.hypedexerBaseUrl,
        timeoutMs: config.requestTimeoutMs,
        userAgent: config.userAgent,
        defaultHeaders: upstreamHeaders,
      })
    : null

  const reqConfig: Config = {
    ...config,
    apiKey,
    enabledGroups: resolveGroups(config.toolsSpec, Boolean(apiKey)),
  }
  return { hd, hl, config: reqConfig, logger }
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
