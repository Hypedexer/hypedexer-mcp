import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express, { type Request, type Response } from 'express'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import { createServer } from '../server.js'

/**
 * Streamable-HTTP transport with per-session isolation. Each MCP session gets
 * its own `McpServer` + transport, tracked by the `mcp-session-id` header. This
 * is the shape a hosted deployment (mcp.hypedexer.com) runs.
 */
export async function startHttp(config: Config, logger: Logger): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '4mb' }))

  const transports = new Map<string, StreamableHTTPServerTransport>()

  app.get('/health', (_req, res) => {
    res.json({ ok: true, name: 'hypedexer-mcp', sessions: transports.size })
  })

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport = sessionId ? transports.get(sessionId) : undefined

    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'No valid session. Send an initialize request first.' },
          id: null,
        })
        return
      }
      // New session: fresh server + transport.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport as StreamableHTTPServerTransport)
          logger.info('mcp session opened', { sessionId: sid, sessions: transports.size })
        },
      })
      transport.onclose = () => {
        const sid = transport?.sessionId
        if (sid && transports.delete(sid)) {
          logger.info('mcp session closed', { sessionId: sid, sessions: transports.size })
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
    const transport = sessionId ? transports.get(sessionId) : undefined
    if (!transport) {
      res.status(400).send('Invalid or missing mcp-session-id')
      return
    }
    await transport.handleRequest(req, res)
  }
  app.get('/mcp', sessionRoute)
  app.delete('/mcp', sessionRoute)

  await new Promise<void>((resolve) => {
    app.listen(config.httpPort, config.httpHost, () => {
      logger.info('hypedexer-mcp listening on http', {
        url: `http://${config.httpHost}:${config.httpPort}/mcp`,
      })
      resolve()
    })
  })
}
