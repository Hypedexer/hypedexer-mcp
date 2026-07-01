import { describe, expect, it } from 'vitest'
import { WSAuthError, WebSocketError } from '../src/core/errors.js'
import {
  type CollectOptions,
  type WsConstructor,
  collectChannel,
  deriveWsUrl,
} from '../src/hypedexer/ws-client.js'

/**
 * A scriptable WebSocket double. The constructor records the instance so the test
 * can drive open/message/error/close after kicking off collectChannel (whose
 * Promise executor constructs the socket synchronously).
 */
class FakeWS {
  static instances: FakeWS[] = []
  static last(): FakeWS {
    const ws = FakeWS.instances.at(-1)
    if (!ws) throw new Error('no FakeWS constructed')
    return ws
  }

  readyState = 0
  closed = false
  sent: string[] = []
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}

  constructor(
    readonly url: string,
    readonly opts?: { headers?: Record<string, string> },
  ) {
    FakeWS.instances.push(this)
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const list = this.listeners[type]
    if (list) list.push(cb)
    else this.listeners[type] = [cb]
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }

  private emit(type: string, ev?: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev)
  }
  fireOpen(): void {
    this.readyState = 1
    this.emit('open')
  }
  fireMessage(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) })
  }
  fireError(message = 'boom'): void {
    this.emit('error', { message })
  }
  fireClose(code = 1011): void {
    this.emit('close', { code, reason: '' })
  }
}

const WELCOME = {
  type: 'welcome',
  available_subscriptions: [
    'completed_trades',
    'fills_spot',
    'recent_activity',
    'liquidation',
    'hip4_events',
  ],
}

function start(overrides: Partial<CollectOptions> = {}) {
  FakeWS.instances = []
  const p = collectChannel({
    baseUrl: 'https://api.hypedexer.com',
    apiKey: 'secret-key',
    channel: 'fills_spot',
    durationMs: 10_000, // long; tests resolve via max_items or close, not the timer
    maxItems: 5,
    WebSocketImpl: FakeWS as unknown as WsConstructor,
    ...overrides,
  })
  return { p, ws: FakeWS.last() }
}

describe('deriveWsUrl', () => {
  it('maps https base to a wss /ws endpoint', () => {
    expect(deriveWsUrl('https://api.hypedexer.com')).toBe('wss://api.hypedexer.com/ws')
    expect(deriveWsUrl('http://localhost:3000/')).toBe('ws://localhost:3000/ws')
  })
  it('honors an explicit override', () => {
    expect(deriveWsUrl('https://api.hypedexer.com', 'wss://custom/socket')).toBe(
      'wss://custom/socket',
    )
  })
})

