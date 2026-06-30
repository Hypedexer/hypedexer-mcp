export type Address = string
export type Hex = string
export type Coin = string

export type Wei = string & { readonly __brand: 'Wei' }

export type Side = 'B' | 'A'

export type EnvelopeFamily = 'apiResponse' | 'bare' | 'hip4'

export interface PageMeta {
  family: EnvelopeFamily
  message?: string
  executionMs?: number
  totalCount?: number | null
  nextCursor?: string | null
  hasMore?: boolean | null
  status?: 'live' | 'not_yet_live'
  testnetDocs?: string
}

export interface Page<T> {
  data: T[]
  meta: PageMeta
}

export interface Single<T> {
  data: T
  meta: PageMeta
}

export interface APIResponse<T> {
  success: boolean
  data: T
  message?: string | null
  next_cursor?: string | null
  has_more?: boolean | null
  total_count?: number | null
  execution_time_ms?: number
}

export interface Hip4Envelope<T> {
  status: 'live' | 'not_yet_live'
  count?: number
  data: T[]
  message?: string
  testnet_docs?: string
}
