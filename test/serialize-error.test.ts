import { runInNewContext } from 'node:vm'
import { types } from 'node:util'
import { describe, expect, it } from 'vitest'
import { serializeError } from '../src/index.js'
import type { SerializedError, SerializedErrorEntry } from '../src/index.js'

const mut = (o: object): Record<string, unknown> => o as Record<string, unknown>

function assertNoUnsafeValues(value: unknown, path = '$'): void {
  const kind = typeof value
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol' || kind === 'bigint') {
    throw new Error(`JSON-unsafe ${kind} at ${path}`)
  }
  if (value === null || kind !== 'object') return
  if (Object.getOwnPropertySymbols(value as object).length > 0) {
    throw new Error(`symbol key at ${path}`)
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUnsafeValues(v, `${path}[${i}]`))
    return
  }
  for (const [k, v] of Object.entries(value as object)) {
    assertNoUnsafeValues(v, `${path}.${k}`)
  }
}

function expectJsonSafe(result: unknown): void {
  const json = JSON.stringify(result)
  expect(typeof json).toBe('string')
  expect(JSON.parse(json)).toStrictEqual(result)
  expect(() => assertNoUnsafeValues(result)).not.toThrow()
}

function instrumentStack(err: object): { reads: number } {
  const counter = { reads: 0 }
  Object.defineProperty(err, 'stack', {
    configurable: true,
    enumerable: false,
    get() {
      counter.reads++
      return 'Error: instrumented\n    at frame (file.js:1:1)'
    },
  })
  return counter
}

function snapshotShape(obj: object) {
  return {
    names: Object.getOwnPropertyNames(obj),
    symbols: Object.getOwnPropertySymbols(obj).map(String),
    descriptors: Object.getOwnPropertyNames(obj).map((n) => {
      const d = Object.getOwnPropertyDescriptor(obj, n)
      return [n, d?.writable, d?.enumerable, d?.configurable, typeof d?.get]
    }),
    frozen: Object.isFrozen(obj),
    sealed: Object.isSealed(obj),
    prototype: Object.getPrototypeOf(obj),
  }
}

function collectEntries(result: SerializedError): SerializedErrorEntry[] {
  const out: SerializedErrorEntry[] = []
  const visit = (entries: readonly SerializedErrorEntry[] | undefined): void => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      out.push(entry)
      visit(entry.aggregateErrors)
      const nested = entry.cause
      if (nested && typeof nested === 'object') visit([nested as SerializedErrorEntry])
    }
  }
  visit(result.chain)
  return out
}

function buildChain(depth: number): { top: Error; root: Error; all: Error[] } {
  let current = new Error('depth 0')
  const all: Error[] = [current]
  for (let i = 1; i < depth; i++) {
    current = new Error(`depth ${i}`, { cause: current })
    all.push(current)
  }
  return { top: current, root: all[0] as Error, all }
}

const OFF = { stack: 'off' } as const

describe('`cause` is a string / `null` / plain object / number', () => {
  it.each([
    ['string', 'just a string'],
    ['null', null],
    ['number', 42],
  ])('emits { nonError: true, value } for a %s cause and stops', (_label, cause) => {
    const result = serializeError(new Error('wrap', { cause }), OFF)

    expect(result.chain).toHaveLength(2)
    expect(result.chain[0]).toMatchObject({ message: 'wrap' })
    expect(result.chain[1]).toMatchObject({ nonError: true, value: cause })
    expectJsonSafe(result)
  })

  it('emits { nonError: true, value } for a plain-object cause', () => {
    const result = serializeError(new Error('wrap', { cause: { code: 'X' } }), OFF)

    expect(result.chain).toHaveLength(2)
    expect(result.chain[1]).toMatchObject({ nonError: true, value: { code: 'X' } })
    expectJsonSafe(result)
  })

  it('stops walking: a plain-object cause carrying its own `cause` is not followed', () => {
    const buried = new Error('must not appear')
    const result = serializeError(new Error('wrap', { cause: { cause: buried } }), OFF)

    expect(result.chain).toHaveLength(2)
    expect(collectEntries(result).map((e) => e.message)).not.toContain('must not appear')
  })

  it('does not treat a non-error cause as an error entry', () => {
    const result = serializeError(new Error('wrap', { cause: 'a string' }), OFF)

    expect(result.chain[1]).not.toHaveProperty('stack')
    expect(result.chain[1]?.nonError).toBe(true)
  })
})

