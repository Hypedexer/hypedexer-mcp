import {
  NetworkError,
  ServerError,
  ValidationError,
  WSAuthError,
  WebSocketError,
  parseError,
} from '../core/errors.js'
import type { WsConstructor } from './ws-client.js'

interface JsonRpcResponse {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

/** Methods that mutate chain state - refused by the read-only RPC surface. */
export const RPC_WRITE_METHODS = new Set(['eth_sendRawTransaction', 'eth_sendTransaction'])

export interface RpcClientOptions {
  /** HyperEVM JSON-RPC HTTP base, e.g. https://rpc.hypedexer.com */
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  userAgent?: string
}

/**
 * Thin HyperEVM JSON-RPC caller over HTTP POST. Auth is the `X-API-Key` header
 * (same key as REST). HTTP-level failures map through the shared error taxonomy
 * (401 -> AuthError, 429 -> RateLimitError, 5xx -> ServerError); a JSON-RPC
 * `error` object (HTTP 200) becomes a ValidationError carrying the code/message.
 */
export class RpcClient {
  constructor(private readonly opts: RpcClientOptions) {}

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    if (RPC_WRITE_METHODS.has(method)) {
      throw new ValidationError(
        `Method "${method}" mutates chain state and is not allowed on this read-only RPC surface.`,
        [{ msg: 'write method refused', loc: ['method'], type: 'read_only' }],
      )
    }

    const fetchImpl = this.opts.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000)

    let res: Response
    try {
      res = await fetchImpl(this.opts.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.opts.apiKey,
          'User-Agent': this.opts.userAgent ?? 'hypedexer-mcp',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      })
    } catch (err) {
      const msg =
        (err as Error)?.name === 'AbortError' ? 'request timed out' : (err as Error).message
      throw new NetworkError(`Failed to reach the RPC endpoint: ${msg}`, { cause: err })
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    if (!res.ok) {
      throw parseError(res.status, res.headers.get('content-type') ?? '', text)
    }

    let body: JsonRpcResponse
    try {
      body = JSON.parse(text) as JsonRpcResponse
    } catch {
      throw new ServerError(`Non-JSON RPC response (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }

    if (body.error) {
      const code = body.error.code ?? 'unknown'
      const message = body.error.message ?? 'RPC error'
      throw new ValidationError(`JSON-RPC error ${code}: ${message}`, [
        { msg: message, loc: ['params'], type: String(code) },
      ])
    }
    return body.result
  }
}

// --- eth_subscribe collect-window over the JSON-RPC WebSocket -----------------

interface WsEvent {
  data?: unknown
  code?: number
  reason?: string
  message?: string
}
interface WsLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (ev: WsEvent) => void): void
}

export interface EthSubscribeOptions {
  /** JSON-RPC WSS endpoint, e.g. wss://rpc.hypedexer.com */
  wsUrl: string
  apiKey: string
  /** Subscription kind: 'newHeads' | 'logs' | 'newPendingTransactions'. */
  subscriptionType: string
  /** Optional second param (e.g. the filter object for 'logs'). */
  filter?: unknown
  durationMs?: number
  maxItems?: number
  connectTimeoutMs?: number
  WebSocketImpl?: WsConstructor
}

export interface EthSubscribeResult {
  subscription_type: string
  items: unknown[]
  message_count: number
  item_count: number
  elapsed_ms: number
  stopped_by: 'duration' | 'max_items' | 'closed'
  warnings: string[]
}

/**
 * Open the JSON-RPC WebSocket, run a single `eth_subscribe`, collect the
 * `eth_subscription` notifications for a bounded window, then close. Adapts the
 * push subscription to a request/response snapshot, the same way collectChannel
 * does for the HypeDexer hub - but over the Ethereum JSON-RPC WS protocol.
 */
export function collectEthSubscription(opts: EthSubscribeOptions): Promise<EthSubscribeResult> {
  const WS = (opts.WebSocketImpl ?? (globalThis as { WebSocket?: unknown }).WebSocket) as
    | WsConstructor
    | undefined
  const durationMs = opts.durationMs ?? 5_000
  const maxItems = opts.maxItems ?? 200
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000

  return new Promise<EthSubscribeResult>((resolve, reject) => {
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
      ws = new WS(opts.wsUrl, { headers: { 'X-API-Key': opts.apiKey } })
    } catch (err) {
      reject(
        new WebSocketError(
          `Failed to open RPC WebSocket to ${opts.wsUrl}: ${(err as Error).message}`,
          {
            cause: err,
          },
        ),
      )
      return
    }

    const connectTimer = setTimeout(() => {
      if (!opened) {
        finishError(
          new WSAuthError(
            `RPC WebSocket did not open within ${connectTimeoutMs}ms. The upgrade may have been rejected: 401 (invalid key) or 429 (rate limited).`,
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
        // ignore
      }
    }
    function finishOk(stoppedBy: EthSubscribeResult['stopped_by']): void {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        subscription_type: opts.subscriptionType,
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
      const params: unknown[] =
        opts.filter !== undefined ? [opts.subscriptionType, opts.filter] : [opts.subscriptionType]
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params }))
      } catch (err) {
        finishError(
          new WebSocketError(`Failed to send eth_subscribe: ${(err as Error).message}`, {
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

      // Subscribe ack/error: { id: 1, result: "0x..." } or { id: 1, error: {...} }.
      if (f.id !== undefined && f.method === undefined) {
        if (f.error) {
          const e = f.error as { code?: number; message?: string }
          finishError(
            new WebSocketError(`eth_subscribe failed (${e.code ?? '?'}): ${e.message ?? 'error'}`),
          )
        }
        return
      }
      // Notification: { method: "eth_subscription", params: { subscription, result } }.
      if (f.method === 'eth_subscription' && typeof f.params === 'object' && f.params !== null) {
        const p = f.params as Record<string, unknown>
        messageCount++
        items.push('result' in p ? p.result : p)
        if (items.length >= maxItems) finishOk('max_items')
      }
    })

    ws.addEventListener('error', (ev) => {
      if (settled) return
      if (opened) {
        if (items.length > 0) finishOk('closed')
        else
          finishError(
            new WebSocketError(
              `RPC WebSocket error after open: ${ev?.message ?? 'connection error'}.`,
            ),
          )
      } else {
        finishError(
          new WSAuthError(
            `RPC WebSocket failed before opening (${ev?.message ?? 'connection error'}). Likely 401 (invalid key) or 429 (rate limited).`,
          ),
        )
      }
    })

    ws.addEventListener('close', () => {
      if (settled) return
      if (opened) finishOk('closed')
      else finishError(new WSAuthError('RPC WebSocket closed before opening (likely 401 or 429).'))
    })
  })
}
