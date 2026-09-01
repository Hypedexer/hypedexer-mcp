import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import { buildServer, createContext, createRequestContext } from '../server.js'
import type { ToolContext } from '../tools/context.js'

/**
 * Streamable-HTTP transport on the stateless 2026-07-28 protocol. One
 * `createMcpHandler` serves everything: modern requests get a fresh server
 * instance per request; 2025-era clients (initialize handshake, no envelope)
 * are answered by the SDK's built-in stateless legacy fallback. There are no
 * sessions to track, cap, or reap anymore. This is the shape a hosted
 * deployment (mcp.hypedexer.com) runs.
 *
 * Security posture (AUDIT.md H1-H3):
 * - Bearer auth on /mcp when HYPEDEXER_MCP_HTTP_TOKEN is set; the token is
 *   MANDATORY when binding beyond loopback (startup refuses otherwise).
 * - Host and Origin allowlisting on /mcp (DNS-rebinding defense).
 * - SIGTERM/SIGINT abort in-flight exchanges and close the listener.
 */

export interface HttpHandle {
  server: Server
  port: number
  close(): Promise<void>
}

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Shape of a plausible HypeDexer API key in a bearer header (apikey auth
 * mode). Deliberately loose: the edge is the authority on validity; this only
 * rejects garbage early with a clean 401 instead of an upstream error.
 */
const API_KEY_SHAPE = /^[A-Za-z0-9._-]{8,200}$/

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Constant-time bearer comparison; hashing first equalizes lengths. */
function tokenMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected))
}

/** Hostname of a Host header value ("example.com:3000" -> "example.com"). */
function hostHeaderName(host: string): string {
  const bracket = host.match(/^(\[[^\]]+\])(?::\d+)?$/)
  if (bracket?.[1]) return bracket[1].toLowerCase()
  return (host.split(':')[0] ?? host).toLowerCase()
}

function rpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  })
}

