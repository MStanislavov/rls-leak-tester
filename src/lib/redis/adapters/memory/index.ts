/**
 * The in-memory adapters, used when `REDIS_URL` is unset: local development and
 * hermetic tests. They live in one process, so they limit and deduplicate per
 * process only; production uses Redis.
 */
import type { Cache, Clock, Lock, RateLimiter } from "../../ports";
import { MemoryCache } from "./cache";
import { MemoryLock } from "./lock";
import { MemoryRateLimiter } from "./rate-limiter";
import { TtlMap } from "./ttl-map";

export interface MemoryAdapterOptions {
  /** The prefix of the key builder; keys outside it are refused. */
  readonly keyPrefix: string;
  /** Defaults to `Date.now`. */
  readonly clock?: Clock;
  /** Bound of each of the three maps. */
  readonly maxEntries?: number;
}

export interface MemoryAdapters {
  readonly rateLimiter: RateLimiter;
  readonly cache: Cache;
  readonly lock: Lock;
  /** Milliseconds a key has left, `undefined` when it does not exist. For the contract suite. */
  ttlMs(key: string): number | undefined;
  /** Every live key of the three adapters. For the contract suite. */
  keys(): string[];
}

export function createMemoryAdapters(options: MemoryAdapterOptions): MemoryAdapters {
  const clock = options.clock ?? Date.now;
  const hits = new TtlMap<readonly number[]>(clock, options.maxEntries);
  const entries = new TtlMap<string>(clock, options.maxEntries);
  const holders = new TtlMap<string>(clock, options.maxEntries);
  return {
    rateLimiter: new MemoryRateLimiter(hits, clock, options.keyPrefix),
    cache: new MemoryCache(entries, options.keyPrefix),
    lock: new MemoryLock(holders, options.keyPrefix),
    ttlMs: (key) => hits.ttlMs(key) ?? entries.ttlMs(key) ?? holders.ttlMs(key),
    keys: () => [...hits.keys(), ...entries.keys(), ...holders.keys()],
  };
}
