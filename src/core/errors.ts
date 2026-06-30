export interface ValidationDetail {
  type?: string
  loc?: (string | number)[]
  msg: string
  input?: unknown
  ctx?: unknown
}

export interface HypedexerErrorOptions {
  status?: number
  rawBody?: string | object
  cause?: unknown
}

export abstract class HypedexerError extends Error {
  readonly status?: number
  readonly rawBody?: string | object
  override readonly cause?: unknown

  constructor(message: string, opts: HypedexerErrorOptions = {}) {
    super(message)
    this.name = new.target.name
    if (opts.status !== undefined) this.status = opts.status
    if (opts.rawBody !== undefined) this.rawBody = opts.rawBody
    if (opts.cause !== undefined) this.cause = opts.cause
  }
}

export class AuthError extends HypedexerError {}

export class NotFoundError extends HypedexerError {}

export class RateLimitError extends HypedexerError {}

export class ServerError extends HypedexerError {}

export class NetworkError extends HypedexerError {}

export class ValidationError extends HypedexerError {
  readonly detail: ValidationDetail[]

  constructor(message: string, detail: ValidationDetail[], opts: HypedexerErrorOptions = {}) {
    super(message, opts)
    this.detail = detail
  }

  field(name: string): ValidationDetail | undefined {
    return this.detail.find((d) => d.loc?.some((part) => part === name))
  }
}

export class WebSocketError extends HypedexerError {
  readonly closeCode?: number
  readonly reason?: string

  constructor(
    message: string,
    opts: HypedexerErrorOptions & { closeCode?: number; reason?: string } = {},
  ) {
    super(message, opts)
    if (opts.closeCode !== undefined) this.closeCode = opts.closeCode
    if (opts.reason !== undefined) this.reason = opts.reason
  }
}

export class WSAuthError extends WebSocketError {}
export class WSSubprotocolError extends WebSocketError {}
export class WSProtocolError extends WebSocketError {}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseError(status: number, _contentType: string, body: string): HypedexerError {
  const parsed = tryParseJson(body)
  const rawBody: string | object = isRecord(parsed) || Array.isArray(parsed) ? parsed : body

  if (status === 401) {
    return new AuthError(typeof body === 'string' && body.length > 0 ? body : 'unauthorized', {
      status,
      rawBody,
    })
  }

  if (status === 422 && isRecord(parsed) && Array.isArray(parsed.detail)) {
    const detail = parsed.detail as ValidationDetail[]
    const msg = detail[0]?.msg ?? 'validation failed'
    return new ValidationError(msg, detail, { status, rawBody })
  }

  if (status === 404 && isRecord(parsed) && typeof parsed.detail === 'string') {
    return new NotFoundError(parsed.detail as string, { status, rawBody })
  }

  if (status === 400 && isRecord(parsed) && typeof parsed.error === 'string') {
    const msg = parsed.error as string
    return new ValidationError(msg, [{ msg, loc: ['body'], type: 'info_dispatcher' }], {
      status,
      rawBody,
    })
  }

  if (status === 429) {
    return new RateLimitError(typeof body === 'string' && body.length > 0 ? body : 'rate limited', {
      status,
      rawBody,
    })
  }

  if (status >= 500) {
    return new ServerError(
      typeof body === 'string' && body.length > 0 ? body.slice(0, 200) : `server error ${status}`,
      { status, rawBody },
    )
  }

  if (status === 404) {
    return new NotFoundError(typeof body === 'string' && body.length > 0 ? body : 'not found', {
      status,
      rawBody,
    })
  }

  return new NetworkError(`unexpected status ${status}`, { status, rawBody })
}