describe('`new Error(m, { cause: undefined })`', () => {
  it('the property genuinely exists — this is what the walk must test', () => {
    expect('cause' in new Error('m', { cause: undefined })).toBe(true)
    expect('cause' in new Error('m')).toBe(false)
    expect(new Error('m', { cause: undefined }).cause).toBeUndefined()
    expect(new Error('m').cause).toBeUndefined()
  })

  it('reports the explicitly-undefined cause as a chain entry', () => {
    const result = serializeError(new Error('m', { cause: undefined }), OFF)

    expect(result.chain).toHaveLength(2)
    expect(result.chain[1]).toMatchObject({ nonError: true })
    expectJsonSafe(result)
  })

  it('an error with no `cause` key produces a single-entry chain', () => {
    const result = serializeError(new Error('m'), OFF)

    expect(result.chain).toHaveLength(1)
    expectJsonSafe(result)
  })

  it('distinguishes an absent cause from a present-but-undefined one', () => {
    const absent = serializeError(new Error('m'), OFF)
    const present = serializeError(new Error('m', { cause: undefined }), OFF)

    expect(present.chain.length).toBeGreaterThan(absent.chain.length)
  })
})

describe('Cyclic causes (`a.cause = b; b.cause = a`)', () => {
  it('terminates on a mutual cycle and marks it circular', () => {
    const a = new Error('a')
    const b = new Error('b')
    mut(a).cause = b
    mut(b).cause = a

    const result = serializeError(a, OFF)
    const entries = collectEntries(result)

    expect(entries.some((e) => e.circular === true)).toBe(true)
    expect(entries.filter((e) => e.message === 'a' && !e.circular)).toHaveLength(1)
    expect(entries.filter((e) => e.message === 'b' && !e.circular)).toHaveLength(1)
    expectJsonSafe(result)
  })

  it('terminates on a self-cycle', () => {
    const s = new Error('s')
    mut(s).cause = s

    const result = serializeError(s, OFF)

    expect(collectEntries(result).some((e) => e.circular === true)).toBe(true)
    expectJsonSafe(result)
  })

  it('terminates on a three-error cycle', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    const c = new Error('c', { cause: b })
    mut(a).cause = c

    const result = serializeError(c, OFF)

    expect(collectEntries(result).some((e) => e.circular === true)).toBe(true)
    expectJsonSafe(result)
  })

  it('survives JSON.stringify — the output carries no live cycle', () => {
    const a = new Error('a')
    const b = new Error('b')
    mut(a).cause = b
    mut(b).cause = a

    expect(() => JSON.stringify(serializeError(a, OFF))).not.toThrow()
  })
})

describe('Diamond — same error reached via two paths', () => {
  it('serializes the shared root once — a fresh Set per branch would duplicate it', () => {
    const root = new Error('the shared root')
    const left = new Error('left', { cause: root })
    const right = new Error('right', { cause: root })
    const top = new AggregateError([left, right], 'top')

    const result = serializeError(top, OFF)
    const entries = collectEntries(result)

    expect(entries.filter((e) => e.message === 'the shared root' && !e.circular)).toHaveLength(1)
    expect(entries.some((e) => e.circular === true)).toBe(true)
    expectJsonSafe(result)
  })

  it('detects a diamond formed through `cause` alone', () => {
    const root = new Error('shared')
    const left = new Error('left', { cause: root })
    const right = new Error('right', { cause: root })
    const top = new Error('top', { cause: left })
    mut(top).extra = right

    const result = serializeError(top, OFF)
    const entries = collectEntries(result)

    expect(entries.filter((e) => e.message === 'shared' && !e.circular).length).toBeLessThanOrEqual(1)
    expectJsonSafe(result)
  })

  it('threads the same Set into AggregateError children, not a fresh one', () => {
    const root = new Error('root')
    const inner = new AggregateError([new Error('a', { cause: root })], 'inner')
    const outer = new AggregateError([inner, new Error('b', { cause: root })], 'outer')

    const result = serializeError(outer, OFF)
    const entries = collectEntries(result)

    expect(entries.filter((e) => e.message === 'root' && !e.circular)).toHaveLength(1)
    expectJsonSafe(result)
  })
})

