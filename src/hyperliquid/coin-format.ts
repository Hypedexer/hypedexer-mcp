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

/**
 * Normalize a user-supplied coin for the Hyperliquid public API.
 *
 * - `@N` spot handles are kept as-is.
 * - HIP-3 builder-deployed perps are `dex:TICKER` and the API is case-sensitive:
 *   the dex prefix is lowercase (`xyz:SP500`). Uppercasing it (`XYZ:SP500`) makes
 *   Hyperliquid answer HTTP 500 with a null body. The ticker is uppercased only
 *   when it was typed all lowercase, so a mixed-case ticker is preserved.
 * - Native "k" tickers (`kPEPE`, `kBONK`) are case-sensitive too and kept when
 *   typed with their lowercase `k`.
 * - Anything else (plain tickers, `PURR/USDC` pairs) is uppercased.
 */
export function normalizeCoin(coin: string): string {
  const c = coin.trim()
  if (isSpotIndex(c)) return c
  const sep = c.indexOf(':')
  if (sep > 0) {
    const dex = c.slice(0, sep).toLowerCase()
    const ticker = c.slice(sep + 1)
    return `${dex}:${ticker === ticker.toLowerCase() ? ticker.toUpperCase() : ticker}`
  }
  if (/^k[A-Z0-9]+$/.test(c)) return c
  return c.toUpperCase()
}
