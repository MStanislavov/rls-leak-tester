import { describe, expect, it } from "vitest";

import { createMemoryAdapters } from "./adapters/memory";
import { createKeyBuilder } from "./keys";
import { RATE_LIMITS, rateLimitRule } from "./policy";
import { checkRateLimits, rateLimitHeaders } from "./rate-limit";

const keys = createKeyBuilder("test");
const newLimiter = () => createMemoryAdapters({ keyPrefix: keys.prefix, clock: () => 1_000_000 });

describe("rateLimitRule", () => {
  it("turns the policy into limiter rules", () => {
    expect(rateLimitRule("explain", "ip")).toEqual({
      limit: RATE_LIMITS.explain.perIp,
      windowMs: RATE_LIMITS.explain.windowSeconds * 1000,
    });
    expect(rateLimitRule("scenario-writes", "user")).toEqual({
      limit: RATE_LIMITS["scenario-writes"].perUser,
      windowMs: RATE_LIMITS["scenario-writes"].windowSeconds * 1000,
    });
  });
});

describe("checkRateLimits", () => {
  it("limits an anonymous caller per IP", async () => {
    const { rateLimiter } = newLimiter();
    const perIp = RATE_LIMITS.explain.perIp;
    for (let call = 0; call < perIp; call += 1) {
      const result = await checkRateLimits(rateLimiter, keys, "explain", { ip: "203.0.113.1" });
      expect(result).toMatchObject({ allowed: true, limit: perIp, remaining: perIp - call - 1 });
    }
    const refused = await checkRateLimits(rateLimiter, keys, "explain", { ip: "203.0.113.1" });
    expect(refused).toMatchObject({ allowed: false, limit: perIp, remaining: 0 });
    expect(refused.retryAfterMs).toBeGreaterThan(0);

    const other = await checkRateLimits(rateLimiter, keys, "explain", { ip: "203.0.113.2" });
    expect(other.allowed).toBe(true);
  });

  it("limits a signed-in caller per user as well, across addresses", async () => {
    const { rateLimiter } = newLimiter();
    const perUser = RATE_LIMITS.explain.perUser;
    for (let call = 0; call < perUser; call += 1) {
      // A new address every time: only the user's budget is used up.
      const result = await checkRateLimits(rateLimiter, keys, "explain", {
        ip: `198.51.100.${call}`,
        userId: "user-1",
      });
      expect(result.allowed).toBe(true);
    }
    const refused = await checkRateLimits(rateLimiter, keys, "explain", {
      ip: "198.51.100.200",
      userId: "user-1",
    });
    expect(refused).toMatchObject({ allowed: false, limit: perUser, remaining: 0 });
  });

  it("reports the tighter of two allowed budgets", async () => {
    const { rateLimiter } = newLimiter();
    const first = await checkRateLimits(rateLimiter, keys, "explain", { ip: "a", userId: "u" });
    expect(first).toMatchObject({ limit: RATE_LIMITS.explain.perIp, remaining: 4 });

    // Seven more requests of the same user from other addresses: the user has 2 left, this IP 3.
    for (let call = 0; call < 7; call += 1) {
      await checkRateLimits(rateLimiter, keys, "explain", { ip: `other-${call}`, userId: "u" });
    }
    const second = await checkRateLimits(rateLimiter, keys, "explain", { ip: "a", userId: "u" });
    expect(second).toMatchObject({ limit: RATE_LIMITS.explain.perUser, remaining: 1 });
  });

  it("does not touch the user's budget when the address is refused", async () => {
    const { rateLimiter } = newLimiter();
    for (let call = 0; call < RATE_LIMITS.explain.perIp + 3; call += 1) {
      await checkRateLimits(rateLimiter, keys, "explain", { ip: "a", userId: "u" });
    }
    const fromElsewhere = await checkRateLimits(rateLimiter, keys, "explain", {
      ip: "b",
      userId: "u",
    });
    // perIp requests reached the user check, the three refused ones did not: the user has
    // 10 - 5 - 1 = 4 left (as has the new address). Had they counted, it would be 1.
    expect(fromElsewhere.allowed).toBe(true);
    expect(fromElsewhere.remaining).toBe(
      RATE_LIMITS.explain.perUser - RATE_LIMITS.explain.perIp - 1,
    );
  });
});

describe("rateLimitHeaders", () => {
  it("describes an allowed request without Retry-After", () => {
    expect(
      rateLimitHeaders({
        allowed: true,
        limit: 5,
        remaining: 3,
        resetMs: 41_200,
        retryAfterMs: 0,
      }),
    ).toEqual({ "RateLimit-Limit": "5", "RateLimit-Remaining": "3", "RateLimit-Reset": "42" });
  });

  it("adds Retry-After in whole seconds, at least one, to a refusal", () => {
    expect(
      rateLimitHeaders({
        allowed: false,
        limit: 5,
        remaining: 0,
        resetMs: 12_001,
        retryAfterMs: 12_001,
      }),
    ).toEqual({
      "RateLimit-Limit": "5",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "13",
      "Retry-After": "13",
    });
    expect(
      rateLimitHeaders({ allowed: false, limit: 5, remaining: 0, resetMs: 0, retryAfterMs: 0 }),
    ).toMatchObject({ "RateLimit-Reset": "0", "Retry-After": "1" });
  });
});