export async function startHttp(config: Config, logger: Logger): Promise<HttpHandle> {
  const isLoopbackBind = LOOPBACK_BINDS.has(config.httpHost.toLowerCase())
  const apikeyMode = config.authMode === 'apikey'
  if (!isLoopbackBind && !config.httpAuthToken && !apikeyMode) {
    throw new Error(
      `Refusing to bind the HTTP transport to ${config.httpHost} without authentication. Set HYPEDEXER_MCP_HTTP_TOKEN (clients must send "Authorization: Bearer <token>"), set HYPEDEXER_MCP_AUTH_MODE=apikey (each bearer is the caller's API key), or keep the default loopback bind.`,
    )
  }
  if (isLoopbackBind && !config.httpAuthToken && !apikeyMode) {
    logger.warn(
      'http transport is unauthenticated (loopback only). Set HYPEDEXER_MCP_HTTP_TOKEN to require a bearer token.',
    )
  }
  if (apikeyMode && !config.upstreamSecret) {
    logger.warn(
      'apikey auth mode without HYPEDEXER_MCP_UPSTREAM_SECRET: MCP-only keys and per-tool-call metering are disabled upstream; Data API keys meter as direct REST usage.',
    )
  }

  const allowedHosts = new Set(config.httpAllowedHosts.map((h) => h.toLowerCase()))
  allowedHosts.add(config.httpHost.toLowerCase())
  const allowedOrigins = new Set(config.httpAllowedOrigins.map((o) => o.toLowerCase()))

  const app = express()
  app.use(express.json({ limit: '4mb' }))

  // DNS-rebinding defense: the Host header must name an allowed host, and a
  // browser-sent Origin must be explicitly allowed or point at an allowed host.
  const guardOriginAndHost = (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host
    if (!host || !allowedHosts.has(hostHeaderName(host))) {
      rpcError(res, 403, `Forbidden: Host "${host ?? ''}" is not allowed.`)
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      let originHost: string
      try {
        originHost = new URL(origin).hostname.toLowerCase()
      } catch {
        rpcError(res, 403, 'Forbidden: malformed Origin header.')
        return
      }
      const ipv6 = originHost.includes(':') ? `[${originHost}]` : originHost
      if (
        !allowedOrigins.has(origin.toLowerCase()) &&
        !allowedHosts.has(originHost) &&
        !allowedHosts.has(ipv6)
      ) {
        rpcError(res, 403, `Forbidden: Origin "${origin}" is not allowed.`)
        return
      }
    }
    next()
  }

  // apikey mode: the bearer is the caller's HypeDexer API key, stashed for the
  // per-request context. No constant-time compare: the value is an opaque
  // pass-through and the edge is the validator. A missing bearer is allowed
  // and serves the keyless public tools; a malformed one gets a clean 401.
  const guardApiKey = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (provided === undefined) {
      next()
      return
    }
    if (!API_KEY_SHAPE.test(provided)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      rpcError(
        res,
        401,
        'Unauthorized: the bearer must be a HypeDexer API key (get one at https://www.app.hypedexer.com/), or be omitted for keyless public tools.',
      )
      return
    }
    res.locals.apiKey = provided
    next()
  }

  const guardAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!config.httpAuthToken) {
      next()
      return
    }
    const header = req.headers.authorization
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (!provided || !tokenMatches(provided, config.httpAuthToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      rpcError(res, 401, 'Unauthorized: send "Authorization: Bearer <token>".')
      return
    }
    next()
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, name: 'hypedexer-mcp', protocol: 'stateless' })
  })

  // Clients and tool registration setup are per-process; only the McpServer
  // instance is rebuilt per request (the v2 per-request-factory model). In
  // apikey mode a per-request context (caller's key, metering headers, gated
  // groups) rides an AsyncLocalStorage into the factory, keeping the SDK
  // handler signature untouched.
  const ctx = createContext(config, logger)
  const als = new AsyncLocalStorage<ToolContext>()
  const handler = createMcpHandler(() => buildServer(als.getStore() ?? ctx).server, {
    legacy: 'stateless',
    onerror: (err) => logger.error('mcp handler error', { error: err.message }),
  })
  const mcpRoute = toNodeHandler(handler, {
    onerror: (err) => logger.error('mcp request adapter error', { error: err.message }),
  })

  app.use('/mcp', guardOriginAndHost, apikeyMode ? guardApiKey : guardAuth)
  // One X-MCP-Call id per HTTP exchange: in the stateless protocol one POST is
  // one JSON-RPC message, so a tools/call meters as exactly one tool call
  // upstream however many REST requests the handler fans out into.
  const runWithRequestCtx = (res: Response, fn: () => void): void => {
    if (!apikeyMode) {
      fn()
      return
    }
    const apiKey = typeof res.locals.apiKey === 'string' ? res.locals.apiKey : undefined
    als.run(createRequestContext(ctx, apiKey, randomUUID()), fn)
  }
  // express.json() already drained the stream, so the parsed body must be
  // forwarded explicitly; GET/DELETE have no body and pass none.
  app.post('/mcp', (req: Request, res: Response) =>
    runWithRequestCtx(res, () => void mcpRoute(req, res, req.body)),
  )
  app.get('/mcp', (req: Request, res: Response) =>
    runWithRequestCtx(res, () => void mcpRoute(req, res)),
  )
  app.delete('/mcp', (req: Request, res: Response) =>
    runWithRequestCtx(res, () => void mcpRoute(req, res)),
  )

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(config.httpPort, config.httpHost, () => {
      logger.info('hypedexer-mcp listening on http', {
        url: `http://${config.httpHost}:${config.httpPort}/mcp`,
        auth: config.httpAuthToken ? 'bearer' : 'none (loopback)',
      })
      resolve(s)
    })
  })

  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    await handler.close().catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const drain = (signal: string): void => {
    logger.info(`received ${signal}, closing http transport`)
    void close().then(() => process.exit(0))
  }
  process.once('SIGTERM', () => drain('SIGTERM'))
  process.once('SIGINT', () => drain('SIGINT'))

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.httpPort

  return { server, port, close }
}
