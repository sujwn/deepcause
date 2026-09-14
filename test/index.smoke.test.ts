import { describe, expect, it } from 'vitest'
import { deserializeError, fingerprint, serializeError } from '../src/index.js'

describe('module shape', () => {
  it('exports the three public functions', () => {
    expect(typeof serializeError).toBe('function')
    expect(typeof deserializeError).toBe('function')
    expect(typeof fingerprint).toBe('function')
  })

  it('serializes a plain error', () => {
    const result = serializeError(new Error('x'))
    expect(result.message).toBe('x')
    expect(result.chain).toHaveLength(1)
  })

  it('round-trips a plain error through deserializeError', () => {
    const revived = deserializeError(serializeError(new Error('x')))
    expect(revived.message).toBe('x')
    expect(revived.reconstructed).toBe(true)
  })

  it('fingerprints an error as a string', () => {
    expect(typeof fingerprint(new Error('x'))).toBe('string')
  })
})
