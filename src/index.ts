import { types } from 'node:util'

export interface SerializedErrorEntry {
  name?: string
  message?: string
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

const DEFAULT_ALLOW = [
  'code',
  'syscall',
  'errno',
  'path',
  'constraint',
  'table',
  'column',
  'detail',
  'type',
  'statusCode',
  'status',
]

const DEFAULT_REDACT = [/token/i, /secret/i, /password/i, /^authorization$/i, /api[-_]?key/i]

const REDACTED_MARKER = '[REDACTED]'

/** Structural fields with their own semantics — never re-captured as a custom property. */
const RESERVED_KEYS = new Set(['name', 'message', 'stack', 'cause', 'errors'])

/** Single-cause aliases some ORMs/HTTP clients use instead of `cause`, checked in this priority order. */
const ALIAS_KEYS = ['original', 'parent', 'errors']

interface ResolvedOptions {
  shape: Shape
  maxDepth: number
  maxAggregate: number
  stackPolicy: StackPolicy
  propsMode: PropsMode
  allow: string[]
  redact: RegExp[]
  maxPropBytes: number
  followAliases: boolean
}

function resolveOptions(opts: SerializeErrorOptions | undefined): ResolvedOptions {
  const o = opts ?? {}
  return {
    shape: o.shape ?? 'flat',
    maxDepth: o.maxDepth ?? 10,
    maxAggregate: o.maxAggregate ?? 10,
    stackPolicy: o.stack ?? 'deepest',
    propsMode: o.props ?? 'allowlist',
    allow: o.allow ?? DEFAULT_ALLOW,
    redact: o.redact ?? DEFAULT_REDACT,
    maxPropBytes: o.maxPropBytes ?? 4096,
    followAliases: o.followAliases ?? true,
  }
}

function isRedactedKey(key: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => {
    try {
      return pattern.test(key)
    } catch {
      return false
    }
  })
}

function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf8')
}

/** Truncates a string to fit a UTF-8 byte budget, appending a single-character ellipsis marker. */
function truncateString(str: string, maxBytes: number): string {
  if (byteLength(str) <= maxBytes) return str
  const suffix = '…'
  const budget = Math.max(0, maxBytes - byteLength(suffix))
  let end = Math.min(str.length, budget)
  while (end > 0 && byteLength(str.slice(0, end)) > budget) end--
  return str.slice(0, end) + suffix
}

/** Bounds a single captured property's value: strings are truncated in place, oversized non-strings are replaced by a size marker. */
function boundPropertyValue(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') return truncateString(value, maxBytes)
  let json: string
  try {
    json = JSON.stringify(value) ?? ''
  } catch {
    return '[unserializable]'
  }
  const size = byteLength(json)
  return size <= maxBytes ? value : `[truncated: ${size} bytes]`
}

function safeRead(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** Cross-realm-safe error check: native detection first, then duck-typing on string message + stack. */
function isErrorLike(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false
  try {
    if (types.isNativeError(value)) return true
  } catch {
    // fall through to duck-typing
  }
  const message = safeRead(value, 'message')
  const stack = safeRead(value, 'stack')
  return typeof message === 'string' && typeof stack === 'string'
}

function readCauseSafely(value: object): { hasCause: boolean; cause: unknown } {
  let hasCause: boolean
  try {
    hasCause = 'cause' in value
  } catch {
    return { hasCause: false, cause: undefined }
  }
  if (!hasCause) return { hasCause: false, cause: undefined }
  try {
    return { hasCause: true, cause: (value as Record<string, unknown>).cause }
  } catch {
    return { hasCause: false, cause: undefined }
  }
}

function safeGetErrorsArray(value: object): unknown[] | null {
  const errors = safeRead(value, 'errors')
  return Array.isArray(errors) ? errors : null
}

const NOISE_FRAME_PATTERNS = [/node_modules[\\/]/, /node:internal/]

function isNoiseFrame(frame: string): boolean {
  return NOISE_FRAME_PATTERNS.some((p) => p.test(frame))
}

/** Extracts trimmed `at ...` frame lines from a raw stack string (dropping the "Name: message" header) and filters framework/runtime noise. */
function filterFrames(rawStack: string): { frames: string[]; omitted: number } {
  const frameLines = rawStack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
  const frames = frameLines.filter((line) => !isNoiseFrame(line))
  return { frames, omitted: frameLines.length - frames.length }
}

/** Recursively sanitizes an arbitrary value into something JSON.stringify can never choke on. When `redact` is given, any object key matching a pattern is replaced without recursing into it. */
function toJsonSafeValue(
  value: unknown,
  depth = 0,
  seen: Set<unknown> = new Set(),
  redact?: readonly RegExp[],
): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value as number) ? value : null
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return undefined
  if (depth >= 3 || seen.has(value)) return undefined

  try {
    if (Array.isArray(value)) {
      seen.add(value)
      return value.slice(0, 20).map((v) => toJsonSafeValue(v, depth + 1, seen, redact))
    }
    seen.add(value)
    const keys = Object.keys(value as object)
    const out: Record<string, unknown> = {}
    for (const key of keys.slice(0, 20)) {
      if (redact && isRedactedKey(key, redact)) {
        out[key] = REDACTED_MARKER
        continue
      }
      let raw: unknown
      try {
        raw = (value as Record<string, unknown>)[key]
      } catch {
        continue
      }
      const safe = toJsonSafeValue(raw, depth + 1, seen, redact)
      if (safe !== undefined) out[key] = safe
    }
    return out
  } catch {
    return undefined
  }
}

