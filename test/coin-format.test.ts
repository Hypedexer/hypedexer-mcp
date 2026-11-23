import { describe, expect, it } from 'vitest'
import { normalizeCoin } from '../src/hyperliquid/coin-format.js'

describe('normalizeCoin', () => {
  it('uppercases plain native tickers', () => {
    expect(normalizeCoin(' btc ')).toBe('BTC')
  })
  it('keeps spot index handles', () => {
    expect(normalizeCoin('@107')).toBe('@107')
  })
  it('uppercases spot pairs', () => {
    expect(normalizeCoin('purr/usdc')).toBe('PURR/USDC')
  })
  it('keeps the HIP-3 dex prefix lowercase', () => {
    expect(normalizeCoin('xyz:SP500')).toBe('xyz:SP500')
    expect(normalizeCoin('XYZ:SP500')).toBe('xyz:SP500')
    expect(normalizeCoin('xyz:sp500')).toBe('xyz:SP500')
  })
  it('keeps native k tickers', () => {
    expect(normalizeCoin('kPEPE')).toBe('kPEPE')
  })
})
