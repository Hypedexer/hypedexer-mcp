import type { LogLevel } from './logger.js'
import { VERSION } from './version.js'

/** All tool groups. `public` is keyless; everything else needs HYPEDEXER_API_KEY. */
export const TOOL_GROUPS = [
  'public',
  'fills',
  'markets',
  'analytics',
  'traders',
  'liquidations',
  'funding',
  'vaults',
  'hip3',
  'hip4',
  'builders',
  'twaps',
  'evm',
  'elysium',
  'streams',
  'live',
  'rpc',
  'info',
] as const

export type ToolGroup = (typeof TOOL_GROUPS)[number]

/** Groups that require a HypeDexer API key (everything except the keyless `public` group). */
export const KEYED_GROUPS: ReadonlySet<ToolGroup> = new Set(
  TOOL_GROUPS.filter((g) => g !== 'public'),
)

/**
 * Groups excluded from the `all` preset: they must be opted into by name.
 * - `info`: the raw `/info` escape hatch (advanced, unvalidated inputs).
 * - `rpc`: the HyperEVM JSON-RPC group targets `rpc.hypedexer.com`, which is not
 *   yet deployed (DNS NXDOMAIN as of 2026-07-01). Every call network-errors, so
 *   it is off by default; enable it explicitly (`HYPEDEXER_MCP_TOOLS=all,rpc`)
 *   once the endpoint is live or when pointing HYPEDEXER_RPC_URL at another host.
 */
const OPT_IN_ONLY: ReadonlySet<ToolGroup> = new Set<ToolGroup>(['info', 'rpc'])

/** Named presets the user can pass to HYPEDEXER_MCP_TOOLS instead of a group list. */
export const PRESETS: Record<string, ToolGroup[]> = {
  // Keyless smoke-test surface only.
  public: ['public'],
  // The everyday HypeDexer surface: high-traffic reads, no niche/heavy groups.
  core: ['public', 'fills', 'markets', 'analytics', 'traders', 'liquidations', 'funding', 'vaults'],
  // Everything except the opt-in-only groups (`info`, `rpc`).
  all: TOOL_GROUPS.filter((g) => !OPT_IN_ONLY.has(g)),
}

export type TransportKind = 'stdio' | 'http'

export interface Config {
  /** HypeDexer API key. When absent, only the keyless `public` group is usable. */
  apiKey: string | undefined
  hypedexerBaseUrl: string
  hyperliquidBaseUrl: string
  /** Explicit WSS URL for the streams group. Derived from hypedexerBaseUrl when unset. */
  wsUrl?: string
  /** HyperEVM JSON-RPC HTTP base for the rpc group. */
  rpcBaseUrl: string
  /** HyperEVM JSON-RPC WSS endpoint for eth_subscribe. Derived from rpcBaseUrl when unset. */
  rpcWsUrl: string
  /** Resolved set of enabled tool groups, after applying presets + the key gate. */
  enabledGroups: Set<ToolGroup>
  /** Raw HYPEDEXER_MCP_TOOLS value, for diagnostics. */
  toolsSpec: string
  transport: TransportKind
  httpPort: number
  httpHost: string
  /**
   * Bearer token required on every /mcp request when set. Mandatory when
   * httpHost binds beyond loopback (startHttp refuses to start without it).
   */
  httpAuthToken: string | undefined
  /** Hostnames accepted in the Host header (DNS-rebinding defense). */
  httpAllowedHosts: string[]
  /** Extra Origin values (full origins) accepted besides same-host origins. */
  httpAllowedOrigins: string[]
  requestTimeoutMs: number
  /** Soft cap on tokens a single tool result may emit before truncate-with-steering. */
  maxResponseTokens: number
  logLevel: LogLevel
  userAgent: string
}