describe('`AggregateError` with 500 children', () => {
  const build = () =>
    new AggregateError(
      Array.from({ length: 500 }, (_, i) => new Error(`child ${i}`)),
      'all failed',
    )

  it('caps at the default maxAggregate and records aggregateTruncated: 490', () => {
    const result = serializeError(build(), OFF)
    const top = result.chain[0]

    expect(top?.aggregateErrors).toHaveLength(10)
    expect(top?.aggregateTruncated).toBe(490)
    expectJsonSafe(result)
  })

  it('honours an explicit maxAggregate', () => {
    const result = serializeError(build(), { ...OFF, maxAggregate: 3 })
    const top = result.chain[0]

    expect(top?.aggregateErrors).toHaveLength(3)
    expect(top?.aggregateTruncated).toBe(497)
    expectJsonSafe(result)
  })

  it('omits aggregateTruncated when nothing was dropped', () => {
    const result = serializeError(new AggregateError([new Error('only')], 'agg'), OFF)

    expect(result.chain[0]).not.toHaveProperty('aggregateTruncated')
  })

  it('never reads .stack on children it discards', () => {
    const children = Array.from({ length: 500 }, (_, i) => new Error(`child ${i}`))
    const discarded = [children[100], children[300], children[499]].map((c) =>
      instrumentStack(c as Error),
    )

    serializeError(new AggregateError(children, 'all failed'))

    for (const counter of discarded) expect(counter.reads).toBe(0)
  })

  it('keeps output bounded — 500 children must not produce 500 entries', () => {
    const result = serializeError(build(), OFF)

    expect(collectEntries(result).length).toBeLessThan(30)
  })
})

describe('`AggregateError` that also has a `cause`', () => {
  it('walks both the children and the cause — it is a tree, not a list', () => {
    const agg = new AggregateError([new Error('c1'), new Error('c2')], 'agg', {
      cause: new Error('the cause'),
    })

    const result = serializeError(agg, OFF)
    const messages = collectEntries(result).map((e) => e.message)

    expect(messages).toContain('c1')
    expect(messages).toContain('c2')
    expect(messages).toContain('the cause')
    expectJsonSafe(result)
  })

  it('walks a cause chain hanging off an AggregateError', () => {
    const deep = new Error('deep root')
    const agg = new AggregateError([new Error('child')], 'agg', {
      cause: new Error('mid', { cause: deep }),
    })

    const messages = collectEntries(serializeError(agg, OFF)).map((e) => e.message)

    expect(messages).toContain('child')
    expect(messages).toContain('mid')
    expect(messages).toContain('deep root')
  })

  it('walks an AggregateError nested inside a cause chain', () => {
    const agg = new AggregateError([new Error('inner child')], 'inner agg')
    const top = new Error('top', { cause: agg })

    const messages = collectEntries(serializeError(top, OFF)).map((e) => e.message)

    expect(messages).toContain('inner agg')
    expect(messages).toContain('inner child')
  })
})

describe('Cross-realm error (worker, `vm`, native addon)', () => {
  it('serializes a vm-realm error that fails instanceof', () => {
    const crossRealm = runInNewContext('new Error("from vm")') as Error

    expect(crossRealm instanceof Error).toBe(false)
    expect(types.isNativeError(crossRealm)).toBe(true)

    const result = serializeError(crossRealm, OFF)

    expect(result.chain[0]).toMatchObject({ name: 'Error', message: 'from vm' })
    expect(result.chain[0]).not.toHaveProperty('nonError')
    expectJsonSafe(result)
  })

  it('walks a cause chain built inside another realm', () => {
    const crossRealm = runInNewContext(
      'new Error("outer", { cause: new Error("inner") })',
    ) as Error

    const messages = collectEntries(serializeError(crossRealm, OFF)).map((e) => e.message)

    expect(messages).toContain('outer')
    expect(messages).toContain('inner')
  })

  it('serializes a DOMException via the duck-typing fallback', () => {
    const DomException = (globalThis as Record<string, unknown>).DOMException as new (
      message?: string,
      name?: string,
    ) => Error
    const ex = new DomException('nope', 'InvalidStateError')

    expect(types.isNativeError(ex)).toBe(false)

    const result = serializeError(ex, OFF)

    expect(result.chain[0]).toMatchObject({ name: 'InvalidStateError', message: 'nope' })
    expect(result.chain[0]).not.toHaveProperty('nonError')
  })

  it('treats an object with string message and stack as error-like', () => {
    const duck = { name: 'CustomError', message: 'quacks', stack: 'CustomError: quacks\n    at x' }

    const result = serializeError(duck, OFF)

    expect(result.chain[0]).toMatchObject({ name: 'CustomError', message: 'quacks' })
    expect(result.chain[0]).not.toHaveProperty('nonError')
  })

  it('does not treat an arbitrary plain object as error-like', () => {
    const result = serializeError({ code: 'X' }, OFF)

    expect(result.chain[0]).toMatchObject({ nonError: true })
  })

  it('requires both message and stack to be strings', () => {
    const noStack = serializeError({ name: 'E', message: 'm' }, OFF)
    const badTypes = serializeError({ name: 'E', message: 1, stack: 2 }, OFF)

    expect(noStack.chain[0]).toMatchObject({ nonError: true })
    expect(badTypes.chain[0]).toMatchObject({ nonError: true })
  })

  it('walks a cross-realm error reached as a cause', () => {
    const crossRealm = runInNewContext('new Error("vm cause")') as Error
    const top = new Error('local', { cause: crossRealm })

    const messages = collectEntries(serializeError(top, OFF)).map((e) => e.message)

    expect(messages).toContain('vm cause')
  })
})

