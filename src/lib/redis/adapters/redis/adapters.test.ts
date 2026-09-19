/**
 * Unit tests of the Redis adapters against a fake client: which commands go out
 * (every write with its TTL), how replies are read, and that every failure leaves
 * as `RedisUnavailableError`. What Redis then DOES with those commands is proven
 * by the contract suite in tests/redis/contract against a real server.
 */
import { describe, expect, it, vi } from "vitest";

import { createRedisAdapters } from ".";
import { RedisUnavailableError } from "../../errors";
import { createKeyBuilder, type RedisKey } from "../../keys";
import type { RedisClient } from "./connection";
import { RELEASE_SCRIPT } from "./lock";
import { SLIDING_WINDOW_SCRIPT } from "./rate-limiter";

const keys = createKeyBuilder("test");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setup() {
  const client = {
    status: "ready",
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(),
    on: vi.fn(),
    get: vi.fn<(key: string) => Promise<string | null>>(() => Promise.resolve(null)),
    set: vi.fn<(...args: (string | number)[]) => Promise<"OK" | null>>(() => Promise.resolve("OK")),
    del: vi.fn<(key: string) => Promise<number>>(() => Promise.resolve(1)),
    eval: vi.fn<(...args: (string | number)[]) => Promise<unknown>>(() => Promise.resolve(1)),
  };
  const adapters = createRedisAdapters({
    url: "redis://127.0.0.1:6379",
    keyPrefix: keys.prefix,
    createClient: () => client as unknown as RedisClient,
  });
  return { client, ...adapters };
}

describe("RedisCache", () => {
  it("maps a missing key to undefined and passes a value through", async () => {
    const { client, cache } = setup();
    const key = keys.scenario("slug");
    expect(await cache.get(key)).toBeUndefined();
    client.get.mockResolvedValue("");
    expect(await cache.get(key)).toBe("");
    client.get.mockResolvedValue("cached");
    expect(await cache.get(key)).toBe("cached");
    expect(client.get).toHaveBeenCalledWith(key);
  });

  it("never writes without EX", async () => {
    const { client, cache } = setup();
    await cache.set(keys.scenario("slug"), "value", 60);
    expect(client.set.mock.calls).toEqual([[keys.scenario("slug"), "value", "EX", 60]]);
  });

  it("reports whether DEL removed something", async () => {
    const { client, cache } = setup();
    expect(await cache.delete(keys.scenario("slug"))).toBe(true);
    client.del.mockResolvedValue(0);
    expect(await cache.delete(keys.scenario("slug"))).toBe(false);
  });
});

describe("RedisLock", () => {
  it("acquires with SET key token PX ttl NX and returns the token it sent", async () => {
    const { client, lock } = setup();
    const key = keys.explanationLock("hash");
    const lease = await lock.acquire(key, 30_000);

    const [sentKey, token, ...flags] = client.set.mock.calls[0] ?? [];
    expect(sentKey).toBe(key);
    expect(token).toMatch(UUID);
    expect(flags).toEqual(["PX", 30_000, "NX"]);
    expect(lease).toEqual({ key, token });
  });

  it("returns undefined when somebody else holds the lock", async () => {
    const { client, lock } = setup();
    client.set.mockResolvedValue(null);
    expect(await lock.acquire(keys.explanationLock("hash"), 30_000)).toBeUndefined();
  });

  it("releases by compare-and-delete with the token of the lease", async () => {
    const { client, lock } = setup();
    const lease = { key: keys.explanationLock("hash"), token: "the-token" };
    expect(await lock.release(lease)).toBe(true);
    expect(client.eval.mock.calls).toEqual([[RELEASE_SCRIPT, 1, lease.key, "the-token"]]);

    client.eval.mockResolvedValue(0);
    expect(await lock.release(lease)).toBe(false);
  });

  it("only deletes after comparing the token", () => {
    expect(RELEASE_SCRIPT).toMatch(/if redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\] then/);
    expect(RELEASE_SCRIPT.match(/redis\.call/g)).toHaveLength(2);
  });
});