function buildNonErrorEntry(value: unknown): SerializedErrorEntry {
  const entry: SerializedErrorEntry = { nonError: true }
  if (value !== undefined) {
    const safe = toJsonSafeValue(value)
    if (safe !== undefined) entry.value = safe
  }
  return entry
}

function buildBaseEntry(
  value: object,
  options: ResolvedOptions,
  rawStackMap: WeakMap<SerializedErrorEntry, string>,
): SerializedErrorEntry {
  const entry: SerializedErrorEntry = {}

  const name = safeRead(value, 'name')
  entry.name = typeof name === 'string' ? name : 'Error'

  const message = safeRead(value, 'message')
  entry.message = typeof message === 'string' ? message : ''

  if (options.stackPolicy !== 'off') {
    const stack = safeRead(value, 'stack')
    if (typeof stack === 'string') rawStackMap.set(entry, stack)
  }

  if (options.propsMode === 'permissive') {
    Object.assign(entry, capturePermissiveProps(value, options))
  } else {
    for (const key of options.allow) {
      let raw: unknown
      try {
        raw = (value as Record<string, unknown>)[key]
      } catch {
        continue
      }
      if (raw === undefined) continue
      const t = typeof raw
      if (typeof raw === 'string') entry[key] = truncateString(raw, options.maxPropBytes)
      else if (t === 'boolean') entry[key] = raw
      else if (t === 'number' && Number.isFinite(raw)) entry[key] = raw
    }
  }

  return entry
}

/** Captures every own enumerable custom property (minus structural fields), redacting by key pattern and bounding size per property. */
function capturePermissiveProps(value: object, options: ResolvedOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return out
  }

  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) continue

    if (isRedactedKey(key, options.redact)) {
      out[key] = REDACTED_MARKER
      continue
    }

    let raw: unknown
    try {
      raw = (value as Record<string, unknown>)[key]
    } catch {
      continue
    }
    if (raw === undefined) continue

    const sanitized = toJsonSafeValue(raw, 0, new Set(), options.redact)
    if (sanitized === undefined) continue
    out[key] = boundPropertyValue(sanitized, options.maxPropBytes)
  }

  return out
}

type NodeCore =
  | { kind: 'depthCapped' }
  | { kind: 'circular' }
  | { kind: 'nonError'; entry: SerializedErrorEntry }
  | { kind: 'error'; entry: SerializedErrorEntry; hasCause: boolean; cause: unknown }