describe('Getter that throws or has side effects', () => {
  const throwing = (prop: string, err: object) => {
    Object.defineProperty(err, prop, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error(`${prop} getter exploded`)
      },
    })
  }

  it('omits a custom property whose getter throws, without failing', () => {
    const err = new Error('boom')
    mut(err).code = 'KEPT'
    throwing('detail', err)

    const result = serializeError(err, OFF)

    expect(result.chain[0]).toMatchObject({ message: 'boom', code: 'KEPT' })
    expect(result.chain[0]).not.toHaveProperty('detail')
    expectJsonSafe(result)
  })

  it('survives a throwing `message` getter', () => {
    const err = new Error('unused')
    throwing('message', err)

    expect(() => serializeError(err, OFF)).not.toThrow()
    expectJsonSafe(serializeError(err, OFF))
  })

  it('survives a throwing `name` getter', () => {
    const err = new Error('has name trouble')
    throwing('name', err)

    expect(() => serializeError(err, OFF)).not.toThrow()
  })

  it('survives a throwing `cause` getter — the one that drives the walk', () => {
    const err = new Error('top')
    throwing('cause', err)

    const result = serializeError(err, OFF)

    expect(result.chain[0]).toMatchObject({ message: 'top' })
    expectJsonSafe(result)
  })

  it('survives a throwing `stack` getter', () => {
    const err = new Error('stacky')
    throwing('stack', err)

    expect(() => serializeError(err)).not.toThrow()
  })

  it('survives a throwing getter midway down a chain', () => {
    const mid = new Error('mid')
    throwing('code', mid)
    const top = new Error('top', { cause: new Error('upper', { cause: mid }) })

    const messages = collectEntries(serializeError(top, OFF)).map((e) => e.message)

    expect(messages).toContain('top')
    expect(messages).toContain('mid')
  })

  it('reads a side-effecting getter at most once', () => {
    let reads = 0
    const err = new Error('counted')
    Object.defineProperty(err, 'code', {
      configurable: true,
      enumerable: true,
      get() {
        reads++
        return 'E_COUNTED'
      },
    })

    serializeError(err, OFF)

    expect(reads).toBeLessThanOrEqual(1)
  })

  it('survives a throwing getter on an AggregateError child', () => {
    const child = new Error('child')
    throwing('code', child)

    expect(() => serializeError(new AggregateError([child], 'agg'), OFF)).not.toThrow()
  })
})

describe('`.stack` is a lazy V8 getter', () => {
  it('never reads .stack when stack: "off"', () => {
    const err = new Error('x')
    const counter = instrumentStack(err)

    serializeError(err, { stack: 'off' })

    expect(counter.reads).toBe(0)
  })

  it('never reads .stack on errors discarded past maxDepth', () => {
    const { top, root } = buildChain(15)
    const counter = instrumentStack(root)

    serializeError(top, { maxDepth: 10 })

    expect(counter.reads).toBe(0)
  })

  it('never reads .stack on an entry terminated as circular', () => {
    const a = new Error('a')
    const b = new Error('b')
    mut(a).cause = b
    mut(b).cause = a
    instrumentStack(a)
    const counterB = instrumentStack(b)
    const before = counterB.reads

    serializeError(a)

    expect(counterB.reads).toBeLessThanOrEqual(before + 1)
  })

  it('never reads .stack on aggregate children past the cap', () => {
    const children = Array.from({ length: 40 }, (_, i) => new Error(`c${i}`))
    const counter = instrumentStack(children[39] as Error)

    serializeError(new AggregateError(children, 'agg'), { maxAggregate: 5 })

    expect(counter.reads).toBe(0)
  })

  it('reads .stack at most once per retained error', () => {
    const err = new Error('retained')
    const counter = instrumentStack(err)

    serializeError(err, { stack: 'full' })

    expect(counter.reads).toBeLessThanOrEqual(1)
  })
})

