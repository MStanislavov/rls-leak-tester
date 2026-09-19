# Redis layer: ports, adapters, keys and failure policy

Status: accepted (Phase 6, first half)

## Context

Brief 4.5 asks for Redis behind small ports with two adapters each (Redis and in-memory), one
contract suite for both, a Lua sliding-window limiter, an explanation cache, a single-flight lock
and a read-through scenario cache, all under `rlsleak:{env}:{purpose}:{id}` with a TTL on every
key (rules.yaml REDIS-001). Verified against the installed toolchain: ioredis 6.0.0, Redis
7-alpine from `docker-compose.yml`, Vitest 5.

## Decisions

### Ports (`src/lib/redis/ports.ts`)

- `RateLimiter.check(key, { limit, windowMs })` returns
  `{ allowed, limit, remaining, resetMs, retryAfterMs }`. A refused request is not counted.
  `resetMs` is the time until the oldest counted request leaves the window (when `remaining`
  grows again); `retryAfterMs` is `0` when allowed and `resetMs` otherwise.
- `Cache`: `get`, `set(key, value, ttlSeconds)`, `delete`. Strings only: serialisation and zod
  validation of a cached payload belong to the caller (SEC-002). The TTL parameter is mandatory.
- `Lock`: `acquire(key, ttlMs)` returns a `LockLease { key, token }` or `undefined`;
  `release(lease)` is `true` only for the current holder.
- No ioredis type appears in a port. Keys are the branded type `RedisKey`, which only
  `keys.ts` produces, and both adapters also refuse at run time a key outside their builder's
  prefix (`RangeError`). Invalid TTLs, limits and windows are `RangeError`s on both adapters.

### Key builder (`src/lib/redis/keys.ts`)

- The namespace literal exists only there. Purposes: `ratelimit`, `explain`, `lock`, `scenario`.
- An id made of `[A-Za-z0-9_-]{1,64}` is kept (slugs, hex digests); anything else becomes
  `h.` plus its SHA-256. A plain id cannot contain a dot, so the two forms cannot collide, and no
  id can contain `:`, glob characters, whitespace or a cluster hash tag.
- Rate-limit subjects (IP, user id) are always hashed (first 128 bits of SHA-256): no address is
  stored in Redis in the clear. Id shape: `{scope}.{ip|user}.{digest}`.
- The env segment is validated (`[a-z0-9][a-z0-9-]{0,39}`), which lets the contract suite use a
  unique `test-<12 hex>` environment per run and delete that prefix only.

### Sliding window: a sorted-set log in one Lua script

`ZREMRANGEBYSCORE`, `ZCARD`, then `ZADD` + `PEXPIRE` only when below the limit, then the oldest
score for `resetMs`; one `EVAL`, so trim, count and add are atomic across processes. The limits are
small (5 to 30 per minute), so an exact log costs a few dozen bytes per subject and avoids the
approximation of the two-bucket counter. The script takes the time from the Redis server (`TIME`),
so every app instance shares one clock; the unique member is a UUID from the caller. The in-memory
adapter runs the same algorithm on an injected clock.

Plain `EVAL` instead of `defineCommand`/`EVALSHA`: the script is about 600 bytes and runs once per
request; Redis caches compiled scripts either way, and it keeps the client surface the adapters
need (`get`, `set`, `del`, `eval`) small enough to fake in unit tests.

Not verified here: `redis.call('TIME')` inside a script on Upstash. Redis 7 allows it (script
effects replication). If a managed provider refuses it, pass the caller's clock as an argument.

### Client (`adapters/redis/connection.ts`): fail fast, reconnect on demand

One `RedisConnection` per process, created lazily (`lazyConnect`), `enableOfflineQueue: false`,
`retryStrategy: () => null`, `maxRetriesPerRequest: 0`, connect and command timeouts of 2 s.
Facts read from the ioredis 6 source that shaped this:

