import { describe, expect, it } from 'vitest'
import { loadConfig, resolveGroups } from '../src/config.js'

describe('resolveGroups', () => {
  it('expands the "all" preset minus the opt-in-only groups, and always includes public', () => {
    const g = resolveGroups('all', true)
    expect(g.has('public')).toBe(true)
    expect(g.has('hip3')).toBe(true)
    expect(g.has('evm')).toBe(true)
    // info and rpc are opt-in only and excluded from the `all` preset.
    expect(g.has('info')).toBe(false)
    expect(g.has('rpc')).toBe(false)
  })

  it('includes rpc only when named explicitly (dead endpoint, opt-in)', () => {
    expect(resolveGroups('all', true).has('rpc')).toBe(false)
    expect(resolveGroups('all,rpc', true).has('rpc')).toBe(true)
    expect(resolveGroups('rpc', true).has('rpc')).toBe(true)
  })

  it('expands the "core" preset', () => {
    const g = resolveGroups('core', true)
    expect(g.has('fills')).toBe(true)
    expect(g.has('hip3')).toBe(false)
    expect(g.has('public')).toBe(true)
  })

  it('accepts a comma list with a preset and extra groups', () => {
    const g = resolveGroups('core,evm,info', true)
    expect(g.has('evm')).toBe(true)
    expect(g.has('info')).toBe(true)
    expect(g.has('fills')).toBe(true)
  })

  it('drops keyed groups when no API key, keeping only public', () => {
    const g = resolveGroups('all', false)
    expect(g.has('public')).toBe(true)
    expect(g.has('fills')).toBe(false)
    expect(g.size).toBe(1)
  })

  it('ignores unknown tokens', () => {
    const g = resolveGroups('bogus,fills', true)
    expect(g.has('fills')).toBe(true)
    expect(g.has('public')).toBe(true)
  })
})

describe('loadConfig', () => {
  it('defaults to stdio + all groups, no key', () => {
    const c = loadConfig({})
    expect(c.transport).toBe('stdio')
    expect(c.apiKey).toBeUndefined()
    expect(c.enabledGroups.size).toBe(1) // only public without a key
  })

  it('enables keyed groups when a key is present', () => {
    const c = loadConfig({ HYPEDEXER_API_KEY: 'k', HYPEDEXER_MCP_TOOLS: 'core' })
    expect(c.apiKey).toBe('k')
    expect(c.enabledGroups.has('fills')).toBe(true)
  })

  it('selects http transport from env', () => {
    expect(loadConfig({ HYPEDEXER_MCP_TRANSPORT: 'http' }).transport).toBe('http')
  })
})