describe('Serializer itself hits an internal error', () => {
  it('never throws on a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()

    expect(() => serializeError(proxy, OFF)).not.toThrow()
    expectJsonSafe(serializeError(proxy, OFF))
  })

  it('never throws on a proxy whose every trap throws', () => {
    const explode = () => {
      throw new Error('trap exploded')
    }
    const hostile = new Proxy(
      {},
      {
        get: explode,
        has: explode,
        ownKeys: explode,
        getOwnPropertyDescriptor: explode,
        getPrototypeOf: explode,
      },
    )

    expect(() => serializeError(hostile, OFF)).not.toThrow()
    expectJsonSafe(serializeError(hostile, OFF))
  })

  it('never throws on a null-prototype object', () => {
    const bare = Object.create(null) as object
    mut(bare).message = 'no prototype'

    expect(() => String(bare)).toThrow()
    expect(() => serializeError(bare, OFF)).not.toThrow()
    expectJsonSafe(serializeError(bare, OFF))
  })

  it('never emits a BigInt, even from an allowlisted property', () => {
    const err = new Error('bigint')
    mut(err).errno = 10n

    const result = serializeError(err, OFF)

    expect(() => JSON.stringify(result)).not.toThrow()
    expectJsonSafe(result)
  })

  it('never throws when the cause itself is a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()

    expect(() => serializeError(new Error('top', { cause: proxy }), OFF)).not.toThrow()
  })

  it('returns the marker object when the options object is hostile', () => {
    const hostileOpts = {
      get maxDepth(): number {
        throw new Error('opts exploded')
      },
    }

    const result = serializeError(new Error('x'), hostileOpts as never)

    expect(result).toMatchObject({ message: '<serialization failed>', chain: [] })
    expect(typeof result.serializationError).toBe('string')
    expectJsonSafe(result)
  })
})

describe('Value is `undefined` / `null` at the top level', () => {
  it('accepts undefined and produces a nonError chain entry', () => {
    const result = serializeError(undefined)

    expect(result.chain).toHaveLength(1)
    expect(result.chain[0]).toMatchObject({ nonError: true })
    expectJsonSafe(result)
  })

  it('accepts null and produces a nonError chain entry', () => {
    const result = serializeError(null)

    expect(result.chain).toHaveLength(1)
    expect(result.chain[0]).toMatchObject({ nonError: true, value: null })
    expectJsonSafe(result)
  })

  it.each([
    ['string', 'a thrown string'],
    ['number', 0],
    ['boolean', false],
  ])('accepts a bare %s', (_label, value) => {
    const result = serializeError(value)

    expect(result.chain).toHaveLength(1)
    expect(result.chain[0]).toMatchObject({ nonError: true, value })
    expectJsonSafe(result)
  })

  it('always returns a string message', () => {
    for (const value of [undefined, null, 0, '', false]) {
      expect(typeof serializeError(value).message).toBe('string')
    }
  })
})

describe('Frozen or sealed error objects', () => {
  it('serializes a frozen error without mutating it', () => {
    const frozen = Object.freeze(new Error('frozen'))
    const before = snapshotShape(frozen)

    const result = serializeError(frozen, OFF)

    expect(result.chain[0]).toMatchObject({ message: 'frozen' })
    expect(snapshotShape(frozen)).toStrictEqual(before)
    expect(Object.isFrozen(frozen)).toBe(true)
    expectJsonSafe(result)
  })

  it('serializes a sealed error with a cause without mutating it', () => {
    const sealed = Object.seal(new Error('sealed', { cause: new Error('inner') }))
    const before = snapshotShape(sealed)

    const messages = collectEntries(serializeError(sealed, OFF)).map((e) => e.message)

    expect(messages).toContain('sealed')
    expect(messages).toContain('inner')
    expect(snapshotShape(sealed)).toStrictEqual(before)
  })

  it('handles a frozen error midway down the chain', () => {
    const frozenMid = Object.freeze(new Error('frozen mid', { cause: new Error('root') }))
    const top = new Error('top', { cause: frozenMid })
    const before = snapshotShape(frozenMid)

    const messages = collectEntries(serializeError(top, OFF)).map((e) => e.message)

    expect(messages).toContain('frozen mid')
    expect(messages).toContain('root')
    expect(snapshotShape(frozenMid)).toStrictEqual(before)
  })

  it('handles a frozen AggregateError', () => {
    const agg = Object.freeze(new AggregateError([new Error('c1')], 'frozen agg'))
    const before = snapshotShape(agg)

    const messages = collectEntries(serializeError(agg, OFF)).map((e) => e.message)

    expect(messages).toContain('frozen agg')
    expect(snapshotShape(agg)).toStrictEqual(before)
  })

  it('adds no marker symbol to a visited error — cycle state lives in the Set', () => {
    const a = new Error('a')
    const b = new Error('b')
    mut(a).cause = b
    mut(b).cause = a

    serializeError(a, OFF)

    expect(Object.getOwnPropertySymbols(a)).toHaveLength(0)
    expect(Object.getOwnPropertySymbols(b)).toHaveLength(0)
  })

  it('does not fail when a frozen error is the shared root of a diamond', () => {
    const root = Object.freeze(new Error('frozen root'))
    const agg = new AggregateError(
      [new Error('l', { cause: root }), new Error('r', { cause: root })],
      'top',
    )

    expect(() => serializeError(agg, OFF)).not.toThrow()
  })
})

