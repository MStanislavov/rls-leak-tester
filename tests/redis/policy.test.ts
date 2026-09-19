/**
 * The numbers of src/lib/redis/policy.ts are `thresholds` in rules.yaml. This test
 * reads the file (which is why it lives in tests/) and fails when they drift apart.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import {
  EXPLANATION_CACHE_TTL_SECONDS,
  RATE_LIMITS,
  SCENARIO_CACHE_TTL_SECONDS,
  SINGLE_FLIGHT_LOCK_TTL_MS,
} from "@/lib/redis/policy";

const limits = z.object({
  window_seconds: z.number(),
  per_ip: z.number(),
  per_user: z.number(),
});

const rulesFile = z.object({
  thresholds: z.object({
    ai: z.object({
      explanation_cache_ttl_seconds: z.number(),
      single_flight_lock_ttl_ms: z.number(),
    }),
    redis: z.object({ key_scheme: z.string(), scenario_cache_ttl_seconds: z.number() }),
    rate_limits: z.object({ explain: limits, scenario_writes: limits }),
  }),
});

const { thresholds } = rulesFile.parse(
  parse(readFileSync(fileURLToPath(new URL("../../rules.yaml", import.meta.url)), "utf8")),
);

describe("src/lib/redis/policy.ts and rules.yaml thresholds", () => {
  it("agree on the TTLs", () => {
    expect(EXPLANATION_CACHE_TTL_SECONDS).toBe(thresholds.ai.explanation_cache_ttl_seconds);
    expect(EXPLANATION_CACHE_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(SINGLE_FLIGHT_LOCK_TTL_MS).toBe(thresholds.ai.single_flight_lock_ttl_ms);
    expect(SCENARIO_CACHE_TTL_SECONDS).toBe(thresholds.redis.scenario_cache_ttl_seconds);
  });

  it("agree on the rate limits", () => {
    const fromRules = (entry: z.infer<typeof limits>) => ({
      windowSeconds: entry.window_seconds,
      perIp: entry.per_ip,
      perUser: entry.per_user,
    });
    expect(RATE_LIMITS).toEqual({
      explain: fromRules(thresholds.rate_limits.explain),
      "scenario-writes": fromRules(thresholds.rate_limits.scenario_writes),
    });
  });

  it("agree on the key scheme", () => {
    expect(thresholds.redis.key_scheme).toBe("rlsleak:{env}:{purpose}:{id}");
  });
});