/** Builds one node's own entry (name/message/stack/props/aggregate children), threading one shared `seen` Set. */
function buildNodeCore(
  value: unknown,
  options: ResolvedOptions,
  seen: Set<unknown>,
  depth: number,
  rawStackMap: WeakMap<SerializedErrorEntry, string>,
): NodeCore {
  if (depth >= options.maxDepth) return { kind: 'depthCapped' }

  const isObj = value !== null && typeof value === 'object'
  if (isObj && seen.has(value)) return { kind: 'circular' }
  if (!isErrorLike(value)) return { kind: 'nonError', entry: buildNonErrorEntry(value) }

  seen.add(value)
  const entry = buildBaseEntry(value, options, rawStackMap)

  const errorsList = safeGetErrorsArray(value)
  if (errorsList) {
    const kept = errorsList.slice(0, options.maxAggregate)
    const truncated = errorsList.length - kept.length
    entry.aggregateErrors = kept
      .map((child) => walkNested(child, options, seen, 0, rawStackMap))
      .filter((e): e is SerializedErrorEntry => e !== null)
    if (truncated > 0) entry.aggregateTruncated = truncated
  }

  let { hasCause, cause } = readCauseSafely(value)
  if (!hasCause && options.followAliases) {
    const alias = readAliasCause(value)
    hasCause = alias.hasCause
    cause = alias.cause
  }
  return { kind: 'error', entry, hasCause, cause }
}

/** Follows `.original` / `.parent` / a non-array `.errors`, in that priority order — only meaningful when the caller already knows `cause` is absent. */
function readAliasCause(value: object): { hasCause: boolean; cause: unknown } {
  for (const key of ALIAS_KEYS) {
    let present: boolean
    try {
      present = key in value
    } catch {
      continue
    }
    if (!present) continue

    let raw: unknown
    try {
      raw = (value as Record<string, unknown>)[key]
    } catch {
      continue
    }
    if (Array.isArray(raw)) continue // AggregateError-style breadth, not a single-cause alias

    return { hasCause: true, cause: raw }
  }
  return { hasCause: false, cause: undefined }
}

/** Fully nested walk: used for `shape: 'nested'` and for every AggregateError child subtree, regardless of outer shape. */
function walkNested(
  value: unknown,
  options: ResolvedOptions,
  seen: Set<unknown>,
  depth: number,
  rawStackMap: WeakMap<SerializedErrorEntry, string>,
): SerializedErrorEntry | null {
  const core = buildNodeCore(value, options, seen, depth, rawStackMap)
  if (core.kind === 'depthCapped') return null
  if (core.kind === 'circular') return { circular: true }
  if (core.kind === 'nonError') return core.entry

  const { entry, hasCause, cause } = core
  if (hasCause) {
    const nested = walkNested(cause, options, seen, depth + 1, rawStackMap)
    if (nested) entry.cause = nested
  }
  return entry
}

/** Collects the linear sequence of a `.cause`-linked chain (nested-shape root or an AggregateError child's own chain), stopping at (and including) a circular marker. */
function collectNestedChain(root: SerializedErrorEntry | undefined): SerializedErrorEntry[] {
  const seq: SerializedErrorEntry[] = []
  let node = root
  while (node) {
    seq.push(node)
    if (node.circular) break
    node = node.cause as SerializedErrorEntry | undefined
  }
  return seq
}

/** The last real (non-circular-marker) entry of a linear chain — the terminal cause, or the last one before a `{ circular: true }` marker. -1 if there's no real entry at all. */
function deepestIndexOf(seq: readonly SerializedErrorEntry[]): number {
  let index = seq.length - 1
  if (index >= 0 && seq[index]?.circular) index--
  return index
}

/** Assigns final `.stack` arrays to a linear sequence of entries, applying the stack policy's deepest/intermediate distinction. */
function finalizeSequenceStacks(
  seq: readonly SerializedErrorEntry[],
  options: ResolvedOptions,
  rawStackMap: WeakMap<SerializedErrorEntry, string>,
): void {
  if (options.stackPolicy === 'off') return

  const deepestIndex = deepestIndexOf(seq)

  seq.forEach((entry, i) => {
    if (entry.circular) return
    const raw = rawStackMap.get(entry)
    if (raw === undefined) return

    const { frames, omitted } = filterFrames(raw)
    const wantsFull = options.stackPolicy === 'full' || (options.stackPolicy === 'deepest' && i === deepestIndex)

    if (wantsFull) {
      entry.stack = omitted > 0 ? [...frames, `... ${omitted} frames omitted`] : frames
    } else {
      entry.stack = frames.length > 0 ? [frames[0] as string] : []
    }
  })
}

