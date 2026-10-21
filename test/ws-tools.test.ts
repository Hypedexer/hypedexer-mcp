import { afterEach, describe, expect, it } from 'vitest'
import { liveTools } from '../src/tools/live.js'
import { streamsTools } from '../src/tools/streams.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`

/**
 * A WebSocket stand-in installed as the global: on open it records the subscribe
 * frame, pushes the scripted frames, then closes, so tool handlers resolve
 * without waiting for their listen window.
 */
function installFakeSocket(frames: unknown[]): { sent: Record<string, unknown>[]; url: string[] } {
  const sent: Record<string, unknown>[] = []
  const url: string[] = []
  class Fake {
    readyState = 0
    private listeners: Record<string, Array<(ev: unknown) => void>> = {}
    constructor(u: string) {
      url.push(u)
      queueMicrotask(() => this.emit('open'))
    }
    addEventListener(type: string, cb: (ev: unknown) => void): void {
      const list = this.listeners[type] ?? []
      list.push(cb)
      this.listeners[type] = list
    }
    send(data: string): void {
      sent.push(JSON.parse(data) as Record<string, unknown>)
      queueMicrotask(() => {
        for (const f of frames) this.emit('message', { data: JSON.stringify(f) })
        this.emit('close', { code: 1000 })
      })
    }
    close(): void {}
    private emit(type: string, ev?: unknown): void {
      for (const cb of this.listeners[type] ?? []) cb(ev)
    }
  }
  ;(globalThis as { WebSocket?: unknown }).WebSocket = Fake
  return { sent, url }
}

const original = (globalThis as { WebSocket?: unknown }).WebSocket
afterEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = original
})

describe('hd_stream_liquidations', () => {
  it('subscribes the plural channel with every filter and reads singular frames', async () => {
    const fake = installFakeSocket([
      { type: 'connected' },
      { channel: 'subscriptionResponse', data: { method: 'subscribe' } },
      { type: 'liquidation', count: 1, data: [{ coin: 'BTC', notional_total: 60000 }] },
    ])
    const { sc } = await run(
      streamsTools,
      'hd_stream_liquidations',
      { user: A, users: [A], amount_dollars: 50000, builder: A, seconds: 1 },
      [],
    )
    expect(fake.sent[0]).toEqual({
      method: 'subscribe',
      subscription: {
        type: 'liquidations',
        user: A,
        users: [A],
        amount_dollars: 50000,
        builder: A,
      },
    })
    expect(fake.url[0]).toBe('wss://api.hypedexer.com/ws')
    expect(sc.data).toEqual([{ coin: 'BTC', notional_total: 60000 }])
  })

  it('is the only stream tool left', () => {
    expect(streamsTools.map((t) => t.name)).toEqual(['hd_stream_liquidations'])
  })
})

describe('hd_live_feed', () => {
  it('candle sends coin and interval on the mirror socket', async () => {
    const fake = installFakeSocket([
      { channel: 'subscriptionResponse', data: {} },
      { channel: 'candle', data: { s: 'BTC', i: '5s' } },
    ])
    const { sc } = await run(
      liveTools,
      'hd_live_feed',
      { channel: 'candle', coin: 'BTC', interval: '5s', seconds: 1 },
      [],
    )
    expect(fake.url[0]).toBe('wss://api.hypedexer.com/ws?mode=mirror')
    expect(fake.sent[0]?.subscription).toEqual({ type: 'candle', coin: 'BTC', interval: '5s' })
    expect(sc.data).toEqual([{ s: 'BTC', i: '5s' }])
  })

  it('user channels require user; coin channels require coin', async () => {
    installFakeSocket([])
    const noUser = await run(liveTools, 'hd_live_feed', { channel: 'userFundings' }, [])
    expect(noUser.res.isError).toBe(true)
    const noCoin = await run(liveTools, 'hd_live_feed', { channel: 'activeAssetCtx' }, [])
    expect(noCoin.res.isError).toBe(true)
  })

  it('fundingRates subscribes with no extra fields', async () => {
    const fake = installFakeSocket([{ channel: 'fundingRates', data: { fundings: {} } }])
    await run(liveTools, 'hd_live_feed', { channel: 'fundingRates', coin: 'BTC', seconds: 1 }, [])
    expect(fake.sent[0]?.subscription).toEqual({ type: 'fundingRates' })
  })
})

describe('hd_live_all_mids', () => {
  it('forwards dex', async () => {
    const fake = installFakeSocket([{ channel: 'allMids', data: { mids: {} } }])
    await run(liveTools, 'hd_live_all_mids', { dex: 'xyz', seconds: 1 }, [])
    expect(fake.sent[0]?.subscription).toEqual({ type: 'allMids', dex: 'xyz' })
  })
})
