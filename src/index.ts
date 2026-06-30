import { loadConfig } from './config.js'
import { loadDotenv } from './env.js'
import { createLogger } from './logger.js'
import { createServer } from './server.js'
import { startHttp } from './transports/http.js'
import { startStdio } from './transports/stdio.js'

async function main(): Promise<void> {
  // Populate process.env from a .env file (if any) before reading config.
  // Already-set vars win, so an MCP client's `env` block still takes precedence.
  loadDotenv()

  const argv = process.argv.slice(2)
  const wantHttp = argv.includes('--http')

  const config = loadConfig()
  if (wantHttp) config.transport = 'http'

  const logger = createLogger(config.logLevel, { name: 'hypedexer-mcp' })

  if (config.transport === 'http') {
    await startHttp(config, logger)
    return
  }

  const built = createServer(config, logger)
  await startStdio(built)
}

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
})