describe('baseline: flat chain building', () => {
  it('produces one entry per error in cause order, outermost first', () => {
    const root = new Error('root')
    const mid = new Error('mid', { cause: root })
    const top = new Error('top', { cause: mid })

    const result = serializeError(top, OFF)

    expect(result.chain.map((e) => e.message)).toStrictEqual(['top', 'mid', 'root'])
    expectJsonSafe(result)
  })

  it('captures name for a subclassed error', () => {
    class DatabaseError extends Error {
      override name = 'DatabaseError'
    }

    const result = serializeError(new DatabaseError('db down'), OFF)

    expect(result.chain[0]).toMatchObject({ name: 'DatabaseError', message: 'db down' })
  })

  it('does not nest under `cause` in flat shape', () => {
    const result = serializeError(new Error('top', { cause: new Error('root') }), OFF)

    expect(result.chain[0]).not.toHaveProperty('cause')
  })
})

describe('baseline: joined top-level message', () => {
  it('joins the chain messages with ": "', () => {
    const root = new Error('duplicate key value violates unique constraint')
    const mid = new Error('insert order ord_91a4 failed', { cause: root })
    const top = new Error('checkout failed for user usr_8812', { cause: mid })

    const result = serializeError(top, OFF)

    expect(result.message).toBe(
      'checkout failed for user usr_8812: insert order ord_91a4 failed: duplicate key value violates unique constraint',
    )
  })

  it('equals the plain message for a single error', () => {
    expect(serializeError(new Error('alone'), OFF).message).toBe('alone')
  })
})

describe('baseline: maxDepth cap', () => {
  it('caps the chain at the default depth of 10', () => {
    const { top } = buildChain(25)

    expect(serializeError(top, OFF).chain).toHaveLength(10)
  })

  it('honours an explicit maxDepth', () => {
    const { top } = buildChain(25)

    expect(serializeError(top, { ...OFF, maxDepth: 3 }).chain).toHaveLength(3)
  })

  it('leaves a chain shorter than the cap untouched', () => {
    const { top } = buildChain(4)

    expect(serializeError(top, OFF).chain).toHaveLength(4)
  })
})

describe('baseline: nested shape', () => {
  it('nests causes under `cause` when shape is "nested"', () => {
    const top = new Error('top', { cause: new Error('mid', { cause: new Error('root') }) })

    const result = serializeError(top, { ...OFF, shape: 'nested' })
    const first = result.chain[0]

    expect(first).toMatchObject({ message: 'top' })
    expect(first?.cause).toMatchObject({ message: 'mid' })
    expect((first?.cause as SerializedErrorEntry)?.cause).toMatchObject({ message: 'root' })
    expectJsonSafe(result)
  })

  it('still terminates on a cycle in nested shape', () => {
    const a = new Error('a')
    const b = new Error('b')
    mut(a).cause = b
    mut(b).cause = a

    const result = serializeError(a, { ...OFF, shape: 'nested' })

    expect(collectEntries(result).some((e) => e.circular === true)).toBe(true)
    expectJsonSafe(result)
  })

  it('joins the full chain into the top-level message, same as flat shape', () => {
    const top = new Error('outer', { cause: new Error('inner', { cause: new Error('root cause') }) })

    const result = serializeError(top, { ...OFF, shape: 'nested' })

    expect(result.message).toBe('outer: inner: root cause')
  })
})
