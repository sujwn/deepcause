import { describe, expect, it } from 'vitest'
import { serializeError } from '../src/index.js'
import type { SerializedErrorEntry } from '../src/index.js'

function withStack(err: Error, stack: string): Error {
  Object.defineProperty(err, 'stack', { value: stack, configurable: true, enumerable: false })
  return err
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

// A realistic three-frame app stack sandwiched between library and runtime noise, matching the
// pg-driver example in DESIGN.md: real code the developer wrote, wrapped by node_modules and node:internal.
function noisyStack(name: string, message: string): string {
  return [
    `${name}: ${message}`,
    '    at Parser.parseErrorMessage (node_modules/pg-protocol/dist/parser.js:283:98)',
    '    at Parser.handlePacket (node_modules/pg-protocol/dist/parser.js:130:29)',
    '    at Connection.query (src/db/connection.js:42:10)',
    '    at OrderRepo.insert (src/repositories/order.repo.js:16:13)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n')
}

const APP_FRAMES = [
  'at Connection.query (src/db/connection.js:42:10)',
  'at OrderRepo.insert (src/repositories/order.repo.js:16:13)',
]

describe("stack: 'off'", () => {
  it('never sets a stack field on any entry', () => {
    const root = withStack(new Error('root'), noisyStack('Error', 'root'))
    const top = withStack(new Error('top', { cause: root }), noisyStack('Error', 'top'))

    const result = serializeError(top, { stack: 'off' })

    expect(result.chain[0]).not.toHaveProperty('stack')
    expect(result.chain[1]).not.toHaveProperty('stack')
  })

  it('never invokes the stack getter', () => {
    const err = new Error('x')
    const counter = instrumentStack(err)

    serializeError(err, { stack: 'off' })

    expect(counter.reads).toBe(0)
  })
})

describe('Filter node:internal and node_modules', () => {
  it('removes node_modules and node:internal frames, keeps app frames, preserves order', () => {
    const err = withStack(new Error('pg failure'), noisyStack('Error', 'pg failure'))

    const result = serializeError(err, { stack: 'full' })
    const stack = result.chain[0]?.stack as string[]

    expect(stack.slice(0, 2)).toStrictEqual(APP_FRAMES)
    expect(stack.some((f) => f.includes('node_modules'))).toBe(false)
    expect(stack.some((f) => f.includes('node:internal'))).toBe(false)
  })

  it('keeps a stack with no noise entirely intact', () => {
    const clean = ['Error: clean', '    at doThing (src/thing.js:1:1)'].join('\n')
    const err = withStack(new Error('clean'), clean)

    const result = serializeError(err, { stack: 'full' })

    expect(result.chain[0]?.stack).toStrictEqual(['at doThing (src/thing.js:1:1)'])
  })
})

describe('Report N frames omitted', () => {
  it("appends '... N frames omitted' when noise frames were filtered", () => {
    const err = withStack(new Error('pg failure'), noisyStack('Error', 'pg failure'))

    const result = serializeError(err, { stack: 'full' })
    const stack = result.chain[0]?.stack as string[]

    expect(stack[stack.length - 1]).toBe('... 3 frames omitted')
  })

  it('adds no omitted line when nothing was filtered', () => {
    const clean = ['Error: clean', '    at doThing (src/thing.js:1:1)'].join('\n')
    const err = withStack(new Error('clean'), clean)

    const result = serializeError(err, { stack: 'full' })
    const stack = result.chain[0]?.stack as string[]

    expect(stack.some((f) => f.includes('omitted'))).toBe(false)
  })
})

describe("stack: 'full'", () => {
  it('gives every chain entry its own full filtered stack', () => {
    const root = withStack(new Error('root'), noisyStack('Error', 'root'))
    const top = withStack(new Error('top', { cause: root }), noisyStack('Error', 'top'))

    const result = serializeError(top, { stack: 'full' })

    expect(result.chain[0]?.stack).toStrictEqual([...APP_FRAMES, '... 3 frames omitted'])
    expect(result.chain[1]?.stack).toStrictEqual([...APP_FRAMES, '... 3 frames omitted'])
  })
})

describe("stack: 'first-frame'", () => {
  it('gives every chain entry exactly one frame, with no omitted-count line', () => {
    const root = withStack(new Error('root'), noisyStack('Error', 'root'))
    const top = withStack(new Error('top', { cause: root }), noisyStack('Error', 'top'))

    const result = serializeError(top, { stack: 'first-frame' })

    expect(result.chain[0]?.stack).toStrictEqual([APP_FRAMES[0]])
    expect(result.chain[1]?.stack).toStrictEqual([APP_FRAMES[0]])
  })
})

describe("stack: 'deepest' (default)", () => {
  it('gives the deepest (last) entry the full filtered stack and intermediates one frame', () => {
    const root = withStack(new Error('root'), noisyStack('Error', 'root'))
    const mid = withStack(new Error('mid', { cause: root }), noisyStack('Error', 'mid'))
    const top = withStack(new Error('top', { cause: mid }), noisyStack('Error', 'top'))

    const result = serializeError(top)

    expect(result.chain[0]?.stack).toStrictEqual([APP_FRAMES[0]])
    expect(result.chain[1]?.stack).toStrictEqual([APP_FRAMES[0]])
    expect(result.chain[2]?.stack).toStrictEqual([...APP_FRAMES, '... 3 frames omitted'])
  })

  it('is the default stack policy when no options are passed', () => {
    const root = withStack(new Error('root'), noisyStack('Error', 'root'))
    const top = withStack(new Error('top', { cause: root }), noisyStack('Error', 'top'))

    const result = serializeError(top)

    expect(result.chain[0]?.stack).toHaveLength(1)
    expect(result.chain[1]?.stack?.length).toBeGreaterThan(1)
  })

  it('treats a single-entry chain as its own deepest entry', () => {
    const err = withStack(new Error('alone'), noisyStack('Error', 'alone'))

    const result = serializeError(err)

    expect(result.chain[0]?.stack).toStrictEqual([...APP_FRAMES, '... 3 frames omitted'])
  })

  it('treats the last real entry before a circular marker as deepest', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b') as Error & { cause?: unknown }
    withStack(a, noisyStack('Error', 'a'))
    withStack(b, noisyStack('Error', 'b'))
    a.cause = b
    b.cause = a

    const result = serializeError(a)

    expect(result.chain[0]?.stack).toStrictEqual([APP_FRAMES[0]])
    expect(result.chain[1]?.stack).toStrictEqual([...APP_FRAMES, '... 3 frames omitted'])
    expect(result.chain[2]).toStrictEqual({ circular: true })
  })

  it('applies deepest/intermediate independently within a `shape: "nested"` chain', () => {
    const root = withStack(new Error('root'), noisyStack('Error', 'root'))
    const top = withStack(new Error('top', { cause: root }), noisyStack('Error', 'top'))

    const result = serializeError(top, { shape: 'nested' })
    const rootEntry = result.chain[0]?.cause as SerializedErrorEntry

    expect(result.chain[0]?.stack).toStrictEqual([APP_FRAMES[0]])
    expect(rootEntry.stack).toStrictEqual([...APP_FRAMES, '... 3 frames omitted'])
  })

  it('applies its own deepest entry independently inside each AggregateError child branch', () => {
    const childRoot = withStack(new Error('child root'), noisyStack('Error', 'child root'))
    const child = withStack(new Error('child top', { cause: childRoot }), noisyStack('Error', 'child top'))
    const agg = withStack(new AggregateError([child], 'agg'), noisyStack('AggregateError', 'agg'))

    const result = serializeError(agg)
    const childEntry = result.chain[0]?.aggregateErrors?.[0]

    // the AggregateError itself has no cause of its own, so it is the deepest of the main chain
    expect(result.chain[0]?.stack).toStrictEqual([...APP_FRAMES, '... 3 frames omitted'])
    // within the child branch, "child top" is intermediate and "child root" is that branch's own deepest
    expect(childEntry?.stack).toStrictEqual([APP_FRAMES[0]])
    expect((childEntry?.cause as SerializedErrorEntry)?.stack).toStrictEqual([
      ...APP_FRAMES,
      '... 3 frames omitted',
    ])
  })
})

