import { describe, expect, it } from 'vitest'
import { fundingTools } from '../src/tools/funding.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`

describe('hd_user_funding pagination', () => {
  it('holds back a split settlement instead of skipping it', async () => {
    const rows = [
      { time: 200, coin: 'BTC' },
      { time: 100, coin: 'BTC' },
      { time: 100, coin: 'ETH' },
    ]
    const { sc } = await run(fundingTools, 'hd_user_funding', { user: A, limit: 3 }, [
      { match: '/funding/userFunding', json: rows },
    ])
    expect(sc.data).toEqual([{ time: 200, coin: 'BTC' }])
    expect(sc.pagination.next_end_time).toBe(100)
  })

  it('reports no more pages when the page is not full', async () => {
    const { sc } = await run(fundingTools, 'hd_user_funding', { user: A, limit: 5 }, [
      { match: '/funding/userFunding', json: [{ time: 1 }] },
    ])
    expect(sc.pagination.has_more).toBe(false)
  })
})
