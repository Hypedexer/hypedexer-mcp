export type TimestampMode = 'iso' | 'epochMs' | 'date' | 'hip4Expiry'

export type TimeInput = Date | number | string

export type TimeEncodeTarget = 'isoSnake' | 'epochCamel' | 'isoBare'

const ISO_SENTINEL = '1970-01-01T00:00:00'

function ensureUtc(iso: string): string {
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
}

export function parseTimestamp(
  value: string | number | null | undefined,
  mode: TimestampMode,
): Date | null {
  if (value === null || value === undefined) return null

  if (mode === 'epochMs') {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || n === 0) return null
    return new Date(n)
  }

  if (mode === 'hip4Expiry') {
    return parseHip4Expiry(String(value))
  }

  if (mode === 'date') {
    const s = String(value)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
    return new Date(`${s}T00:00:00Z`)
  }

  // mode === 'iso'
  const s = String(value)
  if (s === '' || s === ISO_SENTINEL) return null
  const d = new Date(ensureUtc(s))
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseHip4Expiry(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function toEpochMs(input: TimeInput): number {
  if (input instanceof Date) return input.getTime()
  if (typeof input === 'number') return input
  const n = Number(input)
  if (Number.isFinite(n) && String(n) === input.trim()) return n
  const d = new Date(ensureUtc(input))
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid time input: ${input}`)
  return d.getTime()
}

export function encodeTime(value: TimeInput, target: TimeEncodeTarget): string | number {
  const ms = toEpochMs(value)
  if (target === 'epochCamel') return ms
  if (target === 'isoBare') return new Date(ms).toISOString().slice(0, 10)
  return new Date(ms).toISOString()
}
