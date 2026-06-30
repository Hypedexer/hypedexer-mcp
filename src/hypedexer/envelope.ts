import type { APIResponse, Hip4Envelope, Page, PageMeta, Single } from '../core/types.js'

/**
 * The HypeDexer API ships three response envelope families (see ENDPOINTS.md):
 *
 *  - `apiResponse` — `{ success, data, next_cursor, has_more, total_count, ... }`
 *  - `bare`        — the payload directly (array or object), no wrapper
 *  - `hip4`        — `{ status, count, data, message, testnet_docs }`
 *
 * Tools never see these differences: every list normalizes to `Page<T>` and every
 * single record to `Single<T>`, both carrying a uniform `PageMeta`.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Normalize an `APIResponse<T[]>` list envelope. */
export function fromApiList<T>(raw: unknown): Page<T> {
  const env = raw as APIResponse<T[]>
  const data = Array.isArray(env?.data) ? env.data : []
  const meta: PageMeta = { family: 'apiResponse' }
  if (env?.message != null) meta.message = env.message
  if (env?.execution_time_ms != null) meta.executionMs = env.execution_time_ms
  if (env?.total_count !== undefined) meta.totalCount = env.total_count
  if (env?.next_cursor !== undefined) meta.nextCursor = env.next_cursor
  if (env?.has_more !== undefined) meta.hasMore = env.has_more
  return { data, meta }
}

/** Normalize an `APIResponse<T>` single-record envelope. */
export function fromApiSingle<T>(raw: unknown): Single<T> {
  const env = raw as APIResponse<T>
  const meta: PageMeta = { family: 'apiResponse' }
  if (env?.message != null) meta.message = env.message
  if (env?.execution_time_ms != null) meta.executionMs = env.execution_time_ms
  return { data: env?.data as T, meta }
}

/** Normalize a bare list (the payload IS the array). */
export function fromBareList<T>(raw: unknown): Page<T> {
  const data = Array.isArray(raw) ? (raw as T[]) : []
  return { data, meta: { family: 'bare' } }
}

/** Normalize a bare single record (the payload IS the object). */
export function fromBareSingle<T>(raw: unknown): Single<T> {
  return { data: raw as T, meta: { family: 'bare' } }
}

/** Normalize a HIP-4 envelope, surfacing the `not_yet_live` status into meta. */
export function fromHip4<T>(raw: unknown): Page<T> {
  const env = raw as Hip4Envelope<T>
  const data = Array.isArray(env?.data) ? env.data : []
  const meta: PageMeta = { family: 'hip4' }
  if (env?.status) meta.status = env.status
  if (env?.count !== undefined) meta.totalCount = env.count
  if (env?.message != null) meta.message = env.message
  if (env?.testnet_docs != null) meta.testnetDocs = env.testnet_docs
  return { data, meta }
}

/**
 * The `POST /info` dispatcher returns the same envelope as the backing REST
 * handler EXCEPT it wraps `currentFundingRates` and `vaultList` in
 * `APIResponse<T>` where REST returns them bare. Unwrap those two for parity.
 */
export function unwrapInfo(raw: unknown): unknown {
  if (isRecord(raw) && 'success' in raw && 'data' in raw) {
    return (raw as { data: unknown }).data
  }
  return raw
}
