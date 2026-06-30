import { describe, expect, it } from 'vitest'
import { AuthError, ValidationError } from '../src/core/errors.js'
import { RpcClient, collectEthSubscription } from '../src/hypedexer/rpc-client.js'
import type { WsConstructor } from '../src/hypedexer/ws-client.js'

function fakeFetch(
  status: number,
  bodyObj: unknown,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(bodyObj),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('RpcClient', () => {
  it('sends a well-formed JSON-RPC request with the API-key header and returns result', async () => {
    const { fetchImpl, calls } = fakeFetch(200, { jsonrpc: '2.0', id: 1, result: '0x1a' })
    const client = new RpcClient({ baseUrl: 'https://rpc.hypedexer.com', apiKey: 'k', fetchImpl })
    const result = await client.call('eth_blockNumber', [])
    expect(result).toBe('0x1a')
    const call = calls[0]
    expect(call?.url).toBe('https://rpc.hypedexer.com')
    expect((call?.init.headers as Record<string, string>)['X-API-Key']).toBe('k')
    expect(JSON.parse(call?.init.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    })
  })

  it('refuses state-mutating methods', async () => {
    const { fetchImpl } = fakeFetch(200, { result: '0x' })
    const client = new RpcClient({ baseUrl: 'https://rpc.hypedexer.com', apiKey: 'k', fetchImpl })
    await expect(client.call('eth_sendRawTransaction', ['0xdeadbeef'])).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('maps a JSON-RPC error object to a ValidationError', async () => {
    const { fetchImpl } = fakeFetch(200, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'invalid params' },
    })
    const client = new RpcClient({ baseUrl: 'https://rpc.hypedexer.com', apiKey: 'k', fetchImpl })
    await expect(client.call('eth_call', [{}])).rejects.toThrow(/-32602|invalid params/)
  })

  it('maps an HTTP 401 to an AuthError', async () => {
    const { fetchImpl } = fakeFetch(401, 'unauthorized')
    const client = new RpcClient({ baseUrl: 'https://rpc.hypedexer.com', apiKey: 'bad', fetchImpl })
    await expect(client.call('eth_blockNumber', [])).rejects.toBeInstanceOf(AuthError)
  })
})

// --- eth_subscribe collector ---

class FakeWS {
  static instances: FakeWS[] = []
  static last(): FakeWS {
    const ws = FakeWS.instances.at(-1)
    if (!ws) throw new Error('no FakeWS')
    return ws
  }
  sent: string[] = []
  closed = false
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}
  constructor(
    readonly url: string,
    readonly opts?: { headers?: Record<string, string> },
  ) {
    FakeWS.instances.push(this)
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const l = this.listeners[type]
    if (l) l.push(cb)
    else this.listeners[type] = [cb]
  }
  send(d: string): void {
    this.sent.push(d)
  }
  close(): void {
    this.closed = true
  }
  private emit(type: string, ev?: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev)
  }
  fireOpen(): void {
    this.emit('open')
  }
  fireMessage(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) })
  }
}

describe('collectEthSubscription', () => {
  it('subscribes, collects eth_subscription notifications, and stops at max_items', async () => {
    FakeWS.instances = []
    const p = collectEthSubscription({
      wsUrl: 'wss://rpc.hypedexer.com',
      apiKey: 'k',
      subscriptionType: 'newHeads',
      durationMs: 10_000,
      maxItems: 2,
      WebSocketImpl: FakeWS as unknown as WsConstructor,
    })
    const ws = FakeWS.last()
    expect(ws.opts?.headers?.['X-API-Key']).toBe('k')
    ws.fireOpen()
    expect(JSON.parse(ws.sent[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_subscribe',
      params: ['newHeads'],
    })
    // subscribe ack (ignored)
    ws.fireMessage({ jsonrpc: '2.0', id: 1, result: '0xsubid' })
    ws.fireMessage({
      method: 'eth_subscription',
      params: { subscription: '0xsubid', result: { number: '0x1' } },
    })
    ws.fireMessage({
      method: 'eth_subscription',
      params: { subscription: '0xsubid', result: { number: '0x2' } },
    })
    const r = await p
    expect(r.item_count).toBe(2)
    expect(r.subscription_type).toBe('newHeads')
    expect((r.items[0] as { number: string }).number).toBe('0x1')
    expect(ws.closed).toBe(true)
  })

  it('passes the filter object for a logs subscription', () => {
    FakeWS.instances = []
    collectEthSubscription({
      wsUrl: 'wss://rpc.hypedexer.com',
      apiKey: 'k',
      subscriptionType: 'logs',
      filter: { address: '0xabc' },
      WebSocketImpl: FakeWS as unknown as WsConstructor,
    })
    const ws = FakeWS.last()
    ws.fireOpen()
    expect(JSON.parse(ws.sent[0] ?? '').params).toEqual(['logs', { address: '0xabc' }])
  })
})
