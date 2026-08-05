import { spawn } from 'node:child_process'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const server = spawn('node', ['dist/index.js', '--http'], {
  env: {
    ...process.env,
    HYPEDEXER_MCP_TOOLS: 'public',
    HYPEDEXER_MCP_HTTP_PORT: '3333',
    HYPEDEXER_LOG_LEVEL: 'error',
  },
  stdio: 'inherit',
})
await new Promise((r) => setTimeout(r, 1500))
try {
  const health = await fetch('http://127.0.0.1:3333/health').then((r) => r.json())
  console.log('HTTP /health:', JSON.stringify(health))
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3333/mcp'))
  const client = new Client({ name: 'http-smoke', version: '0.0.0' })
  await client.connect(transport)
  const { tools } = await client.listTools()
  console.log('HTTP tools registered:', tools.length)
  const res = await client.callTool({ name: 'hl_public_all_mids', arguments: {} })
  console.log('HTTP live BTC:', res.structuredContent?.data?.BTC ?? 'n/a')
  await client.close()
  console.log('HTTP SMOKE OK')
} finally {
  server.kill()
}
