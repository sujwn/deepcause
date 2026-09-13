import { describe, expect, it } from 'vitest'
import { deserializeError, fingerprint, serializeError } from './index.js'

describe('module shape', () => {
  it('exports the three public functions', () => {
    expect(typeof serializeError).toBe('function')
    expect(typeof deserializeError).toBe('function')
    expect(typeof fingerprint).toBe('function')
  })

  it('stub bodies throw "not implemented"', () => {
    expect(() => serializeError(new Error('x'))).toThrow('not implemented')
    expect(() =>
      deserializeError({ message: 'x', chain: [] }),
    ).toThrow('not implemented')
    expect(() => fingerprint(new Error('x'))).toThrow('not implemented')
  })
})
