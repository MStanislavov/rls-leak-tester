/**
 * Rate limit headers of `/api/explain`, in both spellings a client may look for.
 *
 * The current IETF draft (draft-ietf-httpapi-ratelimit-headers, revisions 07 and later) defines
 * two structured fields: `RateLimit-Policy: "name";q=<quota>;w=<window seconds>` and
 * `RateLimit: "name";r=<remaining>;t=<seconds until reset>`. The three fields of the earlier
 * revisions (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`) are what deployed
 * clients and proxies still read, and `rateLimitHeaders` of the Redis layer emits those plus
 * `Retry-After`. Sending both costs a few bytes and breaks nobody.
 */
import { rateLimitHeaders, type RateLimitResult } from "@/lib/redis";

export const EXPLAIN_POLICY_NAME = "explain";

/** Pure. `windowSeconds` is the window of the policy that produced `result`. */
export function explainRateLimitHeaders(
  result: RateLimitResult,
  windowSeconds: number,
): Record<string, string> {
  const resetSeconds = Math.max(0, Math.ceil(result.resetMs / 1000));
  return {
    ...rateLimitHeaders(result),
    "RateLimit-Policy": `"${EXPLAIN_POLICY_NAME}";q=${result.limit};w=${windowSeconds}`,
    RateLimit: `"${EXPLAIN_POLICY_NAME}";r=${result.remaining};t=${resetSeconds}`,
  };
}