const DEFAULTS = {
  hypedexerBaseUrl: 'https://api.hypedexer.com',
  hyperliquidBaseUrl: 'https://api.hyperliquid.xyz',
  rpcBaseUrl: 'https://rpc.hypedexer.com',
  toolsSpec: 'all',
  transport: 'stdio' as TransportKind,
  httpPort: 3000,
  httpHost: '127.0.0.1',
  requestTimeoutMs: 30_000,
  maxResponseTokens: 25_000,
  logLevel: 'info' as LogLevel,
  httpAllowedHosts: ['127.0.0.1', 'localhost', '[::1]', '::1'],
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function csv(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * Resolve the enabled tool groups from a spec string.
 *
 * The spec is either a preset name (`public` | `core` | `all`) or a comma-separated
 * list of group names (optionally including a preset, e.g. `core,evm,info`). Unknown
 * tokens are ignored. Keyed groups are dropped when no API key is present.
 */
export function resolveGroups(spec: string, hasKey: boolean): Set<ToolGroup> {
  const valid = new Set<ToolGroup>(TOOL_GROUPS)
  const out = new Set<ToolGroup>()
  for (const rawToken of spec.split(',')) {
    const token = rawToken.trim().toLowerCase()
    if (token === '') continue
    if (token in PRESETS) {
      for (const g of PRESETS[token] as ToolGroup[]) out.add(g)
    } else if (valid.has(token as ToolGroup)) {
      out.add(token as ToolGroup)
    }
  }
  // `public` is always available - it is the keyless smoke-test surface.
  out.add('public')
  if (!hasKey) {
    for (const g of [...out]) {
      if (KEYED_GROUPS.has(g)) out.delete(g)
    }
  }
  return out
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.HYPEDEXER_API_KEY?.trim() || undefined
  const toolsSpec = env.HYPEDEXER_MCP_TOOLS?.trim() || DEFAULTS.toolsSpec
  const transportEnv = env.HYPEDEXER_MCP_TRANSPORT?.trim().toLowerCase()
  const transport: TransportKind = transportEnv === 'http' ? 'http' : DEFAULTS.transport
  const logLevel = (env.HYPEDEXER_LOG_LEVEL?.trim().toLowerCase() as LogLevel) || DEFAULTS.logLevel

  const wsUrl = env.HYPEDEXER_WS_URL?.trim() || undefined
  const rpcBaseUrl = env.HYPEDEXER_RPC_URL?.trim() || DEFAULTS.rpcBaseUrl
  const rpcWsUrl =
    env.HYPEDEXER_RPC_WS_URL?.trim() || rpcBaseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')

  return {
    apiKey,
    hypedexerBaseUrl: env.HYPEDEXER_BASE_URL?.trim() || DEFAULTS.hypedexerBaseUrl,
    hyperliquidBaseUrl: env.HYPERLIQUID_BASE_URL?.trim() || DEFAULTS.hyperliquidBaseUrl,
    rpcBaseUrl,
    rpcWsUrl,
    ...(wsUrl ? { wsUrl } : {}),
    enabledGroups: resolveGroups(toolsSpec, Boolean(apiKey)),
    toolsSpec,
    transport,
    httpPort: num(env.HYPEDEXER_MCP_HTTP_PORT, DEFAULTS.httpPort),
    httpHost: env.HYPEDEXER_MCP_HTTP_HOST?.trim() || DEFAULTS.httpHost,
    httpAuthToken: env.HYPEDEXER_MCP_HTTP_TOKEN?.trim() || undefined,
    httpAllowedHosts: (() => {
      const extra = csv(env.HYPEDEXER_MCP_HTTP_ALLOWED_HOSTS)
      return extra.length > 0 ? [...DEFAULTS.httpAllowedHosts, ...extra] : DEFAULTS.httpAllowedHosts
    })(),
    httpAllowedOrigins: csv(env.HYPEDEXER_MCP_HTTP_ALLOWED_ORIGINS),
    requestTimeoutMs: num(env.HYPEDEXER_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    maxResponseTokens: num(env.HYPEDEXER_MAX_RESPONSE_TOKENS, DEFAULTS.maxResponseTokens),
    logLevel,
    userAgent: `hypedexer-mcp/${VERSION}`,
  }
}
