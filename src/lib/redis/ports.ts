/**
 * The three ports of the Redis layer. Callers (route logic in `src/lib/ai`, the
 * scenario store) depend on these interfaces only; no ioredis type appears here.
 *
 * Each port has two adapters with the same semantics, proven by one contract
 * suite (`tests/redis/contract`): Redis (`adapters/redis`) and in-memory
 * (`adapters/memory`, used when `REDIS_URL` is unset). Every method of a Redis
 * adapter rejects with `RedisUnavailableError` when Redis cannot be reached.
 * Invalid arguments (a foreign key, a TTL that is not a positive integer) are
 * programming errors and reject with a `RangeError` on both adapters.
 */
import type { RedisKey } from "./keys";

/** `limit` requests per sliding window of `windowMs` milliseconds. Positive integers. */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitResult {
  /** True when this request was counted and may proceed. A refused request is not counted. */
  readonly allowed: boolean;
  readonly limit: number;
  /** Requests left in the current window after this one. */
  readonly remaining: number;
  /**
   * Milliseconds until the oldest counted request leaves the window, which is when
   * `remaining` grows again. Feeds `RateLimit-Reset`.
   */
  readonly resetMs: number;
  /** `0` when allowed, otherwise the milliseconds to wait. Feeds `Retry-After`. */
  readonly retryAfterMs: number;
}

/** Sliding-window limiter. Check and increment are one atomic step. */
export interface RateLimiter {
  check(key: RedisKey, rule: RateLimitRule): Promise<RateLimitResult>;
}

/** String cache. There is no write without a TTL. */
export interface Cache {
  get(key: RedisKey): Promise<string | undefined>;
  /** `ttlSeconds` is mandatory and a positive integer. */
  set(key: RedisKey, value: string, ttlSeconds: number): Promise<void>;
  /** True when an entry was removed. */
  delete(key: RedisKey): Promise<boolean>;
}

/** Proof of ownership of a lock: only the holder of the token can release it. */
export interface LockLease {
  readonly key: RedisKey;
  readonly token: string;
}

/** Single-flight lock with `SET NX PX` semantics. */
export interface Lock {
  /** The lease when the lock was free, `undefined` when somebody else holds it. */
  acquire(key: RedisKey, ttlMs: number): Promise<LockLease | undefined>;
  /** True when this lease still held the lock and released it; a stale or foreign lease is refused. */
  release(lease: LockLease): Promise<boolean>;
}

/** Milliseconds since the epoch. Injectable, so the in-memory adapters are testable. */
export type Clock = () => number;

/** Pure: throws unless `value` is a positive safe integer. */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
