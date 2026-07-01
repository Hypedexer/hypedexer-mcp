import { WSAuthError, WebSocketError } from '../core/errors.js'

/**
 * Indexed (multiplex) channels — the HypeDexer indexer feed on `wss://.../ws`.
 * From the live server's `welcome` frame (swagger only documents
 * `completed_trades`). Note the singular `liquidation`. `recent_activity` is a
 * multiplexed firehose that re-emits the others with an extra `stream` field.
 */
export const WS_CHANNELS = [
  'completed_trades',
  'fills_spot',
  'recent_activity',
  'liquidation',
  'hip4_events',
] as const

/**
 * Live (mirror) channels — Hyperliquid live feeds proxied on
 * `wss://.../ws?mode=mirror`. Distinct subscription types and a different data
 * envelope (`{ channel, data: {...} }`) from the multiplex protocol.
 */
export const LIVE_CHANNELS = [
  'allFills',
  'userFills',
  'bbo',
  'l2Book',
  'l4Book',
  'l4BookUpdates',
  'trades',
  'allMids',
] as const

export type WsChannel = (typeof WS_CHANNELS)[number]
export type LiveChannel = (typeof LIVE_CHANNELS)[number]
export type WsMode = 'multiplex' | 'mirror'

/** Frame `type` values that are control/handshake frames, not data, on either protocol. */
const CONTROL_TYPES = new Set([
  'connected',
  'welcome',
  'subscription_added',
  'subscription_removed',
  'subscriptions_list',
  'subscriptionUpdate',
])

/**
 * Mirror-mode `channel` values that carry acks/control, not subscription data.
 * The mirror hub echoes each `subscribe` back as `{ channel: "subscriptionResponse",
 * data: { method, subscription } }`, the same envelope as a data frame, so it must
 * be filtered explicitly or it pollutes the collected items.
 */
const MIRROR_CONTROL_CHANNELS = new Set(['subscriptionResponse'])

/** Minimal structural type for the events a WHATWG WebSocket dispatches. */
interface WsEvent {
  data?: unknown
  code?: number
  reason?: string
  message?: string
}

/** Minimal structural surface of a WHATWG WebSocket (native global or a test double). */
interface WsLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (ev: WsEvent) => void): void
}

/** Constructor shape: native `WebSocket` accepts a non-standard `{ headers }` option in Node. */
export type WsConstructor = new (url: string, opts?: { headers?: Record<string, string> }) => WsLike

export interface CollectOptions {
  /** HypeDexer HTTPS base URL; the WSS URL is derived from it unless `wsUrl` is set. */
  baseUrl: string
  apiKey: string
  channel: string
  /** `multiplex` (indexed, default) or `mirror` (live). Controls the URL and the data envelope. */
  mode?: WsMode
  /** Wallet to scope to (completed_trades on multiplex, userFills on mirror). */
  user?: string
  /** Coin to scope to (mirror book/trade channels: bbo, l2Book, l4Book, l4BookUpdates, trades). */
  coin?: string
  /** How long to listen before closing and returning, in ms (default 5000). */
  durationMs?: number
  /** Stop early once this many items have been collected (default 200). */
  maxItems?: number
  /** Reject if the socket has not opened within this many ms (default 10000). */
  connectTimeoutMs?: number
  /** Explicit WSS URL override (otherwise derived from `baseUrl`). */
  wsUrl?: string
  /** Injectable WebSocket constructor for tests; defaults to the global. */
  WebSocketImpl?: WsConstructor
}

export interface CollectResult {
  channel: string
  mode: WsMode
  user?: string
  coin?: string
  /** Items collected: flattened push-array items (multiplex) or per-frame data objects (mirror). */
  items: unknown[]
  /** Number of data frames received. */
  message_count: number
  /** Total number of items collected (items.length). */
  item_count: number
  /** Actual wall-clock listen time, in ms. */
  elapsed_ms: number
  stopped_by: 'duration' | 'max_items' | 'closed'
  warnings: string[]
}

const DEFAULT_DURATION_MS = 5_000
const DEFAULT_MAX_ITEMS = 200
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** Derive the WSS endpoint from the HTTPS base URL, adding `?mode=mirror` for live channels. */
export function deriveWsUrl(
  baseUrl: string,
  override?: string,
  mode: WsMode = 'multiplex',
): string {
  let u: string
  if (override && override.trim() !== '') {
    u = override.trim()
  } else {
    u = baseUrl.trim().replace(/^http/i, 'ws') // http->ws, https->wss
    u = u.replace(/\/+$/, '')
    if (!/\/ws$/.test(u)) u += '/ws'
  }
  if (mode === 'mirror' && !/[?&]mode=/.test(u)) {
    u += `${u.includes('?') ? '&' : '?'}mode=mirror`
  }
  return u
}

function describe(ev: WsEvent | undefined): string {
  if (!ev) return 'no detail'
  if (typeof ev.message === 'string' && ev.message.length > 0) return ev.message
  if (typeof ev.code === 'number') return `close code ${ev.code}`
  return 'connection error'
}

/**
 * Open the HypeDexer WebSocket, subscribe to one channel, collect pushed messages
 * for a bounded window, then close and return the batch. This adapts the
 * push/streaming WS surface to a request/response MCP tool: each call is a
 * point-in-time snapshot, not a persistent subscription. The window (max ~30s by
 * the caller's schema) stays well under the server's idle cutoff, so no heartbeat
 * is needed. Handles both protocols: `multiplex` data frames are
 * `{ type, count, data: [] }`; `mirror` data frames are `{ channel, data: {} }`.
 */