/** Recurses into every AggregateError child branch reachable from `entry`, finalizing each branch's own linear stack sequence independently. */
function finalizeAggregateSubtrees(
  entry: SerializedErrorEntry,
  options: ResolvedOptions,
  rawStackMap: WeakMap<SerializedErrorEntry, string>,
): void {
  if (!entry.aggregateErrors) return
  for (const child of entry.aggregateErrors) {
    const seq = collectNestedChain(child)
    finalizeSequenceStacks(seq, options, rawStackMap)
    for (const node of seq) finalizeAggregateSubtrees(node, options, rawStackMap)
  }
}

function joinMessages(chain: readonly SerializedErrorEntry[]): string {
  return chain
    .filter((e) => typeof e.message === 'string')
    .map((e) => e.message as string)
    .join(': ')
}

/** Same joined-message semantics as `joinMessages`, but for a `shape: 'nested'` root — follows `.cause` links instead of an array. */
function joinNestedMessages(root: SerializedErrorEntry | undefined): string {
  const parts: string[] = []
  let node = root
  while (node) {
    if (typeof node.message === 'string') parts.push(node.message)
    if (node.circular) break
    node = node.cause as SerializedErrorEntry | undefined
  }
  return parts.join(': ')
}

function describeInternalError(err: unknown): string {
  try {
    if (types.isNativeError(err)) {
      const message = (err as Error).message
      if (typeof message === 'string') return message
    }
    if (typeof err === 'string') return err
  } catch {
    // fall through
  }
  return 'unknown error'
}

/**
 * Serialize any thrown value into a JSON-safe object that preserves the
 * full `cause` chain. Never throws.
 */
export function serializeError(
  value: unknown,
  opts?: SerializeErrorOptions,
): SerializedError {
  try {
    const options = resolveOptions(opts)
    const seen = new Set<unknown>()
    const rawStackMap = new WeakMap<SerializedErrorEntry, string>()

    if (options.shape === 'nested') {
      const root = walkNested(value, options, seen, 0, rawStackMap) ?? undefined
      const seq = collectNestedChain(root)
      finalizeSequenceStacks(seq, options, rawStackMap)
      for (const node of seq) finalizeAggregateSubtrees(node, options, rawStackMap)
      return { message: joinNestedMessages(root), chain: root ? [root] : [] }
    }

    const chain: SerializedErrorEntry[] = []
    let currentValue = value
    let currentDepth = 0

    while (currentDepth < options.maxDepth) {
      const core = buildNodeCore(currentValue, options, seen, currentDepth, rawStackMap)
      if (core.kind === 'depthCapped') break
      if (core.kind === 'circular') {
        chain.push({ circular: true })
        break
      }
      if (core.kind === 'nonError') {
        chain.push(core.entry)
        break
      }

      chain.push(core.entry)
      if (!core.hasCause) break
      currentValue = core.cause
      currentDepth++
    }

    finalizeSequenceStacks(chain, options, rawStackMap)
    for (const entry of chain) finalizeAggregateSubtrees(entry, options, rawStackMap)

    return { message: joinMessages(chain), chain }
  } catch (err) {
    return {
      message: '<serialization failed>',
      chain: [],
      serializationError: describeInternalError(err),
    }
  }
}

/** Structural `SerializedErrorEntry` fields with their own meaning — never copied as a generic custom property. */
const STRUCTURAL_ENTRY_KEYS = new Set([
  'name',
  'message',
  'stack',
  'cause',
  'nonError',
  'value',
  'circular',
  'aggregateErrors',
  'aggregateTruncated',
])

function buildCircularMarker(): Error & Record<string, unknown> {
  const marker = new Error('[circular reference]') as Error & Record<string, unknown>
  marker.reconstructed = true
  marker.circular = true
  return marker
}

function describeNonErrorValue(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    return JSON.stringify(value) ?? String(value)
  } catch {
    return 'non-error value'
  }
}

