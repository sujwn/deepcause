import { describe, expect, it } from 'vitest'
import { serializeError } from '../src/index.js'

const mut = (o: object): Record<string, unknown> => o as Record<string, unknown>

const OFF = { stack: 'off' } as const

function jsonHas(result: unknown, needle: string): boolean {
  return JSON.stringify(result).includes(needle)
}

describe('Allowlist mode with the default allow list', () => {
  it.each([
    ['code', 'ENOENT'],
    ['syscall', 'open'],
    ['path', '/etc/passwd'],
    ['constraint', 'orders_pkey'],
    ['table', 'orders'],
    ['column', 'user_id'],
    ['detail', 'Key (id)=(1) already exists.'],
    ['type', 'validation'],
  ])('captures the default-allowed string property "%s"', (key, value) => {
    const err = new Error('boom')
    mut(err)[key] = value

    const result = serializeError(err, OFF)

    expect(result.chain[0]).toMatchObject({ [key]: value })
  })

  it.each([
    ['errno', -2],
    ['statusCode', 404],
    ['status', 500],
  ])('captures the default-allowed numeric property "%s"', (key, value) => {
    const err = new Error('boom')
    mut(err)[key] = value

    const result = serializeError(err, OFF)

    expect(result.chain[0]).toMatchObject({ [key]: value })
  })

  it('does not capture a property outside the default allow list', () => {
    const err = new Error('boom')
    mut(err).requestId = 'req_123'

    const result = serializeError(err, OFF)

    expect(result.chain[0]).not.toHaveProperty('requestId')
    expect(jsonHas(result, 'req_123')).toBe(false)
  })

  it('does not capture known-dangerous properties by default', () => {
    const err = new Error('boom')
    mut(err).headers = { Authorization: 'Bearer secret-token-value' }
    mut(err).raw = { apiKey: 'sk_live_should_not_leak' }

    const result = serializeError(err, OFF)

    expect(result.chain[0]).not.toHaveProperty('headers')
    expect(result.chain[0]).not.toHaveProperty('raw')
    expect(jsonHas(result, 'secret-token-value')).toBe(false)
    expect(jsonHas(result, 'sk_live_should_not_leak')).toBe(false)
  })
})

describe('a configurable `allow` list', () => {
  it('captures a key added via `allow` and omits defaults not listed', () => {
    const err = new Error('boom')
    mut(err).code = 'E_DEFAULT'
    mut(err).myCustomKey = 'kept'

    const result = serializeError(err, { ...OFF, allow: ['myCustomKey'] })

    expect(result.chain[0]).toMatchObject({ myCustomKey: 'kept' })
    expect(result.chain[0]).not.toHaveProperty('code')
  })

  it('an empty `allow` list captures nothing custom', () => {
    const err = new Error('boom')
    mut(err).code = 'E_DEFAULT'

    const result = serializeError(err, { ...OFF, allow: [] })

    expect(result.chain[0]).not.toHaveProperty('code')
  })
})

describe('maxPropBytes truncation', () => {
  it('truncates an oversized allow-listed string property', () => {
    const err = new Error('boom')
    mut(err).detail = 'x'.repeat(500)

    const result = serializeError(err, { ...OFF, maxPropBytes: 20 })
    const detail = result.chain[0]?.detail as string

    expect(typeof detail).toBe('string')
    expect(Buffer.byteLength(detail, 'utf8')).toBeLessThanOrEqual(24)
    expect(detail.length).toBeLessThan(500)
  })

  it('leaves a property under the byte cap untouched', () => {
    const err = new Error('boom')
    mut(err).code = 'SHORT'

    const result = serializeError(err, { ...OFF, maxPropBytes: 4096 })

    expect(result.chain[0]).toMatchObject({ code: 'SHORT' })
  })

  it('replaces an oversized non-string permissive value with a size marker, not the raw content', () => {
    const err = new Error('boom')
    mut(err).payload = { blob: 'y'.repeat(500) }

    const result = serializeError(err, { ...OFF, props: 'permissive', maxPropBytes: 20 })

    expect(jsonHas(result, 'y'.repeat(500))).toBe(false)
    expect(typeof result.chain[0]?.payload).toBe('string')
  })
})

