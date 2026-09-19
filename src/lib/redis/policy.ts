/**
 * The numbers of the Redis layer. They are `thresholds` in rules.yaml (`ai`, `redis`,
 * `rate_limits`); `tests/redis/policy.test.ts` fails when the two drift apart.
 * Changing one means changing rules.yaml and writing an ADR.
 */
import type { RateLimitScope, RateLimitSubjectKind } from "./keys";
import type { RateLimitRule } from "./ports";

interface ScopeLimits {
  readonly windowSeconds: number;
  readonly perIp: number;
  readonly perUser: number;
}

export const RATE_LIMITS: Readonly<Record<RateLimitScope, ScopeLimits>> = {
  explain: { windowSeconds: 60, perIp: 5, perUser: 10 },
  "scenario-writes": { windowSeconds: 60, perIp: 20, perUser: 30 },
};

/** An identical question never costs twice within seven days. */
export const EXPLANATION_CACHE_TTL_SECONDS = 604_800;

/** A crashed producer blocks identical requests for at most this long. */
export const SINGLE_FLIGHT_LOCK_TTL_MS = 30_000;

/** Shared scenarios by slug: short, and invalidated on write. */
export const SCENARIO_CACHE_TTL_SECONDS = 60;

/** Pure: the limiter rule of one scope and one kind of subject. */
export function rateLimitRule(scope: RateLimitScope, kind: RateLimitSubjectKind): RateLimitRule {
  const limits = RATE_LIMITS[scope];
  return {
    limit: kind === "ip" ? limits.perIp : limits.perUser,
    windowMs: limits.windowSeconds * 1000,
  };
}
