# deepcause

Zero-dependency error serializer that walks the full `cause` chain, so the root cause survives the trip from `throw` to the log aggregator.

Your logs say "checkout failed". This tells you why.

```js
// repository
catch (err) { throw new Error(`insert order ${order.id} failed`, { cause: err }) }
// service
catch (err) { throw new Error(`checkout failed for user ${userId}`, { cause: err }) }
```

That code produces this in production:

```json
{"level":50,"msg":"checkout failed for user usr_8812"}
```

The Postgres constraint name, the SQLSTATE, the table — all still sitting in memory on `err.cause.cause`, never written anywhere. `console.log`/`util.inspect` walk the chain, so it works in development and silently doesn't in production — the worst possible shape for a bug, because nobody notices until the incident where they need it.

`serializeError(err)` on that same error gives you:

```json
{
  "message": "checkout failed for user usr_8812: insert order ord_91a4 failed: duplicate key value violates unique constraint \"orders_idempotency_key_key\"",
  "chain": [
    { "name": "Error", "message": "checkout failed for user usr_8812" },
    { "name": "Error", "message": "insert order ord_91a4 failed" },
    {
      "name": "Error",
      "message": "duplicate key value violates unique constraint \"orders_idempotency_key_key\"",
      "code": "23505",
      "constraint": "orders_idempotency_key_key",
      "table": "orders"
    }
  ]
}
```

One line, whole story, safe to `JSON.stringify` and ship to your log aggregator.

## Install

```bash
npm install deepcause
```

Node 18+. Zero runtime dependencies. Dual CJS/ESM.

## The worked example

A typical three-layer stack — driver error wrapped by a repository, wrapped by a service:

```js
import { serializeError } from 'deepcause'

// db driver throws with a `code`, `constraint`, `table`
// repository
catch (err) {
  throw new Error(`insert order ${order.id} failed`, { cause: err })
}
// service
catch (err) {
  throw new Error(`checkout failed for user ${userId}`, { cause: err })
}

// wherever you log:
logger.error(serializeError(err))
```

`serializeError` never throws — feed it anything (an `Error`, a string, `null`, a plain object, an `AggregateError`) and it comes back as a plain, JSON-safe object. The chain is **flat**, not nested: every layer is a sibling in `chain`, in outermost-first order, so a query like "did any error in this chain have this Postgres code" doesn't need to know how deep the chain is or walk `.cause.cause.cause` by hand.

## Branching on the chain

Because the chain is flat, error-handling code reads like a normal array check:

```js
import { serializeError } from 'deepcause'

try {
  await checkout(order)
} catch (err) {
  const { chain } = serializeError(err)

  if (chain.some((e) => e.code === '40001')) {
    // Postgres serialization failure — safe to retry
    return retry()
  }

  logger.error({ err: serializeError(err) }, 'checkout failed')
  throw err
}
```

Add a fourth wrapping layer next month and this code keeps working — it never assumed a depth.

## Why doesn't my chain show up?

Almost always: nobody set `cause`.

```js
// loses the chain — the string concatenation is the only trace of `err` that survives
throw new Error(`checkout failed: ${err.message}`)

// keeps the chain
throw new Error('checkout failed', { cause: err })
```

`{ cause: err }` has been part of the `Error` constructor since Node 16.9 (September 2021) — deepcause doesn't do anything special to make this work, it just refuses to be the *next* library that ignores `cause` the way most loggers written before 16.9 still do.

If you *did* set `cause` and the chain still looks short, check `maxDepth` (default `10`) — it's there so a single malformed error graph can't produce an unbounded log line.

## API

### `serializeError(value, opts?) → SerializedError`

Accepts anything. Never throws. Output always survives `JSON.stringify`.

```ts
interface SerializedError {
  message: string          // chain messages joined with ': '
  chain: SerializedErrorEntry[]
  serializationError?: string  // present only if the serializer itself hit an internal error
}
```

### `deserializeError(obj) → Error`

Rebuilds a real `Error` from a `SerializedError` — relinking `cause`, restoring `name` and captured custom properties, and marking `err.reconstructed = true` so nobody mistakes a stack that arrived as data for a live trace.

```js
import { deserializeError } from 'deepcause'

const err = deserializeError(message.error)
err.code            // '23505' — survives
err.cause.cause     // chain relinked
err.reconstructed   // true
```

This exists because `structuredClone` (what `postMessage` uses across `worker_threads` and browser contexts) preserves `name`, `message`, `stack`, and `cause` on an `Error` — but drops custom own properties, which is exactly the subset that matters, since `code` is what most error-handling branches on.

### `fingerprint(value) → string`

Hashes the **deepest** chain entry's `name` + `code` + a normalized message (numbers, UUIDs, hex ids, and quoted values stripped) into a short opaque string, for grouping errors by root cause instead of top-level message.

```js
import { fingerprint } from 'deepcause'

fingerprint(checkoutFailedForUserA)  // -> 'a1b2c3d4'
fingerprint(checkoutFailedForUserB)  // -> 'a1b2c3d4' — same root cause, different user id in the message
fingerprint(checkoutFailedDifferentReason) // -> '9f8e7d6c'
```

Grouping on the top-level message the way most error trackers default to means a hundred unrelated root causes all bucket under "checkout failed" and the grouping tells you nothing. Keying on the root makes the groups mean something.

## Options reference

Passed as the second argument to `serializeError`.

| Option | Default | Notes |
|---|---|---|
| `shape` | `'flat'` | `'flat'` — one array, outermost first. `'nested'` — `{ cause: { cause: ... } }`, matching what `cause` actually means. |
| `maxDepth` | `10` | Cause-chain depth cap. |
| `maxAggregate` | `10` | `AggregateError.errors` breadth cap. |
| `stack` | `'deepest'` | `'off'` — no stacks. `'first-frame'` — one frame per entry. `'deepest'` — full stack on the root cause, one frame on everything wrapping it. `'full'` — full stack on every entry. All non-`'off'` modes filter `node_modules` and `node:internal` frames and report how many were omitted. |
| `props` | `'allowlist'` | `'allowlist'` — only the properties in `allow` are captured. `'permissive'` — every own enumerable custom property is captured, redacted by pattern, and size-capped. |
| `allow` | `['code', 'syscall', 'errno', 'path', 'constraint', 'table', 'column', 'detail', 'type', 'statusCode', 'status']` | Property names captured in allowlist mode. |
| `redact` | `[/token/i, /secret/i, /password/i, /^authorization$/i, /api[-_]?key/i]` | Key patterns replaced with `'[REDACTED]'` in permissive mode, checked at every nesting level. |
| `maxPropBytes` | `4096` | Per-property size cap, enforced in both modes. |
| `followAliases` | `true` | When `cause` is absent, also follow `.original`, `.parent`, or a non-array `.errors` — the aliases some ORMs and HTTP clients use instead of `cause`. |

`allowlist` is the default because the permissive failure mode can't be undone: a Stripe error carries `raw` and `headers`, an axios error carries `config.headers.Authorization`. Reach for `props: 'permissive'` deliberately, not by default.

## License

[MIT](LICENSE)