describe('collectChannel', () => {
  it('passes the API key as a header and derives the wss URL', () => {
    const { ws } = start()
    expect(ws.url).toBe('wss://api.hypedexer.com/ws')
    expect(ws.opts?.headers?.['X-API-Key']).toBe('secret-key')
  })

  it('subscribes on open and collects pushed items until max_items', async () => {
    const { p, ws } = start()
    ws.fireOpen()
    expect(JSON.parse(ws.sent[0] ?? '')).toEqual({
      method: 'subscribe',
      subscription: { type: 'fills_spot' },
    })
    ws.fireMessage(WELCOME)
    ws.fireMessage({ type: 'fills_spot', count: 2, data: [{ a: 1 }, { a: 2 }] })
    ws.fireMessage({ type: 'fills_spot', count: 3, data: [{ a: 3 }, { a: 4 }, { a: 5 }] })
    const r = await p
    expect(r.item_count).toBe(5)
    expect(r.message_count).toBe(2)
    expect(r.stopped_by).toBe('max_items')
    expect(ws.closed).toBe(true)
  })

  it('scopes completed_trades to a user in the subscribe frame', () => {
    const { ws } = start({ channel: 'completed_trades', user: '0xabc' })
    ws.fireOpen()
    expect(JSON.parse(ws.sent[0] ?? '')).toEqual({
      method: 'subscribe',
      subscription: { type: 'completed_trades', user: '0xabc' },
    })
  })

  it('includes coin and user in the subscribe frame when provided', () => {
    const { ws } = start({ channel: 'l2Book', mode: 'mirror', coin: 'BTC' })
    ws.fireOpen()
    expect(JSON.parse(ws.sent[0] ?? '').subscription).toEqual({ type: 'l2Book', coin: 'BTC' })
  })

  it('returns whatever was collected when the socket closes mid-window', async () => {
    const { p, ws } = start()
    ws.fireOpen()
    ws.fireMessage({ type: 'fills_spot', count: 1, data: [{ a: 1 }] })
    ws.fireClose(1011)
    const r = await p
    expect(r.item_count).toBe(1)
    expect(r.stopped_by).toBe('closed')
  })

  it('rejects with a WebSocketError on a server error frame', async () => {
    const { p, ws } = start()
    ws.fireOpen()
    ws.fireMessage({ type: 'error', message: 'unknown method' })
    await expect(p).rejects.toBeInstanceOf(WebSocketError)
    await expect(p).rejects.toThrow(/unknown method/)
  })

  it('rejects with a WSAuthError when the socket closes before opening', async () => {
    const { p, ws } = start()
    ws.fireClose(1006)
    await expect(p).rejects.toBeInstanceOf(WSAuthError)
  })

  it('warns when the channel is not advertised in the welcome frame', async () => {
    const { p, ws } = start({ channel: 'liquidation', maxItems: 1 })
    ws.fireOpen()
    ws.fireMessage({ type: 'welcome', available_subscriptions: ['fills_spot'] })
    ws.fireMessage({ type: 'liquidation', count: 1, data: [{ x: 1 }] })
    const r = await p
    expect(r.warnings.some((w) => w.includes('not advertised'))).toBe(true)
  })
})

describe('collectChannel (mirror mode)', () => {
  it('derives the ?mode=mirror URL', () => {
    expect(deriveWsUrl('https://api.hypedexer.com', undefined, 'mirror')).toBe(
      'wss://api.hypedexer.com/ws?mode=mirror',
    )
  })

  it('collects per-frame data objects from the { channel, data } envelope', async () => {
    const { p, ws } = start({ channel: 'l2Book', mode: 'mirror', coin: 'BTC', maxItems: 2 })
    expect(ws.url).toBe('wss://api.hypedexer.com/ws?mode=mirror')
    ws.fireOpen()
    // mirror ack frame is a control frame, must be ignored
    ws.fireMessage({ type: 'subscriptionUpdate', subscription: { type: 'l2Book' }, active: true })
    ws.fireMessage({
      channel: 'l2Book',
      data: { coin: 'BTC', isSnapshot: true, bids: [], asks: [] },
    })
    ws.fireMessage({
      channel: 'l2Book',
      data: { coin: 'BTC', isSnapshot: false, bids: [['1', '2']] },
    })
    const r = await p
    expect(r.mode).toBe('mirror')
    expect(r.coin).toBe('BTC')
    expect(r.item_count).toBe(2)
    expect(r.message_count).toBe(2)
    expect((r.items[0] as { isSnapshot: boolean }).isSnapshot).toBe(true)
    expect(r.stopped_by).toBe('max_items')
  })

  it('ignores the subscriptionResponse ack frame (same envelope as data)', async () => {
    const { p, ws } = start({ channel: 'allMids', mode: 'mirror', maxItems: 1 })
    ws.fireOpen()
    // The mirror hub echoes the subscribe as { channel: "subscriptionResponse", data: {...} },
    // which shares the { channel, data } shape of real data frames and must not be collected.
    ws.fireMessage({
      channel: 'subscriptionResponse',
      data: { method: 'subscribe', subscription: { type: 'allMids' } },
    })
    ws.fireMessage({ channel: 'allMids', data: { mids: { BTC: '61116.5' } } })
    const r = await p
    expect(r.item_count).toBe(1)
    expect(r.message_count).toBe(1)
    expect((r.items[0] as { mids: Record<string, string> }).mids.BTC).toBe('61116.5')
  })
})
