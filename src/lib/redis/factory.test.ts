import { afterEach, describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/config/env";

import { createRedisServices, getRedisServices, resetRedisServices } from "./factory";
import * as publicApi from "./index";

afterEach(() => {
  resetRedisServices();
});

describe("createRedisServices", () => {
  it("uses the in-memory adapters when no Redis URL is configured", async () => {
    const services = createRedisServices({ envName: "development", redisUrl: undefined });
    expect(services.backend).toBe("memory");
    expect(services.keys.prefix).toBe("rlsleak:development:");

    const key = services.keys.scenario("slug");
    await services.cache.set(key, "value", 60);
    expect(await services.cache.get(key)).toBe("value");
    const lease = await services.lock.acquire(services.keys.explanationLock("hash"), 1000);
    expect(lease).toBeDefined();
    const limited = await services.rateLimiter.check(
      services.keys.rateLimit("explain", "ip", "203.0.113.7"),
      { limit: 1, windowMs: 1000 },
    );
    expect(limited.allowed).toBe(true);

    expect(services.close()).toBeUndefined();
    expect(await services.cache.get(key), "still usable after close()").toBe("value");
  });

  it("uses the Redis adapters when a URL is configured, without connecting", () => {
    const services = createRedisServices({
      envName: "production",
      redisUrl: "rediss://cache.example:6380",
    });
    expect(services.backend).toBe("redis");
    expect(services.keys.prefix).toBe("rlsleak:production:");
    // Nothing was opened, so there is nothing to close and nothing was dialled.
    expect(services.close()).toBeUndefined();
  });

  it("gives separate instances separate state", async () => {
    const config = { envName: "test", redisUrl: undefined };
    const one = createRedisServices(config);
    const two = createRedisServices(config);
    await one.cache.set(one.keys.scenario("slug"), "value", 60);
    expect(await two.cache.get(two.keys.scenario("slug"))).toBeUndefined();
  });

  it("refuses an env name that cannot be a key segment", () => {
    expect(() => createRedisServices({ envName: "a:b", redisUrl: undefined })).toThrow(RangeError);
  });

  it("takes a parsed ServerConfig as it is", () => {
    expect(createRedisServices(parseServerEnv({})).backend).toBe("memory");
    const configured = parseServerEnv({ REDIS_URL: "redis://127.0.0.1:6379" });
    expect(configured.features.redisEnabled).toBe(true);
    const services = createRedisServices(configured);
    expect(services.backend).toBe("redis");
    expect(services.keys.env).toBe(configured.envName);
  });
});

describe("getRedisServices", () => {
  it("returns one instance per process for the same configuration", async () => {
    const first = getRedisServices({ envName: "test", redisUrl: undefined });
    const second = getRedisServices({ envName: "test", redisUrl: undefined });
    expect(second).toBe(first);

    // This is what makes the in-memory limiter limit at all: state survives between requests.
    const key = first.keys.rateLimit("explain", "ip", "203.0.113.7");
    const rule = { limit: 1, windowMs: 60_000 };
    expect((await first.rateLimiter.check(key, rule)).allowed).toBe(true);
    expect((await second.rateLimiter.check(key, rule)).allowed).toBe(false);
  });

  it("replaces the instance when the configuration changes, and forgets it on reset", () => {
    const memory = getRedisServices({ envName: "test", redisUrl: undefined });
    const redis = getRedisServices({ envName: "test", redisUrl: "redis://127.0.0.1:6379" });
    expect(redis).not.toBe(memory);
    expect(redis.backend).toBe("redis");
    expect(getRedisServices({ envName: "preview", redisUrl: "redis://127.0.0.1:6379" })).not.toBe(
      redis,
    );

    resetRedisServices();
    resetRedisServices();
    expect(getRedisServices({ envName: "test", redisUrl: undefined })).not.toBe(memory);
  });
});

describe("the public surface", () => {
  it("exports the factory, the helpers and the policy, and no adapter", () => {
    expect(Object.keys(publicApi).toSorted()).toEqual([
      "EXPLANATION_CACHE_TTL_SECONDS",
      "RATE_LIMITS",
      "RedisUnavailableError",
      "SCENARIO_CACHE_TTL_SECONDS",
      "SINGLE_FLIGHT_LOCK_TTL_MS",
      "checkRateLimits",
      "createKeyBuilder",
      "createRedisServices",
      "getRedisServices",
      "isRedisUnavailable",
      "rateLimitHeaders",
      "rateLimitRule",
      "readThrough",
      "resetRedisServices",
      "singleFlight",
      "waitForValue",
    ]);
  });
});
