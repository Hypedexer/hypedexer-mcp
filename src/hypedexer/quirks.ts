/**
 * Documented server quirks, repaired in one place so agents never see raw noise.
 * Each helper cites the ENDPOINTS.md row it addresses.
 */

const ISO_SENTINEL_PREFIX = '1970-01-01T00:00:00'

/**
 * Several endpoints emit a 1970 epoch-zero sentinel for "never" timestamps
 * (e.g. `/users/{user}/overview` `last_activity`, `/twaps/` `startTime`).
 * Map those to `null` so the agent doesn't reason about a 1970 date.
 */
export function nullifyEpochSentinel<T extends string | number | null | undefined>(
  value: T,
): T | null {
  if (value === 0) return null
  if (typeof value === 'string' && value.startsWith(ISO_SENTINEL_PREFIX)) return null
  return value
}

/**
 * `order=asc` corrupts the `/liquidations/` cursor upstream, so the SDK refuses
 * to iterate ascending. We expose this as a guard tools call before paging.
 */
export function assertSafeCursorOrder(order: string | undefined): void {
  if (order === 'asc') {
    throw new Error(
      'Ascending pagination is not supported on this endpoint (upstream cursor corruption). ' +
        'Omit `order` or use `order=desc`, then reverse client-side if needed.',
    )
  }
}

/**
 * Some list endpoints report `total_count` as the *page size*, not the true
 * total (e.g. `/fills/spot/`). When we detect that, drop it from meta rather
 * than mislead the agent about how many records exist.
 */
export function sanitizeTotalCount(
  totalCount: number | null | undefined,
  pageSize: number,
): number | null | undefined {
  if (totalCount != null && totalCount === pageSize) return undefined
  return totalCount
}

/**
 * The priority-fees gossip endpoints label an IPv4 node address as `address` /
 * `winner`. Rename to `nodeIp` so it isn't confused with a wallet address.
 */
export function renameGossipAddress<T extends Record<string, unknown>>(
  row: T,
): T & { nodeIp?: unknown } {
  if ('address' in row && typeof row.address === 'string' && isIpv4(row.address)) {
    const { address, ...rest } = row
    return { ...rest, nodeIp: address } as T & { nodeIp?: unknown }
  }
  return row
}

function isIpv4(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s)
}

/**
 * HIP-4 surfaces `/hip4/fee-scales` and `/hip4/user-actions` can be
 * `status: not_yet_live`. Tools should surface a clear note instead of an empty
 * array that looks like "no data".
 */
export function notYetLiveNote(status: string | undefined, docsUrl?: string): string | undefined {
  if (status === 'not_yet_live') {
    return `This HIP-4 surface is not yet live on mainnet; it returns no data today.${
      docsUrl ? ` Testnet docs: ${docsUrl}` : ''
    }`
  }
  return undefined
}
