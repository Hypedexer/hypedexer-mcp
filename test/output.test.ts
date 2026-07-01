import { describe, expect, it } from 'vitest'
import { buildResult, rawResult } from '../src/tools/shared/output.js'

/** Pull the single text block out of a tool result. */
function text(r: ReturnType<typeof rawResult>): string {
  const block = r.content[0]
  if (!block || block.type !== 'text') throw new Error('expected a text block')
  return block.text
}

describe('rawResult budget enforcement', () => {
  it('passes a small payload through untouched', () => {
    const data = { hello: 'world', n: 1 }
    const r = rawResult(data, 'summary')
    expect(r.structuredContent).toEqual({ data })
    expect(text(r)).toContain('"hello": "world"')
  })

  it('tail-truncates an oversized array and emits a steering note', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, blob: 'x'.repeat(40) }))
    const r = rawResult(big, 'summary', { maxTokens: 500 })
    const sc = r.structuredContent as { data: unknown[]; notes?: string[] }
    expect(sc.data.length).toBeLessThan(big.length)
    expect(sc.notes?.[0]).toMatch(/truncated to \d+ of 5000 items/)
    expect(text(r)).toContain('Note:')
  })

  it('clips an oversized object and drops the data from structuredContent', () => {
    const huge = { field: 'y'.repeat(20_000) }
    const r = rawResult(huge, 'summary', { maxTokens: 200 })
    expect(r.structuredContent).toMatchObject({ truncated: true })
    expect(r.structuredContent).not.toHaveProperty('data')
    expect(text(r)).toContain('[truncated:')
    // The text block itself stays within the budget (plus the short marker).
    expect(text(r).length).toBeLessThanOrEqual(200 * 4 + 400)
  })
})

describe('buildResult budget enforcement', () => {
  it('tail-truncates an oversized array and notes the drop', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, blob: 'x'.repeat(40) }))
    const r = buildResult({ data: big }, { summary: 'rows', maxTokens: 500 })
    const sc = r.structuredContent as { data: unknown[]; notes?: string[] }
    expect(sc.data.length).toBeLessThan(big.length)
    expect(sc.notes?.[0]).toMatch(/truncated to \d+ of 5000 rows/)
  })
})
