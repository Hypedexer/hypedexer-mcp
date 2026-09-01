import { type IncomingHttpHeaders, request } from 'node:http'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { type HttpHandle, startHttp } from '../src/transports/http.js'

const logger = createLogger('silent', { name: 'test' })

function testConfig(env: Record<string, string> = {}) {
  const config = loadConfig({
    HYPEDEXER_MCP_TOOLS: 'public',
    HYPEDEXER_MCP_TRANSPORT: 'http',
    HYPEDEXER_MCP_HTTP_PORT: '0',
    ...env,
  })
  return config
}

interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  text: string
}

/** Raw HTTP client: unlike fetch, it allows forging Host and Origin headers. */
function raw(
  port: number,
  opts: {
    method?: string
    path?: string
    headers?: Record<string, string>
    body?: unknown
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 2025-era handshake: served by the SDK's stateless legacy fallback. */
const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
}

let handle: HttpHandle | undefined
afterEach(async () => {
  await handle?.close()
  handle = undefined
})

describe('http transport security', () => {
  it('refuses to start on a non-loopback bind without a token', async () => {
    const config = testConfig({ HYPEDEXER_MCP_HTTP_HOST: '0.0.0.0' })
    await expect(startHttp(config, logger)).rejects.toThrow(/HYPEDEXER_MCP_HTTP_TOKEN/)
  })

  it('requires the bearer token on /mcp when configured', async () => {
    handle = await startHttp(testConfig({ HYPEDEXER_MCP_HTTP_TOKEN: 's3cret' }), logger)

    const noAuth = await raw(handle.port, { body: initializeBody })
    expect(noAuth.status).toBe(401)
    expect(noAuth.headers['www-authenticate']).toBe('Bearer')

    const badAuth = await raw(handle.port, {
      body: initializeBody,
      headers: { authorization: 'Bearer wrong' },
    })
    expect(badAuth.status).toBe(401)

    const goodAuth = await raw(handle.port, {
      body: initializeBody,
      headers: { authorization: 'Bearer s3cret' },
    })
    expect(goodAuth.status).toBe(200)
  })

  it('leaves /health reachable without a token', async () => {
    handle = await startHttp(testConfig({ HYPEDEXER_MCP_HTTP_TOKEN: 's3cret' }), logger)
    const res = await raw(handle.port, { method: 'GET', path: '/health' })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text).ok).toBe(true)
  })

  it('rejects a forged Host header (DNS rebinding)', async () => {
    handle = await startHttp(testConfig(), logger)
    const res = await raw(handle.port, {
      body: initializeBody,
      headers: { host: 'evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  it('rejects a disallowed Origin and accepts a loopback one', async () => {
    handle = await startHttp(testConfig(), logger)

    const evil = await raw(handle.port, {
      body: initializeBody,
      headers: { origin: 'http://evil.example.com' },
    })
    expect(evil.status).toBe(403)

    const local = await raw(handle.port, {
      body: initializeBody,
      headers: { origin: 'http://localhost:5173' },
    })
    expect(local.status).toBe(200)
  })

  it('accepts an explicitly allowlisted Origin', async () => {
    handle = await startHttp(
      testConfig({ HYPEDEXER_MCP_HTTP_ALLOWED_ORIGINS: 'https://app.example.com' }),
      logger,
    )
    const res = await raw(handle.port, {
      body: initializeBody,
      headers: { origin: 'https://app.example.com' },
    })
    expect(res.status).toBe(200)
  })
})

describe('http transport protocol (stateless)', () => {
  it('answers a 2025-era initialize without minting a session', async () => {
    handle = await startHttp(testConfig(), logger)
    const res = await raw(handle.port, { body: initializeBody })
    expect(res.status).toBe(200)
    expect(res.headers['mcp-session-id']).toBeUndefined()
    expect(res.text).toContain('"serverInfo"')
  })

  it('serves a modern v2 client end to end', async () => {
    handle = await startHttp(testConfig(), logger)
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    )
    const client = new Client({ name: 'test-modern', version: '0.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.map((t) => t.name)).toContain('hl_public_all_mids')
    } finally {
      await client.close()
    }
  })
})

describe('http transport apikey mode (hosted multi-tenant)', () => {
  const apikeyEnv = {
    HYPEDEXER_MCP_AUTH_MODE: 'apikey',
    HYPEDEXER_MCP_TOOLS: 'public,markets',
    HYPEDEXER_BASE_URL: 'https://api.test.local',
    HYPEDEXER_MCP_UPSTREAM_SECRET: 'edge-shared-secret',
  }

  it('rejects a malformed bearer with 401', async () => {
    handle = await startHttp(testConfig(apikeyEnv), logger)
    const res = await raw(handle.port, {
      headers: { authorization: 'Bearer not a key' },
      body: initializeBody,
    })
    expect(res.status).toBe(401)
    expect(res.text).toContain('HypeDexer API key')
  })

  it('serves keyless requests with only public tools', async () => {
    handle = await startHttp(testConfig(apikeyEnv), logger)
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    )
    const client = new Client({ name: 'test-keyless', version: '0.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.length).toBeGreaterThan(0)
      for (const t of tools) expect(t.name).toMatch(/^hl_public_/)
    } finally {
      await client.close()
    }
  })

  it('registers keyed tools for a bearer key and forwards it with metering headers', async () => {
    handle = await startHttp(testConfig(apikeyEnv), logger)
    const captured: Array<{ url: string; headers: Record<string, string> }> = []
    const realFetch = globalThis.fetch
    // Selective stub: intercept upstream HypeDexer calls, pass the MCP
    // client's own loopback traffic through to the real fetch.
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://api.test.local')) {
        captured.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } })
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input, init)
    }) as typeof fetch
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: { headers: { authorization: 'Bearer hd_test_1234567890' } } },
    )
    const client = new Client({ name: 'test-keyed', version: '0.0.0' })
    try {
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('hd_market_snapshot_24h')

      await client.callTool({ name: 'hd_market_snapshot_24h', arguments: {} })
      expect(captured.length).toBe(5)
      const callIds = new Set<string>()
      for (const req of captured) {
        expect(req.headers['X-API-Key']).toBe('hd_test_1234567890')
        expect(req.headers['X-MCP-Server']).toBe('edge-shared-secret')
        expect(req.headers['X-MCP-Call']).toMatch(/^[0-9a-f-]{36}$/)
        callIds.add(req.headers['X-MCP-Call'] as string)
      }
      // One tool call fans out into five REST requests but meters exactly once.
      expect(callIds.size).toBe(1)
    } finally {
      globalThis.fetch = realFetch
      await client.close()
    }
  })
})
