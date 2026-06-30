import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AuthError, NotFoundError, RateLimitError, parseError } from '../src/core/errors.js'
import { handleToolError } from '../src/tools/shared/errors.js'

describe('parseError (core)', () => {
  it('maps 401 to AuthError', () => {
    expect(parseError(401, 'text/plain', 'nope')).toBeInstanceOf(AuthError)
  })
  it('maps 404 detail-string to NotFoundError', () => {
    const e = parseError(404, 'application/json', JSON.stringify({ detail: 'missing dex' }))
    expect(e).toBeInstanceOf(NotFoundError)
    expect(e.message).toBe('missing dex')
  })
  it('maps 429 to RateLimitError', () => {
    expect(parseError(429, '', '')).toBeInstanceOf(RateLimitError)
  })
})

describe('handleToolError', () => {
  it('turns a Zod error into a steering message', () => {
    let caught: unknown
    try {
      z.object({ user: z.string() }).parse({})
    } catch (e) {
      caught = e
    }
    const r = handleToolError(caught)
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/Invalid arguments/)
  })

  it('maps an AuthError to a key-setup hint', () => {
    const r = handleToolError(new AuthError('unauthorized', { status: 401 }))
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/HYPEDEXER_API_KEY/)
  })

  it('maps a NotFoundError with a discovery hint', () => {
    const r = handleToolError(new NotFoundError('no such id'))
    expect(r.content[0]?.text).toMatch(/no such id/)
  })

  it('handles a plain error', () => {
    const r = handleToolError(new Error('boom'))
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/boom/)
  })
})
