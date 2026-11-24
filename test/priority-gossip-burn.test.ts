import { describe, expect, it } from 'vitest'
import { isSpotCoin } from '../src/tools/exchange.js'
import { gossipBurn } from '../src/tools/hip3.js'

describe('gossipBurn', () => {
  it('counts each auction once at its clearing price', () => {
    const t0 = '2026-11-23T14:00:00'
    const t1 = '2026-11-23T14:03:00'
    const rows = [
      // auction 1, slot 0: three snapshots, the last one carries endGas
      { slotId: 0, startTime: t0, startGas: 4.19, endGas: null, winner: '1.1.1.1' },
      { slotId: 0, startTime: t0, startGas: 4.19, endGas: null, winner: '1.1.1.1' },
      { slotId: 0, startTime: t0, startGas: 4.19, endGas: 0.466, winner: '1.1.1.1' },
      // auction 2, slot 0
      { slotId: 0, startTime: t1, startGas: 4.66, endGas: 0.465, winner: '2.2.2.2' },
      // slot 1 never priced
      { slotId: 1, startTime: t1, startGas: 1, endGas: null, winner: '1.1.1.1' },
    ]
    const out = gossipBurn(rows)
    expect(out.hype_burned).toBeCloseTo(0.931, 8)
    expect(out.auctions).toBe(3)
    expect(out.priced_auctions).toBe(2)
    expect(out.unpriced_auctions).toBe(1)
    expect(out.by_day).toEqual([{ date: '2026-11-23', hype_burned: 0.931 }])
    expect(out.by_slot).toEqual([{ slot: 0, hype_burned: 0.931, auctions: 2 }])
    expect(out.top_winners[0]).toEqual({ winner: '1.1.1.1', hype_burned: 0.466 })
  })
  it('returns zero on an empty window', () => {
    expect(gossipBurn([])).toMatchObject({ hype_burned: 0, auctions: 0, by_day: [] })
  })
})

describe('isSpotCoin', () => {
  it('recognises spot handles and pair names only', () => {
    expect(isSpotCoin('@702')).toBe(true)
    expect(isSpotCoin('PURR/USDC')).toBe(true)
    expect(isSpotCoin('BTC')).toBe(false)
    expect(isSpotCoin('xyz:TSLA')).toBe(false)
  })
})