describe("RedisRateLimiter", () => {
  const key = keys.rateLimit("explain", "ip", "203.0.113.7");

  it("runs the script with the key, the window, the limit and a unique member", async () => {
    const { client, rateLimiter } = setup();
    client.eval.mockResolvedValue([1, 2, 60_000]);
    await rateLimiter.check(key, { limit: 5, windowMs: 60_000 });
    await rateLimiter.check(key, { limit: 5, windowMs: 60_000 });

    const [script, numberOfKeys, sentKey, windowMs, limit, member] =
      client.eval.mock.calls[0] ?? [];
    expect([script, numberOfKeys, sentKey, windowMs, limit]).toEqual([
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      60_000,
      5,
    ]);
    expect(member).toMatch(UUID);
    expect(client.eval.mock.calls[1]?.[5]).not.toBe(member);
  });

  it("reads an allowed and a refused reply", async () => {
    const { client, rateLimiter } = setup();
    client.eval.mockResolvedValue([1, 2, 41_000]);
    expect(await rateLimiter.check(key, { limit: 5, windowMs: 60_000 })).toEqual({
      allowed: true,
      limit: 5,
      remaining: 3,
      resetMs: 41_000,
      retryAfterMs: 0,
    });

    client.eval.mockResolvedValue([0, 5, 1234]);
    expect(await rateLimiter.check(key, { limit: 5, windowMs: 60_000 })).toEqual({
      allowed: false,
      limit: 5,
      remaining: 0,
      resetMs: 1234,
      retryAfterMs: 1234,
    });
  });

  it("never reports a negative wait or a negative remainder", async () => {
    const { client, rateLimiter } = setup();
    client.eval.mockResolvedValue([0, 9, -3]);
    expect(await rateLimiter.check(key, { limit: 5, windowMs: 60_000 })).toMatchObject({
      remaining: 0,
      resetMs: 0,
      retryAfterMs: 0,
    });
  });

  it.each([[null], ["OK"], [[1, 2]], [[2, 0, 0]], [["1", "2", "3"]], [[1, -1, 0]], [[1, 1.5, 0]]])(
    "fails closed on the unexpected reply %j",
    async (reply) => {
      const { client, rateLimiter } = setup();
      client.eval.mockResolvedValue(reply);
      await expect(rateLimiter.check(key, { limit: 5, windowMs: 60_000 })).rejects.toMatchObject({
        name: "RedisUnavailableError",
        operation: "rateLimiter.check",
      });
    },
  );

  it("sets an expiry whenever the script adds to the log", () => {
    const add = SLIDING_WINDOW_SCRIPT.indexOf("redis.call('ZADD', key");
    const expire = SLIDING_WINDOW_SCRIPT.indexOf("redis.call('PEXPIRE', key, window)");
    expect(add).toBeGreaterThan(-1);
    expect(expire).toBeGreaterThan(add);
    // Both sit in the same `if count < limit` block: no path adds without expiring.
    expect(SLIDING_WINDOW_SCRIPT.slice(add, expire)).not.toMatch(/\bend\b|\belse\b/);
    expect(SLIDING_WINDOW_SCRIPT).toContain("redis.call('TIME')");
  });
});

describe("every Redis adapter", () => {
  it("turns a failure of the client into RedisUnavailableError", async () => {
    const { client, cache, lock, rateLimiter } = setup();
    const down = new Error("Connection is closed.");
    client.get.mockRejectedValue(down);
    client.set.mockRejectedValue(down);
    client.del.mockRejectedValue(down);
    client.eval.mockRejectedValue(down);
    const key = keys.scenario("slug");

    const attempts: [string, Promise<unknown>][] = [
      ["cache.get", cache.get(key)],
      ["cache.set", cache.set(key, "v", 60)],
      ["cache.delete", cache.delete(key)],
      ["lock.acquire", lock.acquire(key, 1000)],
      ["lock.release", lock.release({ key, token: "t" })],
      ["rateLimiter.check", rateLimiter.check(key, { limit: 1, windowMs: 1000 })],
    ];
    for (const [operation, attempt] of attempts) {
      const error: unknown = await attempt.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RedisUnavailableError);
      expect(error).toMatchObject({ operation, cause: down });
    }
  });

  it("validates before it sends anything", async () => {
    const { client, cache, lock, rateLimiter } = setup();
    const foreign = "rlsleak:production:scenario:slug" as RedisKey;
    const key = keys.scenario("slug");

    const refused = [
      cache.get(foreign),
      cache.set(foreign, "v", 60),
      cache.set(key, "v", 0),
      cache.delete(foreign),
      lock.acquire(foreign, 1000),
      lock.acquire(key, 0),
      lock.release({ key: foreign, token: "t" }),
      rateLimiter.check(foreign, { limit: 1, windowMs: 1000 }),
      rateLimiter.check(key, { limit: 0, windowMs: 1000 }),
      rateLimiter.check(key, { limit: 1, windowMs: 0.5 }),
    ];
    for (const attempt of refused) await expect(attempt).rejects.toBeInstanceOf(RangeError);

    for (const command of [client.get, client.set, client.del, client.eval]) {
      expect(command).not.toHaveBeenCalled();
    }
  });

  it("close() disconnects the shared client", async () => {
    const { client, cache, close } = setup();
    await cache.get(keys.scenario("slug"));
    close();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});
