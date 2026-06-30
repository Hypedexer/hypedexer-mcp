import type { ToolResult } from '../types.js'
import type { PaginationOut } from './pagination.js'

/** Rough token estimate (≈4 chars/token) used to enforce the response budget. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

export interface ResultPayload {
  /** The primary payload — an array for list tools, an object for single-record tools. */
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
 * Build a tool result with structured content + a concise text summary, enforcing
 * a token budget via truncate-with-steering: if the payload is an array that
 * exceeds the budget, drop the tail and tell the agent how to narrow the query.
 */
export function buildResult(payload: ResultPayload, opts: BuildOptions): ToolResult {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const notes = [...(payload.notes ?? [])]
  let data = payload.data
  let truncated = false

  if (Array.isArray(data)) {
    let rows = data
    while (rows.length > 1 && estimateTokens(JSON.stringify(rows, null, 2)) > maxTokens) {
      rows = rows.slice(0, Math.ceil(rows.length / 2))
      truncated = true
    }
    if (truncated) {
      notes.push(
        `Result truncated to ${rows.length} of ${(data as unknown[]).length} rows to fit the response budget. Narrow the query (smaller limit, tighter time window, or a more specific filter), or page with the returned cursor/offset.`,
      )
    }
    data = rows
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

/** A plain text/structured result for tools that return raw upstream JSON (e.g. public + info). */
export function rawResult(data: unknown, summary: string): ToolResult {
  return {
    content: [{ type: 'text', text: render(summary, data) }],
    structuredContent: { data },
  }
}

/**
 * Render the content text block. CRITICAL: the actual data must live here, not
 * only in structuredContent — many MCP clients (incl. Claude Desktop) surface
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
