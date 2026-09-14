// Plain JS on purpose: this file runs inside a real worker_threads Worker and imports the
// *built* package output, so no TypeScript transform is needed inside the worker thread.
// It demonstrates the exact claim in DESIGN.md's deserializeError section: structuredClone
// (what postMessage uses natively) drops custom own properties from an Error; deepcause's
// serializeError/deserializeError round trip keeps them.
import { parentPort } from 'node:worker_threads'
import { serializeError } from '../../dist/index.js'

const inner = new Error('connection terminated unexpectedly')
inner.code = 'ECONNRESET'
const outer = new Error('database operation failed', { cause: inner })
outer.code = 'E_DB_FAILED'

// 1) the raw Error, sent as-is — postMessage uses the structured clone algorithm natively.
parentPort.postMessage({ kind: 'raw', error: outer })

// 2) the same error, pre-serialized through deepcause first.
parentPort.postMessage({ kind: 'serialized', payload: serializeError(outer) })