describe('.stack is never read for a frame that gets discarded (stack-policy aware)', () => {
  it('never reads .stack on an entry past maxDepth, under every stack policy', () => {
    for (const stack of ['off', 'full', 'deepest', 'first-frame'] as const) {
      const root = new Error('root')
      const counter = instrumentStack(root)
      let current = root
      for (let i = 0; i < 5; i++) current = new Error(`layer ${i}`, { cause: current })

      serializeError(current, { maxDepth: 3, stack })

      expect(counter.reads).toBe(0)
    }
  })

  it('never reads .stack on the terminating circular marker itself', () => {
    const a = new Error('a')
    const b = new Error('b')
    const counterA = instrumentStack(a)
    Object.assign(a, { cause: b })
    Object.assign(b, { cause: a })

    serializeError(a, { stack: 'full' })

    // "a" is read once (it's a retained real entry); the *third* chain slot is a bare
    // `{ circular: true }` marker built without ever touching `a` a second time.
    expect(counterA.reads).toBeLessThanOrEqual(1)
  })

  it('reads .stack at most once per retained entry even though "deepest" re-reads frame data', () => {
    const root = new Error('root')
    const counter = instrumentStack(root)
    const top = new Error('top', { cause: root })

    serializeError(top, { stack: 'deepest' })

    expect(counter.reads).toBeLessThanOrEqual(1)
  })
})
