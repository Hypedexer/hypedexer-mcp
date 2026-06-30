import { describe, expect, it } from 'vitest'
import { parseDotenv } from '../src/env.js'

const pairs = (text: string) => new Map(parseDotenv(text))

describe('parseDotenv', () => {
  it('parses simple KEY=VALUE lines', () => {
    const m = pairs('HYPEDEXER_API_KEY=hl_live_abc\nHYPEDEXER_MCP_TOOLS=all')
    expect(m.get('HYPEDEXER_API_KEY')).toBe('hl_live_abc')
    expect(m.get('HYPEDEXER_MCP_TOOLS')).toBe('all')
  })

  it('skips blank lines and comments', () => {
    const m = pairs('\n# a comment\n  # indented comment\nKEY=value\n')
    expect(m.size).toBe(1)
    expect(m.get('KEY')).toBe('value')
  })

  it('strips surrounding quotes and an inline comment on unquoted values', () => {
    const m = pairs(['DQ="hello world"', "SQ='raw value'", 'PLAIN=val # trailing note'].join('\n'))
    expect(m.get('DQ')).toBe('hello world')
    expect(m.get('SQ')).toBe('raw value')
    expect(m.get('PLAIN')).toBe('val')
  })

  it('honours export prefix and expands \\n only inside double quotes', () => {
    const m = pairs(['export TOKEN=xyz', 'MULTI="a\\nb"', "RAW='a\\nb'"].join('\n'))
    expect(m.get('TOKEN')).toBe('xyz')
    expect(m.get('MULTI')).toBe('a\nb')
    expect(m.get('RAW')).toBe('a\\nb')
  })

  it('ignores malformed lines (no =, leading =, bad key)', () => {
    const m = pairs('NOEQUALS\n=leadingeq\n1BAD=nope\nGOOD=yes')
    expect(m.has('NOEQUALS')).toBe(false)
    expect(m.has('1BAD')).toBe(false)
    expect(m.get('GOOD')).toBe('yes')
    expect(m.size).toBe(1)
  })

  it('keeps = characters inside the value', () => {
    expect(pairs('URL=https://x.com/?a=1&b=2').get('URL')).toBe('https://x.com/?a=1&b=2')
  })
})
