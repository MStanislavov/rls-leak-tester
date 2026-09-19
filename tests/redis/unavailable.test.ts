/**
 * The failure policy with the real ioredis client and no Redis behind it: a port on
 * loopback that nothing listens on. Hermetic, so it runs on every `npm test`.
 * A dead Redis must fail fast and typed, so that /api/explain can answer 503.
 */
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { RedisUnavailableError, createRedisServices, type RedisServices } from "@/lib/redis";

/** Binds a loopback port, closes it again, and returns its number: nothing listens there now. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
  });
}

describe("Redis configured but unreachable", () => {
  let services: RedisServices | undefined;

  afterEach(() => {
    services?.close();
  });

  it("rejects every port call with RedisUnavailableError, quickly, and never falls back to memory", async () => {
    services = createRedisServices({
      envName: "test",
      redisUrl: `redis://127.0.0.1:${await closedPort()}`,
    });
    const { keys, cache, lock, rateLimiter } = services;
    expect(services.backend).toBe("redis");

    const started = Date.now();
    const attempts = [
      cache.get(keys.scenario("slug")),
      cache.set(keys.scenario("slug"), "v", 60),
      lock.acquire(keys.explanationLock("hash"), 1000),
      rateLimiter.check(keys.rateLimit("explain", "ip", "203.0.113.7"), {
        limit: 5,
        windowMs: 60_000,
      }),
    ];
    for (const attempt of attempts) {
      const error: unknown = await attempt.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RedisUnavailableError);
      expect((error as RedisUnavailableError).message).not.toContain("127.0.0.1");
    }

    // The next call meets the cool-down: refused at once, without another dial.
    await expect(cache.get(keys.scenario("slug"))).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
