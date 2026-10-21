import { describe, expect, it } from 'vitest'
import { evmTools } from '../src/tools/evm.js'
import { apiList } from './fixtures.js'
import { run } from './harness.js'

const A = `0x${'a'.repeat(40)}`
const TOPIC = `0x${'1'.repeat(64)}`

describe('HyperEVM feed filters', () => {
  it('transactions forward block_number, to_addr and include_system', async () => {
    const { calls } = await run(
      evmTools,
      'hd_evm_transactions',
      { block_number: 49154741, to_addr: A, include_system: false },
      [{ match: '/evm/transactions', json: apiList([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('block_number')).toBe('49154741')
    expect(q?.get('to_addr')).toBe(A)
    expect(q?.get('include_system')).toBe('false')
  })

  it('logs forward block_number, address and topic0, and validate topic0', async () => {
    const { calls } = await run(
      evmTools,
      'hd_evm_logs',
      { block_number: 1, address: A, topic0: TOPIC },
      [{ match: '/evm/logs', json: apiList([]) }],
    )
    expect(calls[0]?.url.searchParams.get('topic0')).toBe(TOPIC)
    expect(calls[0]?.url.searchParams.get('address')).toBe(A)
    const bad = await run(evmTools, 'hd_evm_logs', { topic0: '0x12' }, [])
    expect(bad.res.isError).toBe(true)
  })

  it('transfers forward user, action_type and token', async () => {
    const { calls } = await run(
      evmTools,
      'hd_evm_transfers',
      { user: A, action_type: 'agentSendAsset', token: 'HFUN' },
      [{ match: '/evm/ledger/transfers', json: apiList([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('user')).toBe(A)
    expect(q?.get('action_type')).toBe('agentSendAsset')
    expect(q?.get('token')).toBe('HFUN')
  })

  it('bridge events forward user_addr and an enum-guarded event_type', async () => {
    const { calls } = await run(
      evmTools,
      'hd_evm_bridge_events',
      { user_addr: A, event_type: 'withdraw3' },
      [{ match: '/evm/bridge/events', json: apiList([]) }],
    )
    expect(calls[0]?.url.searchParams.get('user_addr')).toBe(A)
    expect(calls[0]?.url.searchParams.get('event_type')).toBe('withdraw3')
    const bad = await run(evmTools, 'hd_evm_bridge_events', { event_type: 'bogus' }, [])
    expect(bad.res.isError).toBe(true)
  })

  it('user ledger events repeat event_type for a union', async () => {
    const { calls } = await run(
      evmTools,
      'hd_evm_user',
      { address: A, event_type: ['transfer_in', 'transfer_out'] },
      [{ match: '/ledger-events', json: apiList([]) }],
    )
    expect(calls[0]?.url.searchParams.getAll('event_type')).toEqual(['transfer_in', 'transfer_out'])
    const single = await run(evmTools, 'hd_evm_user', { address: A, event_type: 'deposit' }, [
      { match: '/ledger-events', json: apiList([]) },
    ])
    expect(single.calls[0]?.url.searchParams.getAll('event_type')).toEqual(['deposit'])
  })
})

describe('hd_evm_hip3_backstop filters', () => {
  it('transfers forward dex, signer and is_deposit', async () => {
    const { calls } = await run(
      evmTools,
      'hd_evm_hip3_backstop',
      { view: 'transfers', dex: 'xyz', signer: A, is_deposit: true },
      [{ match: '/backstop/transfers', json: apiList([]) }],
    )
    const q = calls[0]?.url.searchParams
    expect(q?.get('dex')).toBe('xyz')
    expect(q?.get('signer')).toBe(A)
    expect(q?.get('is_deposit')).toBe('true')
  })

  it('transfers_summary forwards dex and the window', async () => {
    const { calls } = await run(
      evmTools,
      'hd_evm_hip3_backstop',
      { view: 'transfers_summary', dex: 'xyz', start_time: '2026-01-01T00:00:00Z' },
      [{ match: '/backstop/transfers-summary', json: apiList([]) }],
    )
    expect(calls[0]?.url.searchParams.get('dex')).toBe('xyz')
    expect(calls[0]?.url.searchParams.get('start_time')).toBe('2026-01-01T00:00:00.000Z')
  })

  it('dex_fills forward coin and side', async () => {
    const { calls } = await run(
      evmTools,
      'hd_evm_hip3_backstop',
      { view: 'dex_fills', dex: 'km', coin: 'km:SMALL2000', side: 'B' },
      [{ match: '/backstop/km/fills', json: apiList([]) }],
    )
    expect(calls[0]?.url.searchParams.get('coin')).toBe('km:SMALL2000')
    expect(calls[0]?.url.searchParams.get('side')).toBe('B')
  })
})
