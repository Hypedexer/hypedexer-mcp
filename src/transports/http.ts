import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import { createServer } from '../server.js'

/**
 * Streamable-HTTP transport with per-session isolation. Each MCP session gets
 * its own `McpServer` + transport, tracked by the `mcp-session-id` header. This
 * is the shape a hosted deployment (mcp.hypedexer.com) runs.
 *
 * Security posture (AUDIT.md H1-H3):
 * - Bearer auth on /mcp when HYPEDEXER_MCP_HTTP_TOKEN is set; the token is
 *   MANDATORY when binding beyond loopback (startup refuses otherwise).
 * - Host and Origin allowlisting on /mcp (DNS-rebinding defense).
 * - Sessions carry a lastSeen stamp; an idle reaper closes them past the TTL,
 *   a hard cap 503s new sessions, and SIGTERM/SIGINT drain everything.
 */

interface SessionEntry {
  transport: StreamableHTTPServerTransport
  lastSeen: number
}

export interface HttpHandle {
  server: Server
  port: number
  /** Number of live MCP sessions (for tests and diagnostics). */
  sessionCount(): number
  close(): Promise<void>
}

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

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
  if (!isLoopbackBind && !config.httpAuthToken) {
    throw new Error(
      `Refusing to bind the HTTP transport to ${config.httpHost} without authentication. Set HYPEDEXER_MCP_HTTP_TOKEN (clients must send "Authorization: Bearer <token>"), or keep the default loopback bind.`,
    )
  }
  if (isLoopbackBind && !config.httpAuthToken) {
    logger.warn(
      'http transport is unauthenticated (loopback only). Set HYPEDEXER_MCP_HTTP_TOKEN to require a bearer token.',
    )
  }

  const allowedHosts = new Set(config.httpAllowedHosts.map((h) => h.toLowerCase()))
  allowedHosts.add(config.httpHost.toLowerCase())
  const allowedOrigins = new Set(config.httpAllowedOrigins.map((o) => o.toLowerCase()))

  const app = express()
  app.use(express.json({ limit: '4mb' }))

  const sessions = new Map<string, SessionEntry>()

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
    res.json({ ok: true, name: 'hypedexer-mcp', sessions: sessions.size })
  })

  app.use('/mcp', guardOriginAndHost, guardAuth)

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const entry = sessionId ? sessions.get(sessionId) : undefined
    let transport = entry?.transport

    if (entry) entry.lastSeen = Date.now()

    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        rpcError(res, 400, 'No valid session. Send an initialize request first.')
        return
      }
      if (sessions.size >= config.httpMaxSessions) {
        rpcError(res, 503, `Session limit reached (${config.httpMaxSessions}). Retry later.`)
        return
      }
      // New session: fresh server + transport.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, {
            transport: transport as StreamableHTTPServerTransport,
            lastSeen: Date.now(),
          })
          logger.info('mcp session opened', { sessionId: sid, sessions: sessions.size })
        },
      })
      transport.onclose = () => {
        const sid = transport?.sessionId
        if (sid && sessions.delete(sid)) {
          logger.info('mcp session closed', { sessionId: sid, sessions: sessions.size })
        }
      }
      const built = createServer(config, logger)
      // Cast: the SDK's concrete transport types `onclose` as `(() => void) | undefined`,
      // which trips exactOptionalPropertyTypes against the Transport interface.
      await built.server.connect(transport as unknown as Parameters<typeof built.server.connect>[0])
    }

    await transport.handleRequest(req, res, req.body)
  })

  // GET (server-sent stream) and DELETE (terminate) reuse the session transport.
  const sessionRoute = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const entry = sessionId ? sessions.get(sessionId) : undefined
    if (!entry) {
      res.status(400).send('Invalid or missing mcp-session-id')
      return
    }
    entry.lastSeen = Date.now()
    await entry.transport.handleRequest(req, res)
  }
  app.get('/mcp', sessionRoute)
  app.delete('/mcp', sessionRoute)

  const reapIdleSessions = async (): Promise<void> => {
    const cutoff = Date.now() - config.httpSessionTtlMs
    for (const [sid, entry] of sessions) {
      if (entry.lastSeen < cutoff) {
        sessions.delete(sid)
        logger.info('mcp session reaped (idle)', { sessionId: sid, sessions: sessions.size })
        await entry.transport.close().catch(() => {})
      }
    }
  }
  const reapEveryMs = Math.min(60_000, Math.max(1_000, Math.floor(config.httpSessionTtlMs / 4)))
  const reaper = setInterval(() => void reapIdleSessions(), reapEveryMs)
  reaper.unref()

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
    clearInterval(reaper)
    for (const [sid, entry] of sessions) {
      sessions.delete(sid)
      await entry.transport.close().catch(() => {})
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const drain = (signal: string): void => {
    logger.info(`received ${signal}, draining http sessions`)
    void close().then(() => process.exit(0))
  }
  process.once('SIGTERM', () => drain('SIGTERM'))
  process.once('SIGINT', () => drain('SIGINT'))

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.httpPort

  return { server, port, sessionCount: () => sessions.size, close }
}
