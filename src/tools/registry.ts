import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config, ToolGroup } from '../config.js'
import type { Logger } from '../logger.js'
import type { ToolContext } from './context.js'
import { handleToolError } from './shared/errors.js'
import type { ToolDef, ToolModule } from './types.js'

export interface RegisterResult {
  registered: number
  skipped: number
  byGroup: Partial<Record<ToolGroup, number>>
}

/**
 * Register every tool whose group is enabled, wrapping each handler so thrown
 * errors become recovery-steering tool errors instead of crashing the call.
 */
export function registerAll(
  server: McpServer,
  ctx: ToolContext,
  modules: ToolModule[],
  config: Config,
  logger: Logger,
): RegisterResult {
  const result: RegisterResult = { registered: 0, skipped: 0, byGroup: {} }
  const enabled = config.enabledGroups

  for (const mod of modules) {
    for (const def of mod) {
      if (!enabled.has(def.group)) {
        result.skipped++
        continue
      }
      registerOne(server, ctx, def)
      result.registered++
      result.byGroup[def.group] = (result.byGroup[def.group] ?? 0) + 1
    }
  }

  logger.info('tools registered', {
    registered: result.registered,
    skipped: result.skipped,
    groups: [...enabled].sort(),
  })
  return result
}

function registerOne(server: McpServer, ctx: ToolContext, def: ToolDef): void {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true, ...(def.annotations ?? {}) },
    },
    // The SDK parses args against inputSchema before calling us.
    async (args: unknown) => {
      try {
        return await def.handler(args as never, ctx)
      } catch (err) {
        return handleToolError(err)
      }
    },
  )
}
