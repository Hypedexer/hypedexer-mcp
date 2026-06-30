import { z } from 'zod'

/**
 * Reusable Zod field fragments. Domain modules spread these into their tool
 * `inputSchema` raw shapes so naming, defaults, and docs stay consistent.
 */

/** EVM/HyperCore address. Lenient on case; required form is 0x + 40 hex. */
export const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 40-hex-character address')
  .describe('Wallet address, 0x-prefixed 40 hex chars (e.g. 0xabc...123).')

/** A perp ticker (`BTC`) or spot handle (`@107`). */
export const coinSchema = z
  .string()
  .trim()
  .min(1)
  .describe('Asset symbol: a perp ticker like "BTC"/"ETH", or a spot handle like "@107".')

export const responseFormatSchema = z
  .enum(['concise', 'detailed'])
  .default('concise')
  .describe(
    'Verbosity of the result. "concise" (default) returns high-signal fields; ' +
      '"detailed" includes raw ids and secondary fields needed to chain follow-up calls.',
  )

/** Page size, clamped to an endpoint-specific cap. */
export function limitSchema(max: number, def = Math.min(50, max)) {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(def)
    .describe(`Max records to return (1-${max}, default ${def}).`)
}

/** Cursor-paginated endpoints. Opaque token from a previous result's pagination.next_cursor. */
export const cursorSchema = z
  .string()
  .optional()
  .describe('Opaque pagination cursor from a previous result (pagination.next_cursor).')

/** Offset-paginated endpoints. */
export const offsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Row offset for pagination (pagination.next_offset from a previous result).')

/** ISO-8601 or epoch-ms start/end window. Tools convert to the endpoint's format. */
export const startTimeSchema = z
  .string()
  .optional()
  .describe('Window start, ISO-8601 (e.g. 2026-06-01T00:00:00Z) or epoch-ms.')

export const endTimeSchema = z
  .string()
  .optional()
  .describe(
    'Window end, ISO-8601 or epoch-ms. For time-window pagination pass pagination.next_end_time.',
  )

/** Build a `view` enum field from a list of allowed values. */
export function viewSchema<const T extends readonly [string, ...string[]]>(
  values: T,
  description: string,
  def?: T[number],
) {
  const base = z.enum(values).describe(description)
  return def === undefined ? base : base.default(def)
}

export { z }
