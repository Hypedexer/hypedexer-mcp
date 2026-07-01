import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { createServer } from '../src/server.js'

async function connect(env: NodeJS.ProcessEnv) {
  const config = loadConfig(env)
  const built = createServer(config, createLogger('silent'))
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([built.server.connect(serverT), client.connect(clientT)])
  return { client, close: () => client.close() }
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe('tool registration over an in-memory MCP session', () => {
  it('registers all 83 tools with valid, unique, snake_case schemas (all groups)', async () => {
    const { client, close } = await connect({
      HYPEDEXER_API_KEY: 'dummy',
      HYPEDEXER_MCP_TOOLS: 'all,info,rpc',
    })
    cleanup = close
    const { tools } = await client.listTools()

    expect(tools).toHaveLength(83)

    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length) // unique

    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(t.description, `${t.name} needs a description`).toBeTruthy()
      expect(t.inputSchema?.type).toBe('object')
      // Read-only annotation is set by the registry.
      expect(t.annotations?.readOnlyHint).toBe(true)
    }

    expect(names.filter((n) => n.startsWith('hl_public_'))).toHaveLength(8)
    expect(names.filter((n) => n.startsWith('hd_'))).toHaveLength(75)
    expect(names.filter((n) => n.startsWith('hd_stream_'))).toHaveLength(5)
    expect(names.filter((n) => n.startsWith('hd_live_'))).toHaveLength(8)
    expect(names.filter((n) => n.startsWith('hd_rpc_'))).toHaveLength(6)
  })

  it('with no API key, exposes only the 8 keyless public tools', async () => {
    const { client, close } = await connect({ HYPEDEXER_MCP_TOOLS: 'all' })
    cleanup = close
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(8)
    expect(tools.every((t) => t.name.startsWith('hl_public_'))).toBe(true)
  })

  it('honors the core preset', async () => {
    const { client, close } = await connect({
      HYPEDEXER_API_KEY: 'dummy',
      HYPEDEXER_MCP_TOOLS: 'core',
    })
    cleanup = close
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('hd_fills_search')
    expect(names).not.toContain('hd_hip3_overview') // hip3 not in core
    expect(names).not.toContain('hd_info_raw') // info never in a preset
  })

  it('rejects an unknown enum value rather than calling the API', async () => {
    const { client, close } = await connect({
      HYPEDEXER_API_KEY: 'dummy',
      HYPEDEXER_MCP_TOOLS: 'all',
    })
    cleanup = close
    // hd_hip3_auctions.view is an enum; "bogus" must be rejected by schema validation.
    const res = await client
      .callTool({ name: 'hd_hip3_auctions', arguments: { view: 'bogus' } })
      .catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }))
    expect(res.isError).toBe(true)
  })
})
