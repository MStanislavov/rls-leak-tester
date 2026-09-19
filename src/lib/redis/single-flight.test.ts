import { describe, expect, it, vi } from "vitest";

import { createMemoryAdapters } from "./adapters/memory";
import { RedisUnavailableError } from "./errors";
import { createKeyBuilder } from "./keys";
import type { Lock } from "./ports";
import { singleFlight, waitForValue } from "./single-flight";

const keys = createKeyBuilder("test");

/** A clock that only moves when the code under test sleeps. */
function fakeTime() {
  let now = 0;
  return {
    clock: () => now,
    sleep: vi.fn((ms: number) => {
      now += ms;
      return Promise.resolve();
    }),
  };
}

describe("waitForValue", () => {
  it("returns a value that is already there without sleeping", async () => {
    const time = fakeTime();
    const value = await waitForValue(() => Promise.resolve("ready"), {
      timeoutMs: 100,
      intervalMs: 10,
      ...time,
    });
    expect(value).toBe("ready");
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it("polls until the value appears", async () => {
    const time = fakeTime();
    const read = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue("late");
    expect(await waitForValue(read, { timeoutMs: 100, intervalMs: 10, ...time })).toBe("late");
    expect(read).toHaveBeenCalledTimes(3);
    expect(time.sleep).toHaveBeenNthCalledWith(1, 10);
  });

  it("gives up after the timeout, and reads once even with a timeout of zero", async () => {
    const time = fakeTime();
    const read = vi.fn(() => Promise.resolve(undefined));
    expect(await waitForValue(read, { timeoutMs: 30, intervalMs: 10, ...time })).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(4);

    const once = vi.fn(() => Promise.resolve(undefined));
    expect(await waitForValue(once, { timeoutMs: 0, intervalMs: 10, ...time })).toBeUndefined();
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("sleeps for real by default", async () => {
    const read = vi
      .fn<() => Promise<number | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(0);
    expect(await waitForValue(read, { timeoutMs: 1000, intervalMs: 1 })).toBe(0);
  });
});

describe("singleFlight", () => {
  const lockKey = keys.explanationLock("hash");

  function setup() {
    const memory = createMemoryAdapters({ keyPrefix: keys.prefix });
    let stored: string | undefined;
    return {
      lock: memory.lock,
      read: vi.fn(() => Promise.resolve(stored)),
      store: vi.fn((value: string) => {
        stored = value;
        return Promise.resolve();
      }),
      preset: (value: string) => {
        stored = value;
      },
    };
  }

  it("answers from the cache without touching the lock", async () => {
    const { read, store, preset } = setup();
    preset("cached");
    const lock: Lock = { acquire: vi.fn(), release: vi.fn() };
    const produce = vi.fn(() => Promise.resolve("fresh"));

    const result = await singleFlight({
      lock,
      lockKey,
      lockTtlMs: 1000,
      read,
      produce,
      store,
      wait: { timeoutMs: 100, intervalMs: 10 },
    });

    expect(result).toEqual({ source: "cache", value: "cached" });
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(produce).not.toHaveBeenCalled();
  });

  it("produces, stores and releases on a miss", async () => {
    const { lock, read, store } = setup();
    const result = await singleFlight({
      lock,
      lockKey,
      lockTtlMs: 1000,
      read,
      produce: () => Promise.resolve("fresh"),
      store,
      wait: { timeoutMs: 100, intervalMs: 10 },
    });

    expect(result).toEqual({ source: "produced", value: "fresh" });
    expect(store).toHaveBeenCalledExactlyOnceWith("fresh");
    expect(await lock.acquire(lockKey, 1000), "released").toBeDefined();
  });

  it("uses a result a peer stored between the first read and the acquire", async () => {
    const { lock, store } = setup();
    const read = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue("from a peer");
    const produce = vi.fn(() => Promise.resolve("fresh"));

    const result = await singleFlight({
      lock,
      lockKey,
      lockTtlMs: 1000,
      read,
      produce,
      store,
      wait: { timeoutMs: 100, intervalMs: 10 },
    });

    expect(result).toEqual({ source: "waited", value: "from a peer" });
    expect(produce).not.toHaveBeenCalled();
    expect(await lock.acquire(lockKey, 1000), "released").toBeDefined();
  });

  it("releases the lock and rethrows when the producer fails", async () => {
    const { lock, read, store } = setup();
    await expect(
      singleFlight({
        lock,
        lockKey,
        lockTtlMs: 1000,
        read,
        produce: () => Promise.reject(new Error("model down")),
        store,
        wait: { timeoutMs: 100, intervalMs: 10 },
      }),
    ).rejects.toThrow("model down");
    expect(store).not.toHaveBeenCalled();
    expect(await lock.acquire(lockKey, 1000), "released").toBeDefined();
  });

  it("keeps the produced value when the release fails: the lock expires on its own", async () => {
    const { read, store } = setup();
    const lock: Lock = {
      acquire: (key) => Promise.resolve({ key, token: "t" }),
      release: () => Promise.reject(new RedisUnavailableError("lock.release")),
    };
    const result = await singleFlight({
      lock,
      lockKey,
      lockTtlMs: 1000,
      read,
      produce: () => Promise.resolve("fresh"),
      store,
      wait: { timeoutMs: 100, intervalMs: 10 },
    });
    expect(result).toEqual({ source: "produced", value: "fresh" });
  });

  it("waits for the holder and reports a timeout when nothing arrives", async () => {
    const { lock, read, store } = setup();
    const time = fakeTime();
    expect(await lock.acquire(lockKey, 60_000)).toBeDefined();
    const produce = vi.fn(() => Promise.resolve("fresh"));

    const result = await singleFlight({
      lock,
      lockKey,
      lockTtlMs: 1000,
      read,
      produce,
      store,
      wait: { timeoutMs: 50, intervalMs: 10, ...time },
    });

    expect(result).toEqual({ source: "timeout" });
    expect(produce).not.toHaveBeenCalled();
    expect(time.sleep).toHaveBeenCalledTimes(5);
  });

  it("fails with RedisUnavailableError when the lock cannot be reached", async () => {
    const { read, store } = setup();
    const lock: Lock = {
      acquire: () => Promise.reject(new RedisUnavailableError("lock.acquire")),
      release: vi.fn(),
    };
    await expect(
      singleFlight({
        lock,
        lockKey,
        lockTtlMs: 1000,
        read,
        produce: () => Promise.resolve("fresh"),
        store,
        wait: { timeoutMs: 50, intervalMs: 10 },
      }),
    ).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});
