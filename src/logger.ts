/**
 * Structured logger that writes ONLY to stderr.
 *
 * The stdio transport uses stdout for the JSON-RPC protocol stream, so anything
 * written to stdout would corrupt the MCP channel. Every diagnostic must go to
 * stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

function emit(
  level: Exclude<LogLevel, 'silent'>,
  min: number,
  bindings: Record<string, unknown>,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (ORDER[level] < min) return
  const record = {
    level,
    msg,
    ...bindings,
    ...(fields ?? {}),
  }
  process.stderr.write(`${JSON.stringify(record)}\n`)
}

export function createLogger(
  level: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
): Logger {
  const min = ORDER[level]
  return {
    debug: (msg, fields) => emit('debug', min, bindings, msg, fields),
    info: (msg, fields) => emit('info', min, bindings, msg, fields),
    warn: (msg, fields) => emit('warn', min, bindings, msg, fields),
    error: (msg, fields) => emit('error', min, bindings, msg, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  }
}
