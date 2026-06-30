import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, HYPEDEXER_MCP_TOOLS: 'public', HYPEDEXER_LOG_LEVEL: 'error' },
})
const client = new Client({ name: 'smoke', version: '0.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log('TOOLS (' + tools.length + '):', tools.map((t) => t.name).join(', '))

// Live keyless call against api.hyperliquid.xyz
const mids = await client.callTool({ name: 'hl_public_all_mids', arguments: {} })
const midData = mids.structuredContent?.data ?? {}
const sample = Object.entries(midData).slice(0, 4)
console.log('all_mids sample:', JSON.stringify(sample))
console.log('BTC mid:', midData.BTC ?? '(n/a)')

// A tool with an enum arg
const meta = await client.callTool({ name: 'hl_public_perp_meta', arguments: { view: 'universe' } })
const universe = meta.structuredContent?.data?.universe ?? []
console.log('perp universe size:', Array.isArray(universe) ? universe.length : 'n/a')

// Error path: bad address should produce a steering error, not a crash
const bad = await client.callTool({ name: 'hl_public_clearinghouse_state', arguments: { user: 'nope' } })
console.log('bad-address isError:', bad.isError, '| msg:', bad.content?.[0]?.text?.slice(0, 80))

await client.close()
console.log('SMOKE OK')
