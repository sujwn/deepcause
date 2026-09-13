export interface SerializedErrorEntry {
  name: string
  message: string
  stack?: string[]
  code?: string
  syscall?: string
  errno?: number
  path?: string
  constraint?: string
  table?: string
  column?: string
  detail?: string
  type?: string
  statusCode?: number
  status?: number
  nonError?: boolean
  value?: unknown
  circular?: boolean
  aggregateErrors?: SerializedErrorEntry[]
  aggregateTruncated?: number
  [key: string]: unknown
}

export interface SerializedError {
  message: string
  chain: SerializedErrorEntry[]
  serializationError?: string
}

export type StackPolicy = 'full' | 'deepest' | 'first-frame' | 'off'
export type PropsMode = 'allowlist' | 'permissive'
export type Shape = 'flat' | 'nested'

export interface SerializeErrorOptions {
  shape?: Shape
  maxDepth?: number
  maxAggregate?: number
  stack?: StackPolicy
  props?: PropsMode
  allow?: string[]
  redact?: RegExp[]
  maxPropBytes?: number
  followAliases?: boolean
}

export interface DeserializedError extends Error {
  reconstructed: true
  cause?: unknown
  [key: string]: unknown
}

/**
 * Serialize any thrown value into a JSON-safe object that preserves the
 * full `cause` chain. Never throws.
 */
export function serializeError(
  value: unknown,
  opts?: SerializeErrorOptions,
): SerializedError {
  throw new Error('not implemented')
}

/**
 * Rebuild a real `Error` from a `SerializedError`, relinking the `cause`
 * chain and restoring captured custom properties.
 */
export function deserializeError(obj: SerializedError): DeserializedError {
  throw new Error('not implemented')
}

/**
 * Hash the deepest chain entry's `name` + `code` + normalized message,
 * for grouping errors by root cause rather than top-level message.
 */
export function fingerprint(value: unknown): string {
  throw new Error('not implemented')
}
