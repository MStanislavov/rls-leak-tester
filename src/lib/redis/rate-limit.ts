/**
 * What a route needs around the `RateLimiter` port: the per-IP and per-user check
 * with the numbers of `policy.ts`, and the response headers of a result.
 */
import type { KeyBuilder, RateLimitScope } from "./keys";
import { rateLimitRule } from "./policy";
import type { RateLimitResult, RateLimiter } from "./ports";

export interface RateLimitSubject {
  /** The caller's address. Hashed before it becomes part of a key. */
  readonly ip: string;
  /** The signed-in user, when there is one. */
  readonly userId?: string;
}

/**
 * Limits per IP and, when signed in, per user. The address is checked first; a
 * request refused there does not touch the user's budget. Returns the refusal,
 * or of two allowed results the one with less room, which is what the headers
 * should show.
 */
export async function checkRateLimits(
  limiter: RateLimiter,
  keys: KeyBuilder,
  scope: RateLimitScope,
  subject: RateLimitSubject,
): Promise<RateLimitResult> {
  const byIp = await limiter.check(
    keys.rateLimit(scope, "ip", subject.ip),
    rateLimitRule(scope, "ip"),
  );
  if (!byIp.allowed || subject.userId === undefined) return byIp;

  const byUser = await limiter.check(
    keys.rateLimit(scope, "user", subject.userId),
    rateLimitRule(scope, "user"),
  );
  if (!byUser.allowed) return byUser;
  return byUser.remaining < byIp.remaining ? byUser : byIp;
}

function toSeconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/**
 * Pure: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds) for
 * every response, plus `Retry-After` (at least one second) for a `429`.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(toSeconds(result.resetMs)),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(Math.max(1, toSeconds(result.retryAfterMs)));
  }
  return headers;
}
