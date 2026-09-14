import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { types } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { deserializeError, serializeError } from '../src/index.js'
import type { SerializedError } from '../src/index.js'

const mut = (o: object): Record<string, unknown> => o as Record<string, unknown>

describe('Rebuild the chain with cause relinked', () => {
  it('relinks a flat 3-level chain', () => {
    const root = new Error('root')
    const mid = new Error('mid', { cause: root })
    const top = new Error('top', { cause: mid })

    const revived = deserializeError(serializeError(top))

    expect(revived.message).toBe('top')
    expect((revived.cause as Error)?.message).toBe('mid')
    expect(((revived.cause as Error)?.cause as Error)?.message).toBe('root')
  })

  it('relinks a `shape: "nested"` chain the same way', () => {
    const root = new Error('root')
    const top = new Error('top', { cause: root })

    const revived = deserializeError(serializeError(top, { shape: 'nested' }))

    expect(revived.message).toBe('top')
    expect((revived.cause as Error)?.message).toBe('root')
  })

  it('reconstructs an AggregateError with its children and its own cause', () => {
    const agg = new AggregateError([new Error('c1'), new Error('c2')], 'agg', {
      cause: new Error('the cause'),
    })

    const revived = deserializeError(serializeError(agg)) as unknown as AggregateError & { cause?: unknown }

    expect(types.isNativeError(revived)).toBe(true)
    expect(Array.isArray(revived.errors)).toBe(true)
    expect(revived.errors.map((e: Error) => e.message)).toStrictEqual(['c1', 'c2'])
    expect((revived.cause as Error)?.message).toBe('the cause')
  })

  it('terminates a circular chain with a marker instead of looping forever', () => {
    const a = new Error('a')
    const b = new Error('b')
    mut(a).cause = b
    mut(b).cause = a

    const revived = deserializeError(serializeError(a))
    const bRevived = revived.cause as Error & { circular?: boolean; cause?: unknown }

    expect(revived.message).toBe('a')
    expect(bRevived.message).toBe('b')
    expect((bRevived.cause as Record<string, unknown>).circular).toBe(true)
    expect((bRevived.cause as Record<string, unknown>).cause).toBeUndefined()
  })

  it('restores a non-error cause as the raw value, not wrapped in an Error', () => {
    const top = new Error('wrap', { cause: 'a plain string cause' })

    const revived = deserializeError(serializeError(top))

    expect(revived.cause).toBe('a plain string cause')
  })
})

describe('Restore name and captured custom properties', () => {
  it('restores a custom `name`', () => {
    class DatabaseError extends Error {
      override name = 'DatabaseError'
    }

    const revived = deserializeError(serializeError(new DatabaseError('db down')))

    expect(revived.name).toBe('DatabaseError')
  })

  it('restores default-allowlisted properties', () => {
    const err = new Error('pg failure')
    Object.assign(err, { code: '23505', constraint: 'orders_pkey', table: 'orders' })

    const revived = deserializeError(serializeError(err)) as Record<string, unknown>

    expect(revived.code).toBe('23505')
    expect(revived.constraint).toBe('orders_pkey')
    expect(revived.table).toBe('orders')
  })

  it('restores permissive-mode custom properties', () => {
    const err = new Error('boom')
    mut(err).requestId = 'req_123'

    const revived = deserializeError(serializeError(err, { props: 'permissive' })) as Record<string, unknown>

    expect(revived.requestId).toBe('req_123')
  })

  it('restores a redacted value as the redaction marker, not the original secret', () => {
    const err = new Error('boom')
    mut(err).apiKey = 'sk_live_should_not_leak'

    const revived = deserializeError(serializeError(err, { props: 'permissive' })) as Record<string, unknown>

    expect(revived.apiKey).toBe('[REDACTED]')
  })
})

