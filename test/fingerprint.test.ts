import { describe, expect, it } from 'vitest'
import { fingerprint } from '../src/index.js'

const mut = (o: object): Record<string, unknown> => o as Record<string, unknown>

function pgError(message: string, code: string): Error {
  const err = new Error(message)
  mut(err).code = code
  return err
}

describe("Hash deepest entry: name + code + normalized message", () => {
  it('gives the same fingerprint to the same root cause under two different wrappers', () => {
    const root = () => pgError('duplicate key value', '23505')
    const a = new Error('checkout failed', { cause: new Error('insert failed', { cause: root() }) })
    const b = new Error('order placement failed', { cause: root() })

    expect(fingerprint(a)).toBe(fingerprint(b))
  })

  it('gives different fingerprints to different root causes under an identical wrapper', () => {
    const wrap = (root: Error) => new Error('checkout failed', { cause: root })

    const f1 = fingerprint(wrap(pgError('duplicate key value', '23505')))
    const f2 = fingerprint(wrap(pgError('connection terminated', 'ECONNRESET')))

    expect(f1).not.toBe(f2)
  })

  it('ignores everything about intermediate wrapper entries except that they exist', () => {
    const root = () => pgError('duplicate key value', '23505')
    const wrappedOnce = new Error('checkout failed', { cause: root() })
    const wrappedTwice = new Error('order failed', {
      cause: new Error('insert failed', { cause: root() }),
    })

    expect(fingerprint(wrappedOnce)).toBe(fingerprint(wrappedTwice))
  })

  it('changes when the deepest entry\'s code changes, even with an identical message', () => {
    const f1 = fingerprint(pgError('write failed', '23505'))
    const f2 = fingerprint(pgError('write failed', '40001'))

    expect(f1).not.toBe(f2)
  })

  it("changes when the deepest entry's name changes, even with identical message and code", () => {
    class FooError extends Error {
      override name = 'FooError'
    }
    class BarError extends Error {
      override name = 'BarError'
    }

    const f1 = fingerprint(Object.assign(new FooError('same message'), { code: 'X' }))
    const f2 = fingerprint(Object.assign(new BarError('same message'), { code: 'X' }))

    expect(f1).not.toBe(f2)
  })

  it('uses the error itself as the deepest entry when there is no cause chain', () => {
    expect(fingerprint(new Error('alone'))).toBe(fingerprint(new Error('alone')))
    expect(fingerprint(new Error('alone'))).not.toBe(fingerprint(new Error('different')))
  })

  it('treats an AggregateError with no cause of its own as the deepest entry, ignoring its children', () => {
    const agg1 = new AggregateError([new Error('a'), new Error('b')], 'batch failed')
    const agg2 = new AggregateError([new Error('c')], 'batch failed')

    expect(fingerprint(agg1)).toBe(fingerprint(agg2))
  })

  it('does not throw on a cyclic cause chain and returns a stable string', () => {
    const a = new Error('a')
    const b = new Error('b')
    mut(a).cause = b
    mut(b).cause = a

    expect(() => fingerprint(a)).not.toThrow()
    expect(fingerprint(a)).toBe(fingerprint(a))
  })

  it('handles non-Error thrown values without throwing, deterministically', () => {
    expect(() => fingerprint(undefined)).not.toThrow()
    expect(() => fingerprint(null)).not.toThrow()
    expect(fingerprint('a plain string')).toBe(fingerprint('a plain string'))
    expect(fingerprint('a plain string')).not.toBe(fingerprint('a different string'))
  })

  it('always returns a string', () => {
    expect(typeof fingerprint(new Error('x'))).toBe('string')
    expect(typeof fingerprint(undefined)).toBe('string')
    expect(typeof fingerprint(42)).toBe('string')
  })
})

describe('Normalization strips numbers, UUIDs, hex ids, quoted values', () => {
  it('collapses two messages differing only by a numeric id', () => {
    const f1 = fingerprint(new Error('user 12345 not found'))
    const f2 = fingerprint(new Error('user 67890 not found'))

    expect(f1).toBe(f2)
  })

  it('collapses two messages differing only by a UUID', () => {
    const f1 = fingerprint(new Error('request 123e4567-e89b-12d3-a456-426614174000 timed out'))
    const f2 = fingerprint(new Error('request 9f8e7d6c-5b4a-3210-9876-fedcba098765 timed out'))

    expect(f1).toBe(f2)
  })

  it('collapses two messages differing only by a hex id', () => {
    const f1 = fingerprint(new Error('commit a1b2c3d4e5f6 not found'))
    const f2 = fingerprint(new Error('commit deadbeefcafe not found'))

    expect(f1).toBe(f2)
  })

  it('collapses two messages differing only by a quoted value', () => {
    const f1 = fingerprint(new Error('unique constraint "orders_pkey" violated'))
    const f2 = fingerprint(new Error("unique constraint 'orders_email_key' violated"))

    expect(f1).toBe(f2)
  })

  it('still distinguishes messages that differ in actual words, not just ids', () => {
    const f1 = fingerprint(new Error('user 12345 not found'))
    const f2 = fingerprint(new Error('order 12345 not found'))

    expect(f1).not.toBe(f2)
  })
})
