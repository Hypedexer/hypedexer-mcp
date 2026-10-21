import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { HypedexerClient } from '../src/hypedexer/client.js'
import { HyperliquidPublicClient } from '../src/hyperliquid/public-client.js'
import { createLogger } from '../src/logger.js'
import type { ToolContext } from '../src/tools/context.js'
import { handleToolError } from '../src/tools/shared/errors.js'
import type { AnyToolDef, ToolResult } from '../src/tools/types.js'
import { type MockRoute, mockFetch } from './fixtures.js'

export interface SeenCall {
  url: URL
  method: string
  body: Record<string, unknown> | undefined
}

/** A mocked fetch that also records every request (URL, method, parsed JSON body). */
export function recorder(routes: MockRoute[]): { fetch: typeof fetch; calls: SeenCall[] } {
  const inner = mockFetch(routes)
  const calls: SeenCall[] = []
  const fn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const raw = init?.body
    calls.push({
      url: new URL(url),
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    })
    return inner(input, init)
  }
  return { fetch: fn, calls }
}

export function ctxWith(fetchImpl: typeof fetch): ToolContext {
  return {
    hd: new HypedexerClient({ apiKey: 'k', fetch: fetchImpl }),
    hl: new HyperliquidPublicClient({ fetch: fetchImpl }),
    config: loadConfig({ HYPEDEXER_API_KEY: 'k' }),
    logger: createLogger('silent'),
  }
}

export function findTool(mod: AnyToolDef[], name: string): AnyToolDef {
  const t = mod.find((d) => d.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

/**
 * Run a tool the way the registry does: parse args through its schema (so
 * defaults apply and invalid input throws), then map thrown errors to results.
 */
export async function run(
  mod: AnyToolDef[],
  name: string,
  args: Record<string, unknown>,
  routes: MockRoute[],
): Promise<{ res: ToolResult; calls: SeenCall[]; sc: Record<string, any> }> {
  const def = findTool(mod, name)
  const { fetch, calls } = recorder(routes)
  let res: ToolResult
  try {
    const parsed = z.object(def.inputSchema).parse(args)
    res = await def.handler(parsed, ctxWith(fetch))
  } catch (err) {
    res = handleToolError(err)
  }
  return { res, calls, sc: (res.structuredContent ?? {}) as Record<string, any> }
}