describe('Permissive mode', () => {
  it('captures an arbitrary custom property outside the default allow list', () => {
    const err = new Error('boom')
    mut(err).requestId = 'req_123'

    const result = serializeError(err, { ...OFF, props: 'permissive' })

    expect(result.chain[0]).toMatchObject({ requestId: 'req_123' })
  })

  it('still captures default-allowed properties alongside custom ones', () => {
    const err = new Error('boom')
    mut(err).code = 'E_X'
    mut(err).extra = 'also kept'

    const result = serializeError(err, { ...OFF, props: 'permissive' })

    expect(result.chain[0]).toMatchObject({ code: 'E_X', extra: 'also kept' })
  })

  it('never re-exposes name, message, stack, cause, or errors as custom properties', () => {
    const err = new Error('boom', { cause: new Error('root') })

    const result = serializeError(err, { ...OFF, props: 'permissive' })
    const entry = result.chain[0] as Record<string, unknown>

    // these are structural fields with their own semantics, not permissive-mode passthroughs
    expect(entry.name).toBe('Error')
    expect(entry.message).toBe('boom')
    expect(entry.cause).toBeUndefined()
  })

  it('never throws and stays JSON-safe on a self-referential custom property', () => {
    const err = new Error('boom')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    mut(err).payload = cyclic

    expect(() => serializeError(err, { ...OFF, props: 'permissive' })).not.toThrow()
    const result = serializeError(err, { ...OFF, props: 'permissive' })
    expect(() => JSON.stringify(result)).not.toThrow()
  })
})

describe('Redaction by key pattern', () => {
  it.each([
    ['token', 'tok_live_abc'],
    ['secret', 'shh'],
    ['password', 'hunter2'],
    ['Authorization', 'Bearer abc'],
    ['apiKey', 'sk_live_xyz'],
    ['api_key', 'sk_live_xyz2'],
  ])('redacts a top-level permissive property named "%s"', (key, secretValue) => {
    const err = new Error('boom')
    mut(err)[key] = secretValue

    const result = serializeError(err, { ...OFF, props: 'permissive' })

    expect(jsonHas(result, secretValue)).toBe(false)
    expect(result.chain[0]?.[key]).not.toBe(secretValue)
  })

  it('does not redact a property whose name does not match any pattern', () => {
    const err = new Error('boom')
    mut(err).requestId = 'req_123'

    const result = serializeError(err, { ...OFF, props: 'permissive' })

    expect(result.chain[0]).toMatchObject({ requestId: 'req_123' })
  })

  it('redacts a secret nested inside a permissive object property (axios-style config.headers.Authorization)', () => {
    const err = new Error('Request failed with status code 401')
    mut(err).config = {
      url: '/api/orders',
      headers: { Authorization: 'Bearer super-secret-token', Accept: 'application/json' },
    }

    const result = serializeError(err, { ...OFF, props: 'permissive' })

    expect(jsonHas(result, 'super-secret-token')).toBe(false)
    const config = result.chain[0]?.config as { headers?: Record<string, unknown> }
    expect(config.headers?.Accept).toBe('application/json')
  })

  it('honours a custom `redact` pattern list', () => {
    const err = new Error('boom')
    mut(err).internalId = 'must-not-leak'

    const result = serializeError(err, { ...OFF, props: 'permissive', redact: [/internalId/i] })

    expect(jsonHas(result, 'must-not-leak')).toBe(false)
  })

  it('does not redact allow-listed properties in allowlist mode even if named suspiciously', () => {
    // allowlist mode is safe by curation, not by redaction — this documents that the two
    // mechanisms are independent and allowlist mode never even reaches the redact check
    const err = new Error('boom')
    mut(err).code = 'TOKEN_EXPIRED'

    const result = serializeError(err, OFF)

    expect(result.chain[0]).toMatchObject({ code: 'TOKEN_EXPIRED' })
  })
})

describe('Alias following (.original, .parent, .errors) when `cause` is absent', () => {
  it('follows `.original` when there is no `cause`', () => {
    const original = new Error('connection terminated unexpectedly')
    mut(original).code = 'ECONNRESET'
    const wrapper = new Error('Database operation failed')
    mut(wrapper).original = original

    const result = serializeError(wrapper, OFF)

    expect(result.chain).toHaveLength(2)
    expect(result.chain[1]).toMatchObject({ message: 'connection terminated unexpectedly', code: 'ECONNRESET' })
  })

  it('follows `.parent` when there is no `cause` and no `.original`', () => {
    const original = new Error('root failure')
    const wrapper = new Error('wrapped');
    mut(wrapper).parent = original

    const result = serializeError(wrapper, OFF)

    expect(result.chain.map((e) => e.message)).toContain('root failure')
  })

  it('follows a non-array `.errors` as a single alias when there is no `cause`', () => {
    const original = new Error('single underlying error')
    const wrapper = new Error('wrapped')
    mut(wrapper).errors = original

    const result = serializeError(wrapper, OFF)

    expect(result.chain.map((e) => e.message)).toContain('single underlying error')
  })

  it('does not treat an array `.errors` as a single alias — that stays AggregateError-style breadth', () => {
    const agg = new AggregateError([new Error('child a'), new Error('child b')], 'agg')

    const result = serializeError(agg, OFF)

    expect(result.chain).toHaveLength(1)
    expect(result.chain[0]?.aggregateErrors).toHaveLength(2)
  })

  it('prefers a real `cause` over any alias', () => {
    const realCause = new Error('the real cause')
    const wrapper = new Error('wrapped', { cause: realCause })
    mut(wrapper).original = new Error('should not appear')

    const result = serializeError(wrapper, OFF)

    expect(result.chain.map((e) => e.message)).toContain('the real cause')
    expect(result.chain.map((e) => e.message)).not.toContain('should not appear')
  })

  it('does not follow aliases when followAliases is false', () => {
    const original = new Error('hidden')
    const wrapper = new Error('wrapped')
    mut(wrapper).original = original

    const result = serializeError(wrapper, { ...OFF, followAliases: false })

    expect(result.chain).toHaveLength(1)
    expect(result.chain.map((e) => e.message)).not.toContain('hidden')
  })

  it('checks `.original` before `.parent` when both are present', () => {
    const wrapper = new Error('wrapped')
    mut(wrapper).original = new Error('from original')
    mut(wrapper).parent = new Error('from parent')

    const result = serializeError(wrapper, OFF)

    expect(result.chain.map((e) => e.message)).toContain('from original')
    expect(result.chain.map((e) => e.message)).not.toContain('from parent')
  })
})

