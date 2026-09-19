/**
 * What the contract suite needs from an adapter set, so that one suite can run
 * against the in-memory adapters (always) and against a real Redis (when the run
 * provides REDIS_URL).
 */
import { randomUUID } from "node:crypto";

import Redis from "ioredis";

import { createMemoryAdapters } from "@/lib/redis/adapters/memory";
import { createRedisAdapters } from "@/lib/redis/adapters/redis";
import { createKeyBuilder, type KeyBuilder } from "@/lib/redis/keys";
import type { Cache, Lock, RateLimiter } from "@/lib/redis/ports";

export interface Peer {
  readonly rateLimiter: RateLimiter;
  readonly cache: Cache;
  readonly lock: Lock;
}

export interface ContractHarness {
  readonly keys: KeyBuilder;
  /**
   * Adapter sets that share one keyspace. On real Redis each one has its own
   * connection, so a concurrency test really races several clients.
   */
  readonly peers: readonly [Peer, ...Peer[]];
  /** Lets `ms` milliseconds pass: a fake clock in memory, a real sleep on Redis. */
  advance(ms: number): Promise<void>;
  /** Milliseconds left; `undefined` for a missing key; `-1` for a key WITHOUT a TTL. */
  ttlMs(key: string): Promise<number | undefined>;
  /** Every live key under the prefix of `keys`. */
  liveKeys(): Promise<string[]>;
  /** Removes the keys of this harness, and only those, and closes its connections. */
  dispose(): Promise<void>;
}

export type HarnessFactory = () => Promise<ContractHarness>;

/** A key environment no other run shares: `test-` plus twelve hex characters. */
function uniqueEnv(): string {
  return `test-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export const createMemoryHarness: HarnessFactory = () => {
  const keys = createKeyBuilder(uniqueEnv());
  let now = 1_750_000_000_000;
  const memory = createMemoryAdapters({ keyPrefix: keys.prefix, clock: () => now });
  return Promise.resolve({
    keys,
    peers: [memory, memory, memory],
    advance: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    ttlMs: (key) => Promise.resolve(memory.ttlMs(key)),
    liveKeys: () => Promise.resolve(memory.keys()),
    dispose: () => Promise.resolve(),
  });
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function scanKeys(inspector: Redis, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await inspector.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
    found.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  return found;
}

export function createRedisHarness(url: string): HarnessFactory {
  return async () => {
    const keys = createKeyBuilder(uniqueEnv());
    const adapters = [0, 1, 2].map(() => createRedisAdapters({ url, keyPrefix: keys.prefix }));
    const [first, ...rest] = adapters;
    if (first === undefined) throw new Error("unreachable: three adapter sets were built");
    // The suite drives its own raw client to look at keys and TTLs (REDIS-001 exclusion for tests).
    const inspector = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0 });
    await inspector.connect();
    return {
      keys,
      peers: [first, ...rest],
      // A little more than asked, so that "expired after ms" holds despite timer jitter.
      advance: (ms) => sleep(ms + 25),
      ttlMs: async (key) => {
        const ttl = await inspector.pttl(key);
        return ttl === -2 ? undefined : ttl;
      },
      liveKeys: () => scanKeys(inspector, keys.prefix),
      dispose: async () => {
        const leftovers = await scanKeys(inspector, keys.prefix);
        if (leftovers.length > 0) await inspector.del(...leftovers);
        for (const adapter of adapters) adapter.close();
        inspector.disconnect();
      },
    };
  };
}
