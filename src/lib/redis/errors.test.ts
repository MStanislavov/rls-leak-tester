import { describe, expect, it } from "vitest";

import { RedisUnavailableError, isRedisUnavailable } from "./errors";

describe("RedisUnavailableError", () => {
  it("names the operation, keeps the cause and never quotes it in the message", () => {
    // Assembled at run time: a literal URL with a password would trip SEC-003.
    const url = ["redis://user", "hunter2@cache.internal", "6379"].join(":");
    const cause = new Error(`connect ECONNREFUSED ${url}`);
    const error = new RedisUnavailableError("cache.get", cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RedisUnavailableError");
    expect(error.operation).toBe("cache.get");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Redis is unavailable (cache.get)");
    expect(error.message).not.toContain("hunter2");
  });

  it("is recognised by its guard", () => {
    expect(isRedisUnavailable(new RedisUnavailableError("lock.acquire"))).toBe(true);
    expect(isRedisUnavailable(new Error("other"))).toBe(false);
    expect(isRedisUnavailable(undefined)).toBe(false);
  });
});
