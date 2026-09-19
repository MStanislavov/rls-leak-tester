/** The Redis adapters of the three ports, sharing one lazily connected client. */
import type { Cache, Lock, RateLimiter } from "../../ports";
import { RedisCache } from "./cache";
import { RedisConnection, type RedisConnectionOptions } from "./connection";
import { RedisLock } from "./lock";
import { RedisRateLimiter } from "./rate-limiter";

export interface RedisAdapterOptions extends RedisConnectionOptions {
  /** The prefix of the key builder; keys outside it are refused. */
  readonly keyPrefix: string;
}

export interface RedisAdapters {
  readonly rateLimiter: RateLimiter;
  readonly cache: Cache;
  readonly lock: Lock;
  /** Drops the connection; the next command opens a new one. */
  close(): void;
}

export function createRedisAdapters(options: RedisAdapterOptions): RedisAdapters {
  const connection = new RedisConnection(options);
  return {
    rateLimiter: new RedisRateLimiter(connection, options.keyPrefix),
    cache: new RedisCache(connection, options.keyPrefix),
    lock: new RedisLock(connection, options.keyPrefix),
    close: () => {
      connection.close();
    },
  };
}
