import type { ToolResult } from '../types.js'
import type { PaginationOut } from './pagination.js'

/** Rough token estimate (≈4 chars/token) used to enforce the response budget. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

export interface ResultPayload {
  /** The primary payload - an array for list tools, an object for single-record tools. */
  data: unknown
  pagination?: PaginationOut
  /** Endpoint-level metadata (execution time, family, status notes). */
  meta?: Record<string, unknown>
  /** Human-facing notes (quirk warnings, not_yet_live, truncation). */
  notes?: string[]
}

export interface BuildOptions {
  /** One-line human summary shown as the text block. */
  summary: string
  maxTokens?: number
}

const DEFAULT_MAX_TOKENS = 25_000

/**
 * Halve a top-level array from the tail until its serialized form fits the token
 * budget. Returns the surviving rows and, when it had to cut, the original count
 * so callers can emit a steering note. Objects are returned untouched (there is
 * no safe structural slice for them; oversized objects are handled downstream).
 */
function fitArrayToBudget(
  data: unknown[],
  maxTokens: number,
): {
  rows: unknown[]
  truncatedFrom?: number
} {
  let rows = data
  let truncated = false
  while (rows.length > 1 && estimateTokens(JSON.stringify(rows, null, 2)) > maxTokens) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
    truncated = true
  }
  return truncated ? { rows, truncatedFrom: data.length } : { rows }
}

/**
 * Build a tool result with structured content + a concise text summary, enforcing
 * a token budget via truncate-with-steering: if the payload is an array that
 * exceeds the budget, drop the tail and tell the agent how to narrow the query.
 */
export function buildResult(payload: ResultPayload, opts: BuildOptions): ToolResult {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const notes = [...(payload.notes ?? [])]
  let data = payload.data

  if (Array.isArray(data)) {
    const fit = fitArrayToBudget(data, maxTokens)
    if (fit.truncatedFrom !== undefined) {
      notes.push(
        `Result truncated to ${fit.rows.length} of ${fit.truncatedFrom} rows to fit the response budget. Narrow the query (smaller limit, tighter time window, or a more specific filter), or page with the returned cursor/offset.`,
      )
    }
    data = fit.rows
  }

  const structured: Record<string, unknown> = { data }
  if (payload.pagination) structured.pagination = payload.pagination
  if (payload.meta && Object.keys(payload.meta).length > 0) structured.meta = payload.meta
  if (notes.length > 0) structured.notes = notes

  const count = Array.isArray(data) ? `${(data as unknown[]).length} record(s).` : ''
  const summaryLine = `${opts.summary} ${count}`.trim()

  return {
    content: [{ type: 'text', text: render(summaryLine, structured) }],
    structuredContent: structured,
  }
}

/**
 * A plain text/structured result for tools that return raw upstream JSON (e.g.
 * public + info + rpc). Unlike {@link buildResult} these payloads are often
 * arbitrary objects, but they still MUST respect the response budget so a single
 * huge upstream body cannot blow the agent's context:
 *   - top-level arrays are tail-truncated like buildResult, with a steering note;
 *   - anything still over budget (typically a large object) has its serialized
 *     text clipped to the budget with an explicit marker, and its structured data
 *     is replaced by a steering stub so neither surface exceeds the budget.
 */
export function rawResult(
  data: unknown,
  summary: string,
  opts: { maxTokens?: number } = {},
): ToolResult {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  let out = data
  let note: string | undefined

  if (Array.isArray(data)) {
    const fit = fitArrayToBudget(data, maxTokens)
    if (fit.truncatedFrom !== undefined) {
      note = `Result truncated to ${fit.rows.length} of ${fit.truncatedFrom} items to fit the response budget. Request fewer items (smaller limit/seconds/max_items) or add a more specific filter.`
    }
    out = fit.rows
  }

  let text = render(summary, out)
  if (note) text += `\n\nNote: ${note}`

  // Non-array (or still-oversized) payloads: bound both surfaces. Object JSON
  // cannot be sliced structurally without producing invalid JSON, so we clip the
  // rendered text and drop the oversized data from structuredContent, steering
  // the caller to narrow the request instead of dumping the whole body.
  if (estimateTokens(text) > maxTokens) {
    const marker = `[truncated: raw payload exceeded the ${maxTokens}-token response budget. Narrow the request (a specific field/type, a smaller range, or a single record) to get the full untruncated result.]`
    text = `${render(summary, out).slice(0, maxTokens * 4)}\n\n... ${marker}`
    return {
      content: [{ type: 'text', text }],
      structuredContent: { truncated: true, note: marker },
    }
  }

  const structured: Record<string, unknown> = { data: out }
  if (note) structured.notes = [note]
  return { content: [{ type: 'text', text }], structuredContent: structured }
}

/**
 * Render the content text block. CRITICAL: the actual data must live here, not
 * only in structuredContent - many MCP clients (incl. Claude Desktop) surface
 * only the text block to the model when no outputSchema is declared. So we emit a
 * one-line summary followed by the full JSON payload. (MCP spec: a tool with
 * structured content SHOULD also return the serialized JSON in a text block.)
 */
function render(summary: string, payload: unknown): string {
  return `${summary}\n\n${JSON.stringify(payload, null, 2)}`
}

/** A recovery-steering error result (isError: true). */
export function errorResult(message: string, hint?: string): ToolResult {
  const text = hint ? `${message}\n\nNext step: ${hint}` : message
  return { content: [{ type: 'text', text }], isError: true }
}
