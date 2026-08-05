import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: {
    ...process.env,
    HYPEDEXER_API_KEY: 'test-dummy-key',
    HYPEDEXER_MCP_TOOLS: 'all,info',
    HYPEDEXER_LOG_LEVEL: 'error',
  },
})
const client = new Client({ name: 'smoke-full', version: '0.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log('TOTAL TOOLS:', tools.length)
const byPrefix = {}
for (const t of tools) {
  const p = t.name.startsWith('hl_public_') ? 'hl_public' : 'hd'
  byPrefix[p] = (byPrefix[p] ?? 0) + 1
}
console.log('by prefix:', JSON.stringify(byPrefix))

// Every tool must have a description and an inputSchema
const bad = tools.filter((t) => !t.description || !t.inputSchema)
console.log('tools missing description/inputSchema:', bad.map((t) => t.name).join(',') || 'none')

// Sample 5 tool names + their input keys
for (const t of tools.filter((t) => t.name.startsWith('hd_')).slice(0, 5)) {
  console.log(`  ${t.name}: inputs=[${Object.keys(t.inputSchema.properties ?? {}).join(',')}]`)
}

// Live keyless
const mids = await client.callTool({ name: 'hl_public_all_mids', arguments: {} })
console.log('LIVE hl_public_all_mids BTC:', mids.structuredContent?.data?.BTC ?? 'n/a')

// Keyed tool with dummy key -> expect steering auth error, not a crash
const keyed = await client.callTool({
  name: 'hd_fills_search',
  arguments: { scope: 'perp', limit: 5 },
})
console.log(
  'hd_fills_search isError:',
  keyed.isError,
  '| msg:',
  String(keyed.content?.[0]?.text).slice(0, 90),
)

// A view-enum keyed tool validation: bad enum should be rejected by schema
let enumRejected = false
try {
  await client.callTool({ name: 'hd_hip3_auctions', arguments: { view: 'bogus' } })
} catch (e) {
  enumRejected = true
}
console.log('hd_hip3_auctions bad-enum rejected by schema:', enumRejected)

await client.close()
console.log('FULL SMOKE OK')
