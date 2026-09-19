/**
 * In-memory sliding-window limiter: a log of timestamps per key, the same
 * algorithm as the Lua script of the Redis adapter. JavaScript runs `check` to
 * completion without yielding, so check-and-increment is atomic here as well.
 */
import { assertKeyPrefix, type RedisKey } from "../../keys";
import {
  assertPositiveInteger,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimiter,
} from "../../ports";
import type { TtlMap } from "./ttl-map";

export class MemoryRateLimiter implements RateLimiter {
  private readonly hits: TtlMap<readonly number[]>;
  private readonly now: () => number;
  private readonly keyPrefix: string;

  constructor(hits: TtlMap<readonly number[]>, now: () => number, keyPrefix: string) {
    this.hits = hits;
    this.now = now;
    this.keyPrefix = keyPrefix;
  }

  check(key: RedisKey, rule: RateLimitRule): Promise<RateLimitResult> {
    return Promise.resolve().then(() => this.checkNow(key, rule));
  }

  private checkNow(key: RedisKey, rule: RateLimitRule): RateLimitResult {
    assertKeyPrefix(this.keyPrefix, key);
    assertPositiveInteger("limit", rule.limit);
    assertPositiveInteger("windowMs", rule.windowMs);

    const now = this.now();
    const live = (this.hits.get(key) ?? []).filter((at) => at > now - rule.windowMs);
    const allowed = live.length < rule.limit;
    const counted = allowed ? [...live, now] : live;
    if (allowed) this.hits.put(key, counted, rule.windowMs);

    const oldest = counted.reduce((earliest, at) => Math.min(earliest, at), now);
    const resetMs = oldest + rule.windowMs - now;
    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - counted.length),
      resetMs,
      retryAfterMs: allowed ? 0 : resetMs,
    };
  }
}
