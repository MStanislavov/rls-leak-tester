/**
 * Picks the adapters from configuration: Redis when a URL is configured, the
 * in-memory adapters otherwise (P4: zero-config local lab).
 *
 * This module does not read the environment (ARCH-002). Server code passes the
 * parsed configuration in: `getRedisServices(getServerConfig())`.
 *
 * Whether a missing Redis is acceptable is the caller's policy, not the factory's:
 * `src/lib/config` already refuses to enable `/api/explain` in production without
 * `REDIS_URL`, and a Redis that is configured but unreachable surfaces as
 * `RedisUnavailableError` from every port call, which `/api/explain` answers with
 * `503` (fail closed). The factory never falls back to memory on its own.
 */
import { createMemoryAdapters } from "./adapters/memory";
import { createRedisAdapters } from "./adapters/redis";
import { createKeyBuilder, type KeyBuilder } from "./keys";
import type { Cache, Lock, RateLimiter } from "./ports";

/** The slice of `ServerConfig` this layer needs; a `ServerConfig` can be passed as is. */
export interface RedisLayerConfig {
  /** The `{env}` segment of every key. */
  readonly envName: string;
  /** `redis://` or `rediss://`; `undefined` selects the in-memory adapters. */
  readonly redisUrl: string | undefined;
}

export interface RedisServices {
  /** Which adapters are in use. `memory` limits and deduplicates per process only. */
  readonly backend: "redis" | "memory";
  readonly keys: KeyBuilder;
  readonly rateLimiter: RateLimiter;
  readonly cache: Cache;
  readonly lock: Lock;
  /** Drops the Redis connection, if any. The services stay usable and reconnect on demand. */
  close(): void;
}

/** Builds a fresh set of services. Most callers want `getRedisServices`. */
export function createRedisServices(config: RedisLayerConfig): RedisServices {
  const keys = createKeyBuilder(config.envName);
  if (config.redisUrl === undefined) {
    const memory = createMemoryAdapters({ keyPrefix: keys.prefix });
    return {
      backend: "memory",
      keys,
      rateLimiter: memory.rateLimiter,
      cache: memory.cache,
      lock: memory.lock,
      close: () => undefined,
    };
  }
  const redis = createRedisAdapters({ url: config.redisUrl, keyPrefix: keys.prefix });
  return {
    backend: "redis",
    keys,
    rateLimiter: redis.rateLimiter,
    cache: redis.cache,
    lock: redis.lock,
    close: redis.close,
  };
}

interface Slot {
  readonly signature: string;
  readonly services: RedisServices;
}

/**
 * The slot lives on `globalThis`, not in a module variable: `next dev` re-evaluates
 * modules on every edit, and a module variable would leak one connection (and reset
 * the in-memory limiter) each time.
 */
const SLOT = Symbol.for("rls-leak-tester.redis-services");

type SlotHolder = typeof globalThis & { [SLOT]?: Slot };

/**
 * The services of this process: one client, one in-memory limiter. The same
 * configuration returns the same instance; a different one (tests) replaces it.
 */
export function getRedisServices(config: RedisLayerConfig): RedisServices {
  const holder: SlotHolder = globalThis;
  const signature = JSON.stringify([config.envName, config.redisUrl ?? null]);
  const current = holder[SLOT];
  if (current?.signature === signature) return current.services;
  current?.services.close();
  const services = createRedisServices(config);
  holder[SLOT] = { signature, services };
  return services;
}

/** Closes and forgets the services of this process. For tests and shutdown. */
export function resetRedisServices(): void {
  const holder: SlotHolder = globalThis;
  holder[SLOT]?.services.close();
  holder[SLOT] = undefined;
}
