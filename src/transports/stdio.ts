import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { BuiltServer } from '../server.js'

/** Connect a built server to stdio (Claude Desktop, Cursor, and most MCP clients). */
export async function startStdio(built: BuiltServer): Promise<void> {
  const transport = new StdioServerTransport()
  await built.server.connect(transport)
  built.logger.info('hypedexer-mcp listening on stdio', {
    tools: built.registration.registered,
  })
}