describe('Realistic error shapes', () => {
  it('captures a pg-style error via the default allow list', () => {
    const pgError = new Error('duplicate key value violates unique constraint "orders_pkey"')
    Object.assign(pgError, {
      code: '23505',
      constraint: 'orders_pkey',
      table: 'orders',
      column: 'id',
      detail: 'Key (id)=(1) already exists.',
    })

    const result = serializeError(pgError, OFF)

    expect(result.chain[0]).toMatchObject({
      code: '23505',
      constraint: 'orders_pkey',
      table: 'orders',
      column: 'id',
      detail: 'Key (id)=(1) already exists.',
    })
  })

  it('captures a Stripe-style error safely by default and redacts its headers in permissive mode', () => {
    const stripeError = new Error('Your card was declined.')
    Object.assign(stripeError, {
      type: 'StripeCardError',
      statusCode: 402,
      raw: { message: 'Your card was declined.' },
      headers: { 'request-id': 'req_abc', authorization: 'Bearer sk_live_should_not_leak' },
    })

    const defaultResult = serializeError(stripeError, OFF)
    expect(defaultResult.chain[0]).toMatchObject({ type: 'StripeCardError', statusCode: 402 })
    expect(defaultResult.chain[0]).not.toHaveProperty('headers')
    expect(jsonHas(defaultResult, 'sk_live_should_not_leak')).toBe(false)

    const permissiveResult = serializeError(stripeError, { ...OFF, props: 'permissive' })
    expect(jsonHas(permissiveResult, 'sk_live_should_not_leak')).toBe(false)
  })

  it('captures an axios-style error, redacting nested auth and surviving a circular request/response', () => {
    const axiosError = new Error('Request failed with status code 401') as Error & {
      config?: unknown
      request?: unknown
      response?: unknown
      code?: string
    }
    axiosError.code = 'ERR_BAD_REQUEST'
    const request: Record<string, unknown> = {}
    const response: Record<string, unknown> = { status: 401, req: request }
    request.res = response
    axiosError.config = { url: '/orders', headers: { Authorization: 'Bearer leaked-if-broken' } }
    axiosError.request = request
    axiosError.response = response

    expect(() => serializeError(axiosError, { ...OFF, props: 'permissive' })).not.toThrow()
    const result = serializeError(axiosError, { ...OFF, props: 'permissive' })
    expect(() => JSON.stringify(result)).not.toThrow()
    expect(jsonHas(result, 'leaked-if-broken')).toBe(false)
    expect(result.chain[0]).toMatchObject({ code: 'ERR_BAD_REQUEST' })
  })

  it('captures a Node ENOENT-style error via the default allow list', () => {
    const enoent = new Error("ENOENT: no such file or directory, open 'missing.txt'")
    Object.assign(enoent, { code: 'ENOENT', errno: -2, syscall: 'open', path: 'missing.txt' })

    const result = serializeError(enoent, OFF)

    expect(result.chain[0]).toMatchObject({
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      path: 'missing.txt',
    })
  })

  it('walks a Sequelize/Prisma-style wrapper via `.original`', () => {
    const rawPgError = new Error('null value in column "email" violates not-null constraint')
    Object.assign(rawPgError, { code: '23502', column: 'email', table: 'users' })

    class SequelizeDatabaseError extends Error {
      original: Error
      constructor(message: string, original: Error) {
        super(message)
        this.name = 'SequelizeDatabaseError'
        this.original = original
      }
    }
    const wrapper = new SequelizeDatabaseError('Database operation failed', rawPgError)

    const result = serializeError(wrapper, OFF)

    expect(result.chain).toHaveLength(2)
    expect(result.chain[0]).toMatchObject({ name: 'SequelizeDatabaseError' })
    expect(result.chain[1]).toMatchObject({ code: '23502', column: 'email', table: 'users' })
  })
})