export function collectChannel(opts: CollectOptions): Promise<CollectResult> {
  const WS = (opts.WebSocketImpl ?? (globalThis as { WebSocket?: unknown }).WebSocket) as
    | WsConstructor
    | undefined
  const mode: WsMode = opts.mode ?? 'multiplex'
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const url = deriveWsUrl(opts.baseUrl, opts.wsUrl, mode)
  const channel = opts.channel

  return new Promise<CollectResult>((resolve, reject) => {
    if (typeof WS !== 'function') {
      reject(
        new WebSocketError(
          'No WebSocket implementation available in this runtime (need Node >=22).',
        ),
      )
      return
    }

    const items: unknown[] = []
    const warnings: string[] = []
    let messageCount = 0
    let opened = false
    let settled = false
    let durationTimer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()

    let ws: WsLike
    try {
      ws = new WS(url, { headers: { 'X-API-Key': opts.apiKey } })
    } catch (err) {
      reject(
        new WebSocketError(`Failed to open WebSocket to ${url}: ${(err as Error).message}`, {
          cause: err,
        }),
      )
      return
    }

    const connectTimer = setTimeout(() => {
      if (!opened) {
        finishError(
          new WSAuthError(
            `WebSocket did not open within ${connectTimeoutMs}ms (no connection established). The upgrade may have been rejected: a 401 (invalid key) or 429 (rate limited on rapid reconnects).`,
          ),
        )
      }
    }, connectTimeoutMs)

    function cleanup(): void {
      clearTimeout(connectTimer)
      if (durationTimer) clearTimeout(durationTimer)
      try {
        ws.close(1000, 'done')
      } catch {
        // ignore: socket may already be closing.
      }
    }

    function finishOk(stoppedBy: CollectResult['stopped_by']): void {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        channel,
        mode,
        ...(opts.user ? { user: opts.user } : {}),
        ...(opts.coin ? { coin: opts.coin } : {}),
        items,
        message_count: messageCount,
        item_count: items.length,
        elapsed_ms: Date.now() - started,
        stopped_by: stoppedBy,
        warnings,
      })
    }

    function finishError(err: WebSocketError): void {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    ws.addEventListener('open', () => {
      opened = true
      clearTimeout(connectTimer)
      const subscription: Record<string, unknown> = { type: channel }
      if (opts.coin) subscription.coin = opts.coin
      if (opts.user) subscription.user = opts.user
      try {
        ws.send(JSON.stringify({ method: 'subscribe', subscription }))
      } catch (err) {
        finishError(
          new WebSocketError(`Failed to send subscribe frame: ${(err as Error).message}`, {
            cause: err,
          }),
        )
        return
      }
      durationTimer = setTimeout(() => finishOk('duration'), durationMs)
    })

    ws.addEventListener('message', (ev) => {
      if (settled) return
      let frame: unknown
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        warnings.push('Received a non-JSON frame; ignored.')
        return
      }
      if (typeof frame !== 'object' || frame === null) return
      const f = frame as Record<string, unknown>

      if (f.type === 'error') {
        finishError(new WebSocketError(`WebSocket server error: ${String(f.message ?? 'unknown')}`))
        return
      }
      // Control/handshake frames on either protocol.
      if (typeof f.type === 'string' && CONTROL_TYPES.has(f.type)) {
        if (
          f.type === 'welcome' &&
          Array.isArray(f.available_subscriptions) &&
          !(f.available_subscriptions as unknown[]).includes(channel)
        ) {
          warnings.push(
            `Channel "${channel}" was not advertised by the server welcome frame. The server silently accepts unknown channels but never sends data for them; check the channel name and the mode (multiplex vs mirror).`,
          )
        }
        return
      }

      if (mode === 'mirror') {
        // Mirror data frame: { channel, data: <object> } — one item per frame.
        // Skip the subscription-ack channel, which shares this envelope.
        if (
          typeof f.channel === 'string' &&
          !MIRROR_CONTROL_CHANNELS.has(f.channel) &&
          'data' in f
        ) {
          messageCount++
          items.push(f.data)
          if (items.length >= maxItems) finishOk('max_items')
        }
        return
      }

      // Multiplex data frame: { type: <channel>, count, data: [...] }.
      if (Array.isArray(f.data)) {
        messageCount++
        for (const item of f.data as unknown[]) {
          items.push(item)
          if (items.length >= maxItems) {
            finishOk('max_items')
            return
          }
        }
      }
    })

    ws.addEventListener('error', (ev) => {
      if (settled) return
      if (opened) {
        if (items.length > 0) finishOk('closed')
        else finishError(new WebSocketError(`WebSocket error after open: ${describe(ev)}.`))
      } else {
        finishError(
          new WSAuthError(
            `WebSocket failed before opening (${describe(ev)}). Likely a rejected upgrade: 401 (invalid key) or 429 (rate limited on rapid reconnects).`,
          ),
        )
      }
    })

    ws.addEventListener('close', (ev) => {
      if (settled) return
      if (opened) {
        // The server may return close code 1011 even on graceful close (upstream quirk); benign.
        finishOk('closed')
      } else {
        finishError(
          new WSAuthError(
            `WebSocket closed before opening (${describe(ev)}). Likely a rejected upgrade: 401 (invalid key) or 429 (rate limited on rapid reconnects).`,
          ),
        )
      }
    })
  })
}
