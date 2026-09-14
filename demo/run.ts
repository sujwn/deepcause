import { deserializeError, fingerprint, serializeError } from '../src/index.js'

function section(title: string, build: () => unknown, opts?: Parameters<typeof serializeError>[1]): void {
  console.log(`\n=== ${title} ===`)
  const result = serializeError(build(), opts)
  console.log(JSON.stringify(result, null, 2))
}

// pitch: repo -> service -> Postgres, three layers deep.
section('checkout failed (service -> repo -> pg)', () => {
  const pgError = new Error('duplicate key value violates unique constraint "orders_idempotency_key_key"')
  Object.assign(pgError, {
    code: '23505',
    constraint: 'orders_idempotency_key_key',
    table: 'orders',
  })

  const repoError = new Error('insert order ord_91a4 failed', { cause: pgError })
  return new Error('checkout failed for user usr_8812', { cause: repoError })
})

// A getter that throws mid-chain — the serializer must survive and keep going.
section('a hostile getter mid-chain', () => {
  const mid = new Error('mid layer')
  Object.defineProperty(mid, 'code', {
    enumerable: true,
    get() {
      throw new Error('code getter exploded')
    },
  })
  return new Error('top layer', { cause: mid })
})

// A real cycle: a -> b -> a.
section('a cyclic cause chain', () => {
  const a = new Error('a') as Error & { cause?: unknown }
  const b = new Error('b') as Error & { cause?: unknown }
  a.cause = b
  b.cause = a
  return a
})

// AggregateError with a breadth cap, plus its own separate cause.
section('AggregateError: 15 children + its own cause', () => {
  const children = Array.from({ length: 15 }, (_, i) => new Error(`child ${i} failed`))
  return new AggregateError(children, 'batch job failed', {
    cause: new Error('the queue connection dropped'),
  })
})

// A thrown non-Error value — deepcause never assumes it's dealing with an Error.
section('a thrown plain string', () => 'everything is on fire')

// An axios-style error: allowlist mode is safe by default, permissive mode redacts secrets it doesn't recognize.
const axiosLikeError = () => {
  const err = new Error('Request failed with status code 401')
  Object.assign(err, {
    code: 'ERR_BAD_REQUEST',
    config: { url: '/orders', headers: { Authorization: 'Bearer super-secret-token', Accept: 'application/json' } },
  })
  return err
}
console.log('\n=== axios-style error: allowlist (default) vs permissive ===')
console.log('-- allowlist (props not on the default allow list are dropped entirely) --')
console.log(JSON.stringify(serializeError(axiosLikeError(), { stack: 'off' }), null, 2))
console.log('-- permissive (captures everything, but redacts by key pattern) --')
console.log(JSON.stringify(serializeError(axiosLikeError(), { stack: 'off', props: 'permissive' }), null, 2))

// A Sequelize-style wrapper with no `cause`, only `.original` — followed automatically.
section('a Sequelize-style wrapper (.original alias, no cause)', () => {
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
  return new SequelizeDatabaseError('Database operation failed', rawPgError)
}, { stack: 'off' })

// Stack policies: 'deepest' (default) keeps the full filtered stack only on the root cause,
// giving intermediates just their top app frame. 'off' drops stacks entirely.
function chainWithRealStacks(): Error {
  function dbLayer(): Error {
    return new Error('duplicate key value violates unique constraint "orders_pkey"')
  }
  function repoLayer(): Error {
    return new Error('insert order failed', { cause: dbLayer() })
  }
  return new Error('checkout failed', { cause: repoLayer() })
}
console.log('\n=== stack policies on the same 3-level chain ===')
for (const stack of ['off', 'first-frame', 'deepest', 'full'] as const) {
  console.log(`-- stack: '${stack}' --`)
  console.log(JSON.stringify(serializeError(chainWithRealStacks(), { stack }), null, 2))
}

// Nested shape, side by side with the same input in flat shape.
console.log('\n=== flat vs nested shape, same chain ===')
const buildChain = () => new Error('outer', { cause: new Error('inner', { cause: new Error('root cause') }) })
console.log('-- flat --')
console.log(JSON.stringify(serializeError(buildChain()), null, 2))
console.log('-- nested --')
console.log(JSON.stringify(serializeError(buildChain(), { shape: 'nested' }), null, 2))

// deserializeError: round-trip through JSON, then rebuild a real Error with the chain relinked.
console.log('\n=== deserializeError round trip ===')
const original = (() => {
  const pgError = new Error('duplicate key value violates unique constraint "orders_pkey"')
  Object.assign(pgError, { code: '23505', constraint: 'orders_pkey' })
  return new Error('checkout failed', { cause: pgError })
})()
const wire = JSON.parse(JSON.stringify(serializeError(original, { stack: 'off' })))
const revived = deserializeError(wire) as Error & { code?: string; reconstructed?: boolean; cause?: unknown }
console.log('revived.message:      ', revived.message)
console.log('revived.reconstructed:', revived.reconstructed)
const cause = revived.cause as { message: string; code?: string }
console.log('revived.cause.message:', cause.message)
console.log('revived.cause.code:   ', cause.code, '(survived the JSON round trip)')

// fingerprint: two unrelated top-level messages sharing the same root cause group together;
// the same top-level message wrapping two different root causes does NOT group together.
console.log('\n=== fingerprint: keyed on the root cause, not the top-level message ===')
function pg(message: string, code: string): Error {
  const err = new Error(message)
  Object.assign(err, { code })
  return err
}
const checkoutA = new Error('checkout failed for user usr_8812', {
  cause: new Error('insert order ord_91a4 failed', { cause: pg('duplicate key value', '23505') }),
})
const checkoutB = new Error('order placement failed', { cause: pg('duplicate key value', '23505') })
const checkoutC = new Error('checkout failed for user usr_1204', {
  cause: new Error('insert order ord_55c1 failed', { cause: pg('connection terminated', 'ECONNRESET') }),
})
console.log('checkoutA fingerprint:', fingerprint(checkoutA), ' (message: "checkout failed for user usr_8812")')
console.log('checkoutB fingerprint:', fingerprint(checkoutB), ' (message: "order placement failed")')
console.log('checkoutC fingerprint:', fingerprint(checkoutC), ' (message: "checkout failed for user usr_1204")')
console.log('A === B (same root cause, different wrapper):', fingerprint(checkoutA) === fingerprint(checkoutB))
console.log('A === C (same wrapper shape, different root cause):', fingerprint(checkoutA) === fingerprint(checkoutC))