/** Rebuilds one entry's own Error (or AggregateError, with its children revived too), restoring name, stack, and every custom captured property. Never attaches `.cause` — callers decide how. */
function reviveEntry(entry: SerializedErrorEntry): Error & Record<string, unknown> {
  const message = typeof entry.message === 'string' ? entry.message : ''
  const aggregateErrors = Array.isArray(entry.aggregateErrors) ? entry.aggregateErrors : null

  const err = (
    aggregateErrors
      ? new AggregateError(aggregateErrors.map((child) => reviveNode(child)), message)
      : new Error(message)
  ) as Error & Record<string, unknown>

  err.name = typeof entry.name === 'string' ? entry.name : 'Error'
  if (Array.isArray(entry.stack)) err.stack = entry.stack.join('\n')
  if (typeof entry.aggregateTruncated === 'number') err.aggregateTruncated = entry.aggregateTruncated

  for (const key of Object.keys(entry)) {
    if (STRUCTURAL_ENTRY_KEYS.has(key)) continue
    err[key] = entry[key]
  }

  err.reconstructed = true
  return err
}

/** Revives a single entry reached via a nested `.cause` pointer (an AggregateError child, or a link in a `shape: 'nested'` chain) — no array-sibling fallback applies here. */
function reviveNode(entry: SerializedErrorEntry): unknown {
  if (entry.circular) return buildCircularMarker()
  if (entry.nonError) return 'value' in entry ? entry.value : undefined

  const revived = reviveEntry(entry)
  const causeEntry = entry.cause as SerializedErrorEntry | undefined
  if (causeEntry) revived.cause = reviveNode(causeEntry)
  return revived
}

/** Revives one element of the top-level `chain` array, relinking to either its own nested `.cause` (nested shape) or the next array element (flat shape). */
function reviveChainNode(seq: readonly SerializedErrorEntry[], index: number): unknown {
  const entry = seq[index]
  if (entry === undefined) return undefined
  if (entry.circular) return buildCircularMarker()
  if (entry.nonError) return 'value' in entry ? entry.value : undefined

  const revived = reviveEntry(entry)
  const causeEntry = entry.cause as SerializedErrorEntry | undefined
  if (causeEntry) {
    revived.cause = reviveNode(causeEntry)
  } else if (index + 1 < seq.length) {
    revived.cause = reviveChainNode(seq, index + 1)
  }
  return revived
}

/**
 * Rebuild a real `Error` from a `SerializedError`, relinking the `cause`
 * chain and restoring captured custom properties.
 */
export function deserializeError(obj: SerializedError): DeserializedError {
  const chain = Array.isArray(obj?.chain) ? obj.chain : []
  const first = chain[0]

  if (first === undefined) {
    const err = new Error(typeof obj?.message === 'string' ? obj.message : '') as DeserializedError
    err.reconstructed = true
    return err
  }

  const revived = reviveChainNode(chain, 0)

  // reviveChainNode returns a non-Error only when chain[0] itself is a `nonError` entry —
  // wrap it so the documented return type (always a real Error) holds.
  if (!types.isNativeError(revived)) {
    const err = new Error(describeNonErrorValue(revived)) as DeserializedError
    err.reconstructed = true
    err.nonError = true
    if (first.nonError && 'value' in first) err.value = first.value
    return err
  }

  return revived as DeserializedError
}

/** Strips variable segments (quoted values, UUIDs, hex ids, plain numbers) from a message so that two
 * messages differing only in an embedded identifier normalize to the same string. All strip to the same
 * placeholder — fingerprint only needs the *shape* of the message to line up, not which kind of value varied. */
function normalizeMessage(message: string): string {
  return message
    .replace(/"[^"]*"/g, '<x>')
    .replace(/'[^']*'/g, '<x>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<x>')
    .replace(/\b[0-9a-f]{6,}\b/gi, '<x>')
    .replace(/\b\d+\b/g, '<x>')
}

/** FNV-1a, 32-bit. Not cryptographic — just a fast, deterministic, dependency-free digest for grouping keys. */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Hash the deepest chain entry's `name` + `code` + normalized message,
 * for grouping errors by root cause rather than top-level message.
 */
export function fingerprint(value: unknown): string {
  const result = serializeError(value, { stack: 'off' })
  const index = deepestIndexOf(result.chain)
  const entry = index >= 0 ? result.chain[index] : undefined

  const name = typeof entry?.name === 'string' ? entry.name : ''
  const code = typeof entry?.code === 'string' ? entry.code : ''
  const rawMessage =
    typeof entry?.message === 'string' ? entry.message : describeNonErrorValue(entry?.value)
  const message = normalizeMessage(rawMessage)

  return fnv1a(JSON.stringify([name, code, message]))
}
