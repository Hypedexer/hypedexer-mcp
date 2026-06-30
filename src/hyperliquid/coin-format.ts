/**
 * Coin/symbol helpers for the Hyperliquid public API.
 *
 * Perp coins are plain tickers (`BTC`, `ETH`). Spot pairs are addressed as
 * `@{index}` (e.g. `@107`) or by the canonical `PURR/USDC` form depending on
 * the endpoint. These helpers keep that formatting in one place.
 */

/** True if the symbol is already a spot index handle like `@107`. */
export function isSpotIndex(coin: string): boolean {
  return /^@\d+$/.test(coin)
}

/** Normalize a user-supplied coin: trim, uppercase plain tickers, keep `@N` as-is. */
export function normalizeCoin(coin: string): string {
  const c = coin.trim()
  if (isSpotIndex(c)) return c
  if (c.includes('/')) return c.toUpperCase()
  return c.toUpperCase()
}
