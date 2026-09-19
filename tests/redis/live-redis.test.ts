/**
 * What only a real Redis can show, on top of the contract suite: that the suite's
 * own TTL probe and clean-up can be trusted, and that the fail-fast client opens
 * its connection again after the server dropped it. Runs when REDIS_URL is set.
 */
import { randomUUID } from "node:crypto";

import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRedisAdapters } from "@/lib/redis/adapters/redis";
import { createKeyBuilder } from "@/lib/redis/keys";

import { createRedisHarness } from "./contract/harness";

const redisUrl = process.env.REDIS_URL?.trim() ?? "";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe.skipIf(redisUrl === "")("real Redis", () => {
  let raw: Redis;

  beforeAll(async () => {
    raw = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0 });
    await raw.connect();
  });

  afterAll(() => {
    raw.disconnect();
  });

  it("the contract harness sees a key without a TTL, and cleans up its own prefix only", async () => {
    const harness = await createRedisHarness(redisUrl)();
    const neighbour = createKeyBuilder(`test-${randomUUID().replaceAll("-", "").slice(0, 12)}`);
    const immortal = harness.keys.scenario("written-without-ttl");
    const foreign = neighbour.scenario("somebody-else");
    try {
      await raw.set(immortal, "no expiry", "KEEPTTL");
      await raw.set(foreign, "not ours", "EX", 60);

      // This is the value the contract suite's afterEach refuses (`> 0`).
      expect(await harness.ttlMs(immortal)).toBe(-1);
      expect(await harness.liveKeys()).toEqual([immortal]);
      expect(await harness.ttlMs(harness.keys.scenario("missing"))).toBeUndefined();

      await harness.dispose();
      expect(await raw.exists(immortal)).toBe(0);
      expect(await raw.exists(foreign), "a key outside the prefix survives").toBe(1);
    } finally {
      await raw.del(immortal, foreign);
    }
  });

  it("opens its connection again, on demand, after the server dropped it", async () => {
    const keys = createKeyBuilder(`test-${randomUUID().replaceAll("-", "").slice(0, 12)}`);
    const connectionName = `rls-contract-${randomUUID()}`;
    const adapters = createRedisAdapters({
      url: redisUrl,
      keyPrefix: keys.prefix,
      createClient: (url, options) => new Redis(url, { ...options, connectionName }),
    });
    const key = keys.scenario("reconnect");
    try {
      await adapters.cache.set(key, "before", 60);

      const clients = await raw.client("LIST");
      const line = String(clients)
        .split("\n")
        .find((entry) => entry.includes(`name=${connectionName}`));
      const id = /\bid=(\d+)/.exec(line ?? "")?.[1];
      if (id === undefined) throw new Error("the adapter's connection is not in CLIENT LIST");
      expect(await raw.client("KILL", "ID", id)).toBe(1);
      await sleep(100);

      // No retry loop and no offline queue: the next command dials again by itself.
      expect(await adapters.cache.get(key)).toBe("before");
    } finally {
      await raw.del(key);
      adapters.close();
    }
  });
});