- With the offline queue off, a command sent before `ready` is rejected at once ("Stream isn't
  writeable"), also under `lazyConnect`. So the connection awaits `connect()` itself before the
  first command, and concurrent commands share that one attempt.
- With a `retryStrategy` that returns `null` a lost connection ends in status `end`, and
  `connect()` may be called again from there. The next command therefore reconnects on demand;
  there is no background retry loop and nothing queues in memory. Proven against the container
  with `CLIENT KILL` in `tests/redis/live-redis.test.ts`.
- After a failed attempt, further commands are refused for 1 s without dialling, so a dead Redis
  costs one connect timeout, not one per request.
- A `rediss://` URL switches TLS on inside ioredis; no extra option is needed.
- An `error` listener is registered because ioredis otherwise prints every connection error.

Every failure leaves the adapters as `RedisUnavailableError { operation, cause }`. Its message
names the operation only, never the URL. A malformed limiter reply (zod) is the same error: the
limiter fails closed.

### Factory and failure policy (`factory.ts`)

`createRedisServices({ envName, redisUrl })` (a `ServerConfig` fits as is) returns
`{ backend, keys, rateLimiter, cache, lock, close }`: memory when `redisUrl` is `undefined`, Redis
otherwise. It does not read the environment (ARCH-002) and it never falls back to memory when a
configured Redis is down: callers get `RedisUnavailableError` and `/api/explain` answers `503`.
`getRedisServices(config)` memoises one instance on `globalThis` (a `Symbol.for` slot), because
`next dev` re-evaluates modules and a module variable would leak a connection and reset the
in-memory limiter on every edit.

The read-through scenario cache (`readThrough`) is the one place that fails OPEN: it is an
optimisation, so a cache that is down costs a load from the store, not the request.

### Helpers take closures, not the `Cache` port

`singleFlight({ lock, lockKey, lockTtlMs, read, produce, store, wait })` and
`readThrough({ read, load, store })` take `read`/`store` closures. Reason: the static REDIS-001
check treats every `.set(` in `src/lib/redis` outside `adapters/` as a Redis write. Rather than
dodge the pattern, the helpers hold no write at all; the caller (outside `src/lib/redis`) writes
`store: (v) => cache.set(key, JSON.stringify(v), TTL)`, and thereby also owns serialisation and
validation. For the same reason the non-adapter files use no `Map`; the process slot is a plain
property.

`singleFlight` lets a follower retry the lock on every poll, so when the producer fails the next
follower takes over instead of waiting out the timeout; it re-reads after acquiring, and a failed
release never costs the producer its result (the lock has a TTL). It returns
`{ source: "cache" | "produced" | "waited", value }` or `{ source: "timeout" }`.

### Numbers

`policy.ts` holds the rules.yaml thresholds (rate limits, 7 day explanation TTL, 30 s lock TTL,
60 s scenario TTL); `tests/redis/policy.test.ts` parses rules.yaml and fails on drift. The wait
timeout and poll interval of single-flight are NOT in rules.yaml, so they are required parameters
without a default; whoever wires `/api/explain` adds them to the thresholds. Connection timeouts
(2 s, 2 s, 1 s cool-down) are adapter internals in `REDIS_CONNECTION_DEFAULTS`.

## Tests

- `tests/redis/contract/contract.ts`: one suite, 32 tests, run by `memory.test.ts` always and by
  `redis.test.ts` when the run provides `REDIS_URL`. After every test it checks every key left
  behind: builder shape, own prefix, TTL > 0. It races three connections on real Redis: 50 parallel
  limiter calls (exactly `limit` allowed), 30 parallel acquires (one lease), 25 parallel identical
  single-flight requests (one producer, 24 read the cache), plus producer failure hand-over, TTL
  expiry, stale and foreign lease refused.
- `tests/redis/live-redis.test.ts` (real Redis only): the harness reports `-1` for a key without a
  TTL, the clean-up leaves foreign prefixes alone, reconnect after `CLIENT KILL`.
- `tests/redis/unavailable.test.ts` (hermetic): real ioredis against a closed loopback port gives
  `RedisUnavailableError` on every port within the cool-down budget.
- Unit tests beside the code drive the Redis adapters with a fake client (command shapes with
  `EX` / `PX NX`, reply parsing, error mapping), so `src/lib/redis` is covered without a server.
- Mutation check done by hand: removing `PEXPIRE` from the script fails the contract suite on real
  Redis (`expected -1 to be greater than 0`) and the static REDIS-001 check.

## Consequences

- The in-memory adapters limit and deduplicate per process only. That is the documented local
  mode; production requires `REDIS_URL` for `/api/explain` (enforced in `src/lib/config`).
- Checking IP and user is two scripts, not one: a request refused per user has already used one
  unit of the IP budget. Accepted; a two-key script would need both keys in one cluster slot.