describe('Set reconstructed: true', () => {
  it('marks the root and every entry in its cause chain', () => {
    const root = new Error('root')
    const top = new Error('top', { cause: root })

    const revived = deserializeError(serializeError(top))

    expect(revived.reconstructed).toBe(true)
    expect((revived.cause as Record<string, unknown>).reconstructed).toBe(true)
  })

  it('marks every child inside an AggregateError', () => {
    const agg = new AggregateError([new Error('c1'), new Error('c2')], 'agg')

    const revived = deserializeError(serializeError(agg)) as unknown as { errors: Record<string, unknown>[] }

    for (const child of revived.errors) expect(child.reconstructed).toBe(true)
  })

  it('marks the degenerate empty-chain case', () => {
    const revived = deserializeError({ message: '', chain: [] })

    expect(revived.reconstructed).toBe(true)
  })

  it('marks a reconstructed non-error-only chain and preserves the value', () => {
    const revived = deserializeError(serializeError('everything is on fire'))

    expect(revived.reconstructed).toBe(true)
    expect(types.isNativeError(revived)).toBe(true)
    expect((revived as Record<string, unknown>).value).toBe('everything is on fire')
  })
})

describe('Round-trip: serialize -> JSON -> parse -> deserialize -> compare', () => {
  function roundTrip(serialized: SerializedError): ReturnType<typeof deserializeError> {
    return deserializeError(JSON.parse(JSON.stringify(serialized)) as SerializedError)
  }

  it('preserves message, name, code, and the cause chain across a flat round trip', () => {
    const pgError = new Error('duplicate key value violates unique constraint "orders_pkey"')
    Object.assign(pgError, { code: '23505', constraint: 'orders_pkey' })
    const repoError = new Error('insert failed', { cause: pgError })
    const original = new Error('checkout failed', { cause: repoError })

    const revived = roundTrip(serializeError(original))

    expect(revived.message).toBe(original.message)
    expect((revived.cause as Error).message).toBe(repoError.message)
    const root = (revived.cause as Error).cause as Record<string, unknown>
    expect(root.message).toBe(pgError.message)
    expect(root.code).toBe('23505')
    expect(root.constraint).toBe('orders_pkey')
  })

  it('preserves the same information across a nested-shape round trip', () => {
    const original = new Error('top', { cause: new Error('root', { cause: undefined }) })

    const revived = roundTrip(serializeError(original, { shape: 'nested' }))

    expect(revived.message).toBe('top')
    expect((revived.cause as Error).message).toBe('root')
  })

  it('preserves an AggregateError round trip', () => {
    const original = new AggregateError([new Error('c1'), new Error('c2')], 'agg')

    const revived = roundTrip(serializeError(original)) as unknown as { errors: Error[] }

    expect(revived.errors.map((e) => e.message)).toStrictEqual(['c1', 'c2'])
  })
})

describe('Real worker_threads test: deepcause beats structuredClone on custom properties', () => {
  const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const rootDir = fileURLToPath(new URL('..', import.meta.url))

  beforeAll(() => {
    if (!existsSync(distEntry)) {
      execFileSync('npm', ['run', 'build'], { cwd: rootDir, stdio: 'ignore', shell: true })
    }
  }, 60_000)

  it('structuredClone drops custom properties; deserializeError restores them', async () => {
    const worker = new Worker(new URL('./fixtures/worker-error.mjs', import.meta.url))
    const messages: Array<{ kind: string; error?: unknown; payload?: SerializedError }> = []

    await new Promise<void>((resolve, reject) => {
      worker.on('message', (msg) => {
        messages.push(msg)
        if (messages.length === 2) resolve()
      })
      worker.on('error', reject)
    })
    await worker.terminate()

    const raw = messages.find((m) => m.kind === 'raw')?.error as Record<string, unknown>
    const serialized = messages.find((m) => m.kind === 'serialized')?.payload as SerializedError

    // structuredClone (what postMessage uses for a raw Error) keeps message/name/cause but drops custom props.
    expect(raw.message).toBe('database operation failed')
    expect((raw.cause as Record<string, unknown>)?.message).toBe('connection terminated unexpectedly')
    expect(raw.code).toBeUndefined()
    expect((raw.cause as Record<string, unknown>)?.code).toBeUndefined()

    // deepcause's round trip keeps them.
    const revived = deserializeError(serialized) as Record<string, unknown>
    expect(revived.message).toBe('database operation failed')
    expect(revived.code).toBe('E_DB_FAILED')
    expect(revived.reconstructed).toBe(true)
    const cause = revived.cause as Record<string, unknown>
    expect(cause.message).toBe('connection terminated unexpectedly')
    expect(cause.code).toBe('ECONNRESET')
  }, 30_000)
})
