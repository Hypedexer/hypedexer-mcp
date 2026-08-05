import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// Read the key straight from this repo's .env so it never hits argv/logs.
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const key = env.match(/^HYPEDEXER_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('HYPEDEXER_API_KEY not found in .env')
console.log('key loaded:', key.slice(0, 6) + '…(masked, len ' + key.length + ')')

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: {
    ...process.env,
    HYPEDEXER_API_KEY: key,
    HYPEDEXER_MCP_TOOLS: 'all,info',
    HYPEDEXER_LOG_LEVEL: 'error',
  },
})
const client = new Client({ name: 'keyed-smoke', version: '0.0.0' })
await client.connect(transport)
const { tools } = await client.listTools()
console.log('tools registered:', tools.length, '\n')

function summarize(res) {
  if (res.isError) return 'ERROR: ' + String(res.content?.[0]?.text).split('\n')[0].slice(0, 70)
  const sc = res.structuredContent ?? {}
  const d = sc.data
  let s
  if (Array.isArray(d)) s = `${d.length} rows`
  else if (d && typeof d === 'object') s = `obj{${Object.keys(d).slice(0, 4).join(',')}}`
  else s = String(d).slice(0, 40)
  if (sc.pagination?.has_more)
    s += ` +more(${sc.pagination.next_cursor ? 'cursor' : sc.pagination.next_offset !== undefined ? 'offset' : 'time'})`
  if (sc.notes?.length) s += ` [note]`
  return s
}

const calls = [
  ['hd_market_snapshot_24h', {}],
  ['hd_fills_search', { scope: 'perp', recent: true, limit: 3 }],
  ['hd_fills_count', {}],
  ['hd_liquidations_search', { recent: true, limit: 3 }],
  ['hd_traders_leaderboard', { by: 'pnl', limit: 3 }],
  ['hd_analytics_fills_stats', {}],
  ['hd_funding_predicted', {}],
  ['hd_funding_history', { coin: 'BTC', limit: 3 }],
  ['hd_vaults_list', { limit: 3 }],
  ['hd_hip3_overview', {}],
  ['hd_hip3_dexs', { limit: 3 }],
  ['hd_hip3_assets', { limit: 3 }],
  ['hd_hip4_markets', { limit: 3 }],
  ['hd_builders', { view: 'top', limit: 3 }],
  ['hd_twaps_search', { limit: 3 }],
  ['hd_evm_stats', { view: 'current' }],
  ['hd_evm_blocks', { limit: 3 }],
]

let ok = 0,
  err = 0
for (const [name, args] of calls) {
  try {
    const res = await client.callTool({ name, arguments: args })
    const sum = summarize(res)
    if (res.isError) err++
    else ok++
    console.log(`  ${res.isError ? '✗' : '✓'} ${name.padEnd(28)} ${sum}`)
  } catch (e) {
    err++
    console.log(`  ✗ ${name.padEnd(28)} THREW: ${String(e.message).slice(0, 60)}`)
  }
}
console.log(`\nRESULT: ${ok} ok / ${err} error of ${calls.length}`)
await client.close()
