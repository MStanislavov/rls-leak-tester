/**
 * Single-flight on top of the `Lock` port: concurrent identical requests produce
 * one result; the others wait briefly and read what the producer stored.
 *
 * The helpers are storage-agnostic on purpose. The caller hands in `read` and
 * `store` closures over the `Cache` port (and owns serialisation, validation and
 * the TTL), so this file holds no write command: rules.yaml REDIS-001 keeps those
 * in the adapters.
 */
import type { RedisKey } from "./keys";
import type { Clock, Lock } from "./ports";

export interface WaitOptions {
  /** How long a follower waits for the producer before it gives up. */
  readonly timeoutMs: number;
  /** Pause between two polls. */
  readonly intervalMs: number;
  /** Defaults to a `setTimeout` sleep. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Defaults to `Date.now`. */
  readonly clock?: Clock | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polls `read` until it returns a value or the time is up. `read` is called at
 * least once, also with a timeout of zero.
 */
export async function waitForValue<T>(
  read: () => Promise<T | undefined>,
  options: WaitOptions,
): Promise<T | undefined> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = clock() + options.timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (clock() >= deadline) return undefined;
    await sleep(options.intervalMs);
  }
}

export interface SingleFlightOptions<T> {
  readonly lock: Lock;
  readonly lockKey: RedisKey;
  /** Upper bound of one production; a crashed producer blocks nobody for longer. */
  readonly lockTtlMs: number;
  /** Reads the shared result, `undefined` on a miss. */
  readonly read: () => Promise<T | undefined>;
  /** The expensive call. Runs in at most one caller at a time. */
  readonly produce: () => Promise<T>;
  /** Stores the result where `read` finds it. */
  readonly store: (value: T) => Promise<void>;
  readonly wait: WaitOptions;
}

export type SingleFlightResult<T> =
  /** `cache`: found at once. `produced`: this caller ran `produce`. `waited`: a peer did. */
  | { readonly source: "cache" | "produced" | "waited"; readonly value: T }
  /** No result within `wait.timeoutMs`. The caller decides: answer 503, or retry. */
  | { readonly source: "timeout" };

/**
 * Read, else try to become the producer, else wait and try again. A follower also
 * retries the lock on every poll, so when the producer fails (its `produce` threw
 * and the lock was released, or its lease expired) the next follower takes over
 * instead of waiting out the timeout. An error of `produce` or `store` reaches the
 * caller that ran it.
 */
export async function singleFlight<T>(
  options: SingleFlightOptions<T>,
): Promise<SingleFlightResult<T>> {
  const { lock, lockKey, lockTtlMs, read, produce, store, wait } = options;
  const clock = wait.clock ?? Date.now;
  const sleep = wait.sleep ?? defaultSleep;
  const deadline = clock() + wait.timeoutMs;

  for (let attempt = 0; ; attempt += 1) {
    const hit = await read();
    if (hit !== undefined) return { source: attempt === 0 ? "cache" : "waited", value: hit };

    const lease = await lock.acquire(lockKey, lockTtlMs);
    if (lease !== undefined) {
      try {
        // A peer may have stored its result between our read and our acquire.
        const late = await read();
        if (late !== undefined) return { source: "waited", value: late };
        const value = await produce();
        await store(value);
        return { source: "produced", value };
      } finally {
        // The lock has a TTL, so a failed release must not cost the caller its result.
        await lock.release(lease).catch(() => false);
      }
    }

    if (clock() >= deadline) return { source: "timeout" };
    await sleep(wait.intervalMs);
  }
}
