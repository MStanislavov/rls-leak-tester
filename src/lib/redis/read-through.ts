/**
 * Read-through caching for shared scenarios by slug: a hit answers from the
 * cache, a miss loads from the store and fills the cache. The writer of a
 * scenario invalidates its entry with `cache.delete(keys.scenario(slug))`.
 *
 * Unlike the limiter, this cache is an optimisation, so it fails OPEN: when Redis
 * is unavailable the value comes from `load` and the request succeeds. Like
 * `single-flight.ts` it takes closures over the `Cache` port, so the caller owns
 * serialisation, validation and the TTL (`SCENARIO_CACHE_TTL_SECONDS`).
 */
import { isRedisUnavailable, type RedisUnavailableError } from "./errors";

export interface ReadThroughOptions<T> {
  /** Reads the cached value, `undefined` on a miss. */
  readonly read: () => Promise<T | undefined>;
  /** The source of truth. `undefined` (not found) is not cached. */
  readonly load: () => Promise<T | undefined>;
  /** Fills the cache after a miss. */
  readonly store: (value: T) => Promise<void>;
  /** Told about a cache that is down, for a log line. The request goes on. */
  readonly onUnavailable?: (error: RedisUnavailableError) => void;
}

export async function readThrough<T>(options: ReadThroughOptions<T>): Promise<T | undefined> {
  const tolerate = async <R>(step: () => Promise<R>): Promise<R | undefined> => {
    try {
      return await step();
    } catch (error) {
      if (!isRedisUnavailable(error)) throw error;
      options.onUnavailable?.(error);
      return undefined;
    }
  };

  const cached = await tolerate(options.read);
  if (cached !== undefined) return cached;
  const loaded = await options.load();
  if (loaded !== undefined) await tolerate(() => options.store(loaded));
  return loaded;
}
