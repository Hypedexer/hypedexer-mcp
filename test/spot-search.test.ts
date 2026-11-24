import { describe, expect, it } from 'vitest'
import { resolveSpot } from '../src/tools/exchange.js'
import { spotRows } from '../src/tools/public.js'

const meta = {
  tokens: [
    { name: 'USDC', index: 0, fullName: null },
    { name: 'TSLAX', index: 855, fullName: 'Wrapped Tesla xStock' },
    { name: 'NVDAX', index: 845, fullName: 'Wrapped NVIDIA xStock' },
    { name: 'EQNVDA', index: 860, fullName: 'EQX Tokenized NVDA', deployerLabel: 'eqx' },
    { name: 'PURR', index: 1, fullName: null },
  ],
  universe: [
    { name: 'PURR/USDC', index: 0, tokens: [1, 0] },
    { name: '@712', index: 712, tokens: [855, 0] },
    { name: '@702', index: 702, tokens: [845, 0] },
    { name: '@1155', index: 1155, tokens: [860, 0] },
  ],
}

describe('resolveSpot family search', () => {
  it('keeps exact matches first', () => {
    const hits = resolveSpot(meta, 'TSLAX')
    expect(hits.map((h) => h.coin)).toEqual(['@712'])
    expect(hits[0]?.match).toBeUndefined()
  })
  it('lists a family by full name keyword', () => {
    const hits = resolveSpot(meta, 'xstock')
    expect(hits.map((h) => h.coin).sort()).toEqual(['@702', '@712'])
    expect(hits.every((h) => h.match === 'contains')).toBe(true)
  })
  it('matches the deployer label', () => {
    expect(resolveSpot(meta, 'eqx').map((h) => h.coin)).toEqual(['@1155'])
  })
  it('never matches through the quote token', () => {
    expect(resolveSpot(meta, 'usd')).toEqual([])
  })
})

describe('spotRows', () => {
  it('filters by keyword and sorts contexts by 24h volume', () => {
    const ctxs = [
      { coin: '@712', markPx: '400', dayNtlVlm: '100' },
      { coin: '@702', markPx: '180', dayNtlVlm: '900' },
      { coin: 'PURR/USDC', markPx: '0.2', dayNtlVlm: '5000' },
    ]
    const rows = spotRows(meta, ctxs, 'xStock')
    expect(rows.map((r) => r.coin)).toEqual(['@702', '@712'])
    expect(rows[0]).toMatchObject({ pair: 'NVDAX/USDC', day_ntl_vlm: '900' })
  })
  it('resolves a handle and names a canonical pair', () => {
    expect(spotRows(meta, [], '@1155')[0]).toMatchObject({ coin: '@1155', pair: 'EQNVDA/USDC' })
    expect(spotRows(meta, [], 'purr')[0]).toMatchObject({ coin: 'PURR/USDC', pair: 'PURR/USDC' })
  })
})
