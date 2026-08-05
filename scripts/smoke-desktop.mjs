import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// Strip every HYPEDEXER_* var so the server MUST get them from .env (as it will
// under Claude Desktop). cwd=/tmp proves the package-root .env fallback works.
const env = { ...process.env }
for (const k of Object.keys(env)) if (k.startsWith('HYPEDEXER_')) delete env[k]

const transport = new StdioClientTransport({
  command: 'bash',
  args: ['/home/yaugourt/hypedexer-mcp/scripts/launch.sh'],
  env,
  cwd: '/tmp',
})
const client = new Client({ name: 'desktop-smoke', version: '0.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
const hd = tools.filter((t) => t.name.startsWith('hd_')).length
const pub = tools.filter((t) => t.name.startsWith('hl_public_')).length
// Keyed hd_ tools appear only when BOTH the API key and a keyed MCP_TOOLS spec
// loaded from .env, so hd_ > 0 is the real "did .env load" signal (exact count
// depends on the preset; `all` excludes the opt-in-only info/rpc groups).
console.log(
  `tools: ${tools.length}  (hd_=${hd}, hl_public_=${pub})  -> key+MCP_TOOLS loaded from .env: ${hd > 0 && pub === 8 ? 'YES' : 'NO'}`,
)

const ov = await client.callTool({ name: 'hd_hip3_overview', arguments: {} })
console.log(
  'hd_hip3_overview:',
  ov.isError
    ? 'ERROR ' + ov.content?.[0]?.text?.slice(0, 60)
    : JSON.stringify(ov.structuredContent?.data).slice(0, 90),
)

const mids = await client.callTool({ name: 'hl_public_all_mids', arguments: {} })
console.log('hl_public_all_mids BTC:', mids.structuredContent?.data?.BTC ?? 'n/a')

await client.close()
console.log('DESKTOP SIMULATION OK - this is exactly what Claude Desktop will run')
