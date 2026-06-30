import { ZodError } from 'zod'
import {
  AuthError,
  HypedexerError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
  WSAuthError,
  WebSocketError,
} from '../../core/errors.js'
import type { ToolResult } from '../types.js'
import { errorResult } from './output.js'

/**
 * Map any thrown error into a recovery-steering tool error result. The message
 * tells the agent the specific fix, never an opaque code or traceback.
 */
export function handleToolError(err: unknown): ToolResult {
  if (err instanceof ZodError) {
    const fields = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return errorResult(
      `Invalid arguments: ${fields}.`,
      'Fix the listed fields and call again. Check each parameter against its described type and format.',
    )
  }

  if (err instanceof ValidationError) {
    const fields = err.detail
      .map((d) => `${(d.loc ?? []).join('.') || 'input'}: ${d.msg}`)
      .join('; ')
    return errorResult(
      `The API rejected the request: ${fields}.`,
      'Correct the offending parameter(s) and retry.',
    )
  }

  if (err instanceof AuthError) {
    return errorResult(
      'Authentication failed (401). The HypeDexer API key is missing or invalid.',
      'Set a valid HYPEDEXER_API_KEY. Generate one at https://www.app.hypedexer.com/.',
    )
  }

  if (err instanceof NotFoundError) {
    return errorResult(
      `Not found: ${err.message}.`,
      'Verify the id/address/ticker exists. Use a list/search tool to discover valid values first.',
    )
  }

  if (err instanceof RateLimitError) {
    return errorResult(
      'Rate limited (429) by the API.',
      'Back off and retry after a short delay, reduce the page limit, or batch fewer calls.',
    )
  }

  if (err instanceof ServerError) {
    return errorResult(
      `Upstream server error: ${err.message}.`,
      'This is transient or a known-unstable endpoint. Retry once; if it persists, try a narrower query or an alternate tool.',
    )
  }

  if (err instanceof NetworkError) {
    return errorResult(
      `Network error reaching the API: ${err.message}.`,
      'Retry. If it persists, check connectivity and the configured base URL.',
    )
  }

  if (err instanceof WSAuthError) {
    return errorResult(
      `WebSocket authentication/handshake failed: ${err.message}`,
      'Set a valid HYPEDEXER_API_KEY. If the key is valid, you may be rate limited (429) on rapid ' +
        'reconnects — wait a few seconds before retrying.',
    )
  }

  if (err instanceof WebSocketError) {
    return errorResult(
      `WebSocket error: ${err.message}`,
      'Retry once. If it persists, use a shorter listen window or verify the key and base URL.',
    )
  }

  if (err instanceof HypedexerError) {
    return errorResult(`Request failed: ${err.message}.`, 'Review the parameters and retry.')
  }

  const message = err instanceof Error ? err.message : String(err)
  return errorResult(`Unexpected error: ${message}.`)
}
