/**
 * THE contract of the Redis layer (rules.yaml REDIS-001, brief 4.5 and 5.1). The
 * same assertions run against the in-memory adapters and against a real Redis;
 * an adapter that passes here may stand in for the other.
 *
 * After EVERY test the suite looks at every key the test left behind: it must
 * have the shape of the key builder, sit under this run's own prefix, and have a
 * TTL. A write without expiry fails the test that made it.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RedisKey } from "@/lib/redis/keys";
import { createKeyBuilder } from "@/lib/redis/keys";
import { EXPLANATION_CACHE_TTL_SECONDS, SINGLE_FLIGHT_LOCK_TTL_MS } from "@/lib/redis/policy";
import { singleFlight, type SingleFlightResult } from "@/lib/redis/single-flight";

import type { ContractHarness, HarnessFactory, Peer } from "./harness";

const KEY_SHAPE = /^rlsleak:test-[0-9a-f]{12}:(ratelimit|explain|lock|scenario):[A-Za-z0-9_.-]+$/;

const unique = (label: string): string => `${label}-${randomUUID()}`;

export function describeRedisContract(adapterName: string, createHarness: HarnessFactory): void {
  describe(`Redis layer contract: ${adapterName}`, () => {
    let harness: ContractHarness;

    const peer = (index = 0): Peer => {
      const { peers } = harness;
      return peers[index % peers.length] ?? peers[0];
    };

    beforeAll(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      for (const key of await harness.liveKeys()) {
        expect(key, "key shape").toMatch(KEY_SHAPE);
        expect(harness.keys.owns(key), `${key} is under this run's prefix`).toBe(true);
        expect(await harness.ttlMs(key), `TTL of ${key}`).toBeGreaterThan(0);
      }
    });

    afterAll(async () => {
      await harness.dispose();
    });

    describe("keys and TTLs", () => {
      it("gives every key written through any port the builder's shape and a TTL", async () => {
        const limiterKey = harness.keys.rateLimit("explain", "ip", "203.0.113.7");
        const cacheKey = harness.keys.explanation(unique("hash"));
        const lockKey = harness.keys.explanationLock(unique("hash"));
        const before = new Set(await harness.liveKeys());

        await peer().rateLimiter.check(limiterKey, { limit: 5, windowMs: 60_000 });
        await peer().cache.set(cacheKey, "value", EXPLANATION_CACHE_TTL_SECONDS);
        await peer().lock.acquire(lockKey, SINGLE_FLIGHT_LOCK_TTL_MS);

        const written = (await harness.liveKeys()).filter((key) => !before.has(key));
        expect(written.toSorted()).toEqual([limiterKey, cacheKey, lockKey].toSorted());

        const limiterTtl = await harness.ttlMs(limiterKey);
        expect(limiterTtl).toBeGreaterThan(0);
        expect(limiterTtl).toBeLessThanOrEqual(60_000);
        const cacheTtl = await harness.ttlMs(cacheKey);
        expect(cacheTtl).toBeGreaterThan((EXPLANATION_CACHE_TTL_SECONDS - 60) * 1000);
        expect(cacheTtl).toBeLessThanOrEqual(EXPLANATION_CACHE_TTL_SECONDS * 1000);
        const lockTtl = await harness.ttlMs(lockKey);
        expect(lockTtl).toBeGreaterThan(0);
        expect(lockTtl).toBeLessThanOrEqual(SINGLE_FLIGHT_LOCK_TTL_MS);
      });

      it("never stores a rate-limit subject in the clear", async () => {
        const address = "198.51.100.23";
        await peer().rateLimiter.check(harness.keys.rateLimit("explain", "ip", address), {
          limit: 5,
          windowMs: 60_000,
        });
        for (const key of await harness.liveKeys()) expect(key).not.toContain(address);
      });

      it("refuses a key that did not come from this environment's builder", async () => {
        const foreign = createKeyBuilder("test-000000000000").scenario("slug");
        const handMade = "not-a-built-key" as RedisKey;
        for (const key of [foreign, handMade]) {
          await expect(peer().cache.get(key)).rejects.toBeInstanceOf(RangeError);
          await expect(peer().cache.set(key, "v", 60)).rejects.toBeInstanceOf(RangeError);
          await expect(peer().cache.delete(key)).rejects.toBeInstanceOf(RangeError);
          await expect(peer().lock.acquire(key, 1000)).rejects.toBeInstanceOf(RangeError);
          await expect(peer().lock.release({ key, token: "t" })).rejects.toBeInstanceOf(RangeError);
          await expect(
            peer().rateLimiter.check(key, { limit: 1, windowMs: 1000 }),
          ).rejects.toBeInstanceOf(RangeError);
        }
      });
    });

    describe("RateLimiter (sliding window)", () => {
      const rule = { limit: 3, windowMs: 60_000 };

      it("allows exactly `limit` requests, counts down `remaining`, then refuses", async () => {
        const key = harness.keys.rateLimit("explain", "ip", unique("subject"));
        const results = [];
        for (let call = 0; call < 5; call += 1) {
          results.push(await peer(call).rateLimiter.check(key, rule));
        }

        expect(results.map((result) => result.allowed)).toEqual([true, true, true, false, false]);
        expect(results.map((result) => result.remaining)).toEqual([2, 1, 0, 0, 0]);
        for (const result of results) {
          expect(result.limit).toBe(3);
          expect(result.resetMs).toBeGreaterThan(0);
          expect(result.resetMs).toBeLessThanOrEqual(rule.windowMs);
          expect(result.retryAfterMs).toBe(result.allowed ? 0 : result.resetMs);
        }
      });

      it("keeps the budgets of different subjects and scopes apart", async () => {
        const subject = unique("subject");
        const one = { limit: 1, windowMs: 60_000 };
        const keys = [
          harness.keys.rateLimit("explain", "ip", subject),
          harness.keys.rateLimit("explain", "user", subject),
          harness.keys.rateLimit("scenario-writes", "ip", subject),
          harness.keys.rateLimit("explain", "ip", unique("other")),
        ];
        expect(new Set(keys).size).toBe(4);
        for (const key of keys)
          expect((await peer().rateLimiter.check(key, one)).allowed).toBe(true);
        for (const key of keys) {
          expect((await peer().rateLimiter.check(key, one)).allowed).toBe(false);
        }
      });

      it("is atomic: of many parallel requests exactly `limit` are allowed", async () => {
        const key = harness.keys.rateLimit("explain", "ip", unique("subject"));
        const parallel = { limit: 7, windowMs: 60_000 };
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, call) => peer(call).rateLimiter.check(key, parallel)),
        );

        const allowed = results.filter((result) => result.allowed);
        expect(allowed).toHaveLength(7);
        expect(allowed.map((result) => result.remaining).toSorted((a, b) => a - b)).toEqual([
          0, 1, 2, 3, 4, 5, 6,
        ]);
        const refused = results.filter((result) => !result.allowed);
        expect(refused).toHaveLength(43);
        for (const result of refused) {
          expect(result.remaining).toBe(0);
          expect(result.retryAfterMs).toBeGreaterThan(0);
        }
      });

      it("slides: a slot frees up when the oldest request leaves the window, not at a boundary", async () => {
        const key = harness.keys.rateLimit("scenario-writes", "user", unique("subject"));
        const sliding = { limit: 2, windowMs: 1000 };

        expect((await peer().rateLimiter.check(key, sliding)).allowed).toBe(true);
        await harness.advance(500);
        expect((await peer().rateLimiter.check(key, sliding)).allowed).toBe(true);
        const refused = await peer().rateLimiter.check(key, sliding);
        expect(refused.allowed).toBe(false);
        expect(refused.retryAfterMs).toBeLessThanOrEqual(500);

        // 1100 ms after the first request and 600 ms after the second: one slot is free.
        await harness.advance(600);
        const next = await peer().rateLimiter.check(key, sliding);
        expect(next.allowed).toBe(true);
        expect(next.remaining).toBe(0);
        expect((await peer().rateLimiter.check(key, sliding)).allowed).toBe(false);
      });

      it("does not count refused requests, and forgets the key after the window", async () => {
        const key = harness.keys.rateLimit("explain", "user", unique("subject"));
        const short = { limit: 1, windowMs: 300 };

        expect((await peer().rateLimiter.check(key, short)).allowed).toBe(true);
        for (let call = 0; call < 5; call += 1) {
          expect((await peer().rateLimiter.check(key, short)).allowed).toBe(false);
        }
        const ttl = await harness.ttlMs(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(300);

        await harness.advance(300);
        expect(await harness.ttlMs(key)).toBeUndefined();
        expect(await peer().rateLimiter.check(key, short)).toMatchObject({
          allowed: true,
          remaining: 0,
        });
      });

      it.each([
        { limit: 0, windowMs: 1000 },
        { limit: -1, windowMs: 1000 },
        { limit: 1.5, windowMs: 1000 },
        { limit: 1, windowMs: 0 },
        { limit: 1, windowMs: Number.NaN },
      ])("refuses the rule %o", async (invalid) => {
        const key = harness.keys.rateLimit("explain", "ip", unique("subject"));
        await expect(peer().rateLimiter.check(key, invalid)).rejects.toBeInstanceOf(RangeError);
        expect(await harness.ttlMs(key)).toBeUndefined();
      });
    });

    describe("Cache", () => {
      it("misses, stores, overwrites and deletes", async () => {
        const key = harness.keys.scenario(unique("slug"));
        expect(await peer().cache.get(key)).toBeUndefined();

        await peer(0).cache.set(key, "first", 60);
        expect(await peer(1).cache.get(key)).toBe("first");
        await peer(1).cache.set(key, "second", 120);
        expect(await peer(2).cache.get(key)).toBe("second");
        expect(await harness.ttlMs(key)).toBeGreaterThan(60_000);

        expect(await peer().cache.delete(key)).toBe(true);
        expect(await peer().cache.delete(key)).toBe(false);
        expect(await peer().cache.get(key)).toBeUndefined();
      });

      it("round-trips text exactly", async () => {
        const key = harness.keys.explanation(unique("hash"));
        const value = JSON.stringify({ text: "naïve ✓ 行 \u0000 'quoted' \"double\"", n: [1, 2] });
        await peer().cache.set(key, value, 60);
        expect(await peer().cache.get(key)).toBe(value);
        const empty = harness.keys.explanation(unique("hash"));
        await peer().cache.set(empty, "", 60);
        expect(await peer().cache.get(empty)).toBe("");
      });

      it("expires an entry after its TTL", async () => {
        const key = harness.keys.scenario(unique("slug"));
        await peer().cache.set(key, "short-lived", 1);
        const ttl = await harness.ttlMs(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(1000);

        await harness.advance(1000);
        expect(await peer().cache.get(key)).toBeUndefined();
        expect(await harness.ttlMs(key)).toBeUndefined();
        expect(await peer().cache.delete(key)).toBe(false);
      });

      it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        "refuses the TTL %s and writes nothing",
        async (ttlSeconds) => {
          const key = harness.keys.scenario(unique("slug"));
          await expect(peer().cache.set(key, "v", ttlSeconds)).rejects.toBeInstanceOf(RangeError);
          expect(await peer().cache.get(key)).toBeUndefined();
        },
      );
    });

    describe("Lock", () => {
      it("is held by one lease at a time and can be taken again after release", async () => {
        const key = harness.keys.explanationLock(unique("hash"));
        const lease = await peer(0).lock.acquire(key, 5000);
        expect(lease).toMatchObject({ key });
        expect(lease?.token).toMatch(/\S{16,}/);
        expect(await peer(1).lock.acquire(key, 5000)).toBeUndefined();

        const ttl = await harness.ttlMs(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(5000);

        if (lease === undefined) throw new Error("the first acquire must succeed");
        expect(await peer(2).lock.release(lease)).toBe(true);
        expect(await harness.ttlMs(key)).toBeUndefined();
        expect(await peer().lock.release(lease)).toBe(false);

        const again = await peer(1).lock.acquire(key, 5000);
        expect(again?.token).toBeDefined();
        expect(again?.token).not.toBe(lease.token);
      });

      it("refuses a release by anybody but the holder", async () => {
        const key = harness.keys.explanationLock(unique("hash"));
        const lease = await peer(0).lock.acquire(key, 5000);
        if (lease === undefined) throw new Error("the first acquire must succeed");

        expect(await peer(1).lock.release({ key, token: "somebody-else" })).toBe(false);
        expect(await peer(1).lock.release({ key, token: "" })).toBe(false);
        expect(await peer(1).lock.acquire(key, 5000), "still held").toBeUndefined();
        expect(await peer(0).lock.release(lease)).toBe(true);
      });

      it("expires, and a stale lease cannot release the lock of its successor", async () => {
        const key = harness.keys.explanationLock(unique("hash"));
        const stale = await peer(0).lock.acquire(key, 200);
        if (stale === undefined) throw new Error("the first acquire must succeed");

        await harness.advance(200);
        const successor = await peer(1).lock.acquire(key, 5000);
        if (successor === undefined) throw new Error("an expired lock must be acquirable");

        expect(await peer(0).lock.release(stale)).toBe(false);
        expect(await peer(2).lock.acquire(key, 5000), "the successor still holds").toBeUndefined();
        expect(await peer(1).lock.release(successor)).toBe(true);
      });

      it("is atomic: of many parallel acquires exactly one gets the lease", async () => {
        const key = harness.keys.explanationLock(unique("hash"));
        const leases = await Promise.all(
          Array.from({ length: 30 }, (_, call) => peer(call).lock.acquire(key, 5000)),
        );
        expect(leases.filter((lease) => lease !== undefined)).toHaveLength(1);
      });

      it.each([0, -1, 0.5, Number.NaN])("refuses the TTL %s", async (ttlMs) => {
        const key = harness.keys.explanationLock(unique("hash"));
        await expect(peer().lock.acquire(key, ttlMs)).rejects.toBeInstanceOf(RangeError);
        expect(await harness.ttlMs(key)).toBeUndefined();
      });
    });

    describe("single-flight over Lock and Cache", () => {
      const wait = { timeoutMs: 5000, intervalMs: 5 };

      interface Flight {
        readonly run: (caller: number) => Promise<SingleFlightResult<string>>;
        readonly cacheKey: RedisKey;
        readonly lockKey: RedisKey;
        readonly producers: () => number;
      }

      const flight = (produce: (call: number) => Promise<string>): Flight => {
        const hash = unique("hash");
        const cacheKey = harness.keys.explanation(hash);
        const lockKey = harness.keys.explanationLock(hash);
        let calls = 0;
        return {
          cacheKey,
          lockKey,
          producers: () => calls,
          run: (caller) =>
            singleFlight({
              lock: peer(caller).lock,
              lockKey,
              lockTtlMs: SINGLE_FLIGHT_LOCK_TTL_MS,
              read: () => peer(caller).cache.get(cacheKey),
              store: (value) =>
                peer(caller).cache.set(cacheKey, value, EXPLANATION_CACHE_TTL_SECONDS),
              produce: () => {
                calls += 1;
                return produce(calls);
              },
              wait,
            }),
        };
      };

      const slowly = (value: string): Promise<string> =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(value);
          }, 60);
        });

      it("runs one producer for many parallel identical requests; the rest read the cache", async () => {
        const identical = flight((call) => slowly(`explanation #${call}`));
        const results = await Promise.all(
          Array.from({ length: 25 }, (_, caller) => identical.run(caller)),
        );

        expect(identical.producers()).toBe(1);
        expect(results.filter((result) => result.source === "produced")).toHaveLength(1);
        expect(results.filter((result) => result.source === "waited")).toHaveLength(24);
        for (const result of results) expect(result).toMatchObject({ value: "explanation #1" });

        expect(await harness.ttlMs(identical.lockKey), "lock released").toBeUndefined();
        expect(await harness.ttlMs(identical.cacheKey)).toBeGreaterThan(0);
        expect(await identical.run(0)).toEqual({ source: "cache", value: "explanation #1" });
        expect(identical.producers()).toBe(1);
      });

      it("hands over to a follower when the producer fails", async () => {
        const flaky = flight(async (call) => {
          const value = await slowly(`attempt #${call}`);
          if (call === 1) throw new Error("the model call failed");
          return value;
        });
        const settled = await Promise.allSettled(
          Array.from({ length: 10 }, (_, caller) => flaky.run(caller)),
        );

        expect(flaky.producers()).toBe(2);
        const rejected = settled.filter((result) => result.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toEqual(new Error("the model call failed"));
        const values = settled.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        expect(values).toHaveLength(9);
        for (const value of values) expect(value).toMatchObject({ value: "attempt #2" });
        expect(await harness.ttlMs(flaky.lockKey), "lock released").toBeUndefined();
      });

      it("times out when the holder of the lock never delivers", async () => {
        const stuck = flight(() => Promise.resolve("never produced"));
        const held = await peer(1).lock.acquire(stuck.lockKey, SINGLE_FLIGHT_LOCK_TTL_MS);
        if (held === undefined) throw new Error("the lock must be free");

        const result = await singleFlight({
          lock: peer(0).lock,
          lockKey: stuck.lockKey,
          lockTtlMs: SINGLE_FLIGHT_LOCK_TTL_MS,
          read: () => peer(0).cache.get(stuck.cacheKey),
          store: () => Promise.reject(new Error("must not store")),
          produce: () => Promise.reject(new Error("must not produce")),
          wait: { timeoutMs: 40, intervalMs: 5 },
        });

        expect(result).toEqual({ source: "timeout" });
        expect(await peer(1).lock.release(held), "the holder's lock was left alone").toBe(true);
      });
    });
  });
}
