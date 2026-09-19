import { describe, expect, it } from "vitest";

import { createMemoryAdapters } from ".";
import { createKeyBuilder } from "../../keys";
import { TtlMap } from "./ttl-map";

function clockAt(start: number) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("TtlMap", () => {
  it("expires entries lazily and reports the time they have left", () => {
    const time = clockAt(1000);
    const map = new TtlMap<string>(time.clock);
    map.put("a", "1", 100);
    expect(map.get("a")).toBe("1");
    expect(map.ttlMs("a")).toBe(100);
    expect(map.ttlMs("missing")).toBeUndefined();

    time.advance(99);
    expect(map.ttlMs("a")).toBe(1);
    expect(map.keys()).toEqual(["a"]);

    time.advance(1);
    expect(map.ttlMs("a")).toBeUndefined();
    expect(map.keys()).toEqual([]);
    expect(map.size).toBe(1);
    expect(map.get("a")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("removes only what is alive", () => {
    const time = clockAt(0);
    const map = new TtlMap<string>(time.clock);
    map.put("a", "1", 10);
    expect(map.remove("a")).toBe(true);
    expect(map.remove("a")).toBe(false);
    map.put("b", "2", 10);
    time.advance(10);
    expect(map.remove("b")).toBe(false);
  });

  it("stays within its bound: expired entries go first, then the oldest", () => {
    const time = clockAt(0);
    const map = new TtlMap<number>(time.clock, 3);
    map.put("short", 0, 5);
    map.put("b", 1, 1000);
    map.put("c", 2, 1000);
    time.advance(5);

    map.put("d", 3, 1000);
    expect(map.keys()).toEqual(["b", "c", "d"]);

    // Rewriting b makes it the youngest, so c is the oldest now.
    map.put("b", 10, 1000);
    map.put("e", 4, 1000);
    expect(map.keys()).toEqual(["d", "b", "e"]);
    expect(map.get("b")).toBe(10);
    expect(map.size).toBe(3);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses the TTL %s", (ttlMs) => {
    const map = new TtlMap<string>(() => 0);
    expect(() => {
      map.put("a", "1", ttlMs);
    }).toThrow(RangeError);
    expect(map.size).toBe(0);
  });

  it("refuses a bound that is not a positive integer", () => {
    expect(() => new TtlMap<string>(() => 0, 0)).toThrow(RangeError);
  });
});

describe("createMemoryAdapters", () => {
  it("uses the wall clock by default and lists the keys of all three adapters", async () => {
    const keys = createKeyBuilder("test");
    const memory = createMemoryAdapters({ keyPrefix: keys.prefix });
    await memory.cache.set(keys.scenario("s"), "v", 60);
    await memory.lock.acquire(keys.explanationLock("h"), 1000);
    await memory.rateLimiter.check(keys.rateLimit("explain", "ip", "x"), {
      limit: 1,
      windowMs: 1000,
    });

    expect(memory.keys().toSorted()).toEqual(
      [
        keys.scenario("s"),
        keys.explanationLock("h"),
        keys.rateLimit("explain", "ip", "x"),
      ].toSorted(),
    );
    for (const key of memory.keys()) expect(memory.ttlMs(key)).toBeGreaterThan(0);
    expect(memory.ttlMs(keys.scenario("missing"))).toBeUndefined();
  });
});
