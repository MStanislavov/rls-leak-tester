import { describe, expect, it, vi } from "vitest";

import { RedisUnavailableError } from "./errors";
import { readThrough } from "./read-through";

describe("readThrough", () => {
  it("answers a hit from the cache without loading", async () => {
    const load = vi.fn(() => Promise.resolve("loaded"));
    const store = vi.fn(() => Promise.resolve());
    expect(await readThrough({ read: () => Promise.resolve("cached"), load, store })).toBe(
      "cached",
    );
    expect(load).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("loads on a miss and fills the cache", async () => {
    const store = vi.fn(() => Promise.resolve());
    const value = await readThrough({
      read: () => Promise.resolve(undefined),
      load: () => Promise.resolve("loaded"),
      store,
    });
    expect(value).toBe("loaded");
    expect(store).toHaveBeenCalledExactlyOnceWith("loaded");
  });

  it("does not cache a value that does not exist", async () => {
    const store = vi.fn(() => Promise.resolve());
    const value = await readThrough<string>({
      read: () => Promise.resolve(undefined),
      load: () => Promise.resolve(undefined),
      store,
    });
    expect(value).toBeUndefined();
    expect(store).not.toHaveBeenCalled();
  });

  it("fails open: a cache that is down costs a load, not the request", async () => {
    const onUnavailable = vi.fn();
    const value = await readThrough({
      read: () => Promise.reject(new RedisUnavailableError("cache.get")),
      load: () => Promise.resolve("loaded"),
      store: () => Promise.reject(new RedisUnavailableError("cache.set")),
      onUnavailable,
    });
    expect(value).toBe("loaded");
    expect(
      onUnavailable.mock.calls.map(([error]) => (error as RedisUnavailableError).operation),
    ).toEqual(["cache.get", "cache.set"]);

    // The hook is optional.
    expect(
      await readThrough({
        read: () => Promise.reject(new RedisUnavailableError("cache.get")),
        load: () => Promise.resolve("loaded"),
        store: () => Promise.resolve(),
      }),
    ).toBe("loaded");
  });

  it("does not swallow other errors", async () => {
    await expect(
      readThrough({
        read: () => Promise.reject(new TypeError("a bug")),
        load: () => Promise.resolve("loaded"),
        store: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      readThrough({
        read: () => Promise.resolve(undefined),
        load: () => Promise.reject(new Error("store down")),
        store: () => Promise.resolve(),
      }),
    ).rejects.toThrow("store down");
  });
});
