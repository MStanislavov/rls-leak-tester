/**
 * Redis sliding-window limiter: a sorted set of request times per key, handled by
 * one Lua script, so that trim, count and add are a single atomic step however
 * many processes ask at once.
 *
 * The script reads the time of the Redis server (`TIME`), so every app instance
 * shares one clock. A refused request is not added. The key lives exactly as long
 * as its newest entry: `PEXPIRE` after every `ZADD` (REDIS-001).
 */
import { randomUUID } from "node:crypto";

import type Redis from "ioredis";
import { z } from "zod";

import { assertKeyPrefix, type RedisKey } from "../../keys";
import {
  assertPositiveInteger,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimiter,
} from "../../ports";
import type { RedisConnection } from "./connection";

/** The commands this adapter sends. */
type LimiterCommands = Pick<Redis, "eval">;

/**
 * KEYS[1] the log. ARGV[1] window in ms, ARGV[2] limit, ARGV[3] a unique member.
 * Returns { allowed 0|1, requests counted in the window, ms until the oldest one leaves }.
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, ARGV[3])
  redis.call('PEXPIRE', key, window)
  count = count + 1
  allowed = 1
end
local reset = window
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] then
  reset = tonumber(oldest[2]) + window - now
end
return { allowed, count, reset }
`;

const scriptReply = z.tuple([
  z.union([z.literal(0), z.literal(1)]),
  z.number().int().nonnegative(),
  z.number().int(),
]);

export class RedisRateLimiter implements RateLimiter {
  private readonly connection: RedisConnection;
  private readonly keyPrefix: string;

  constructor(connection: RedisConnection, keyPrefix: string) {
    this.connection = connection;
    this.keyPrefix = keyPrefix;
  }

  async check(key: RedisKey, rule: RateLimitRule): Promise<RateLimitResult> {
    assertKeyPrefix(this.keyPrefix, key);
    assertPositiveInteger("limit", rule.limit);
    assertPositiveInteger("windowMs", rule.windowMs);

    const [allowedFlag, count, reset] = await this.connection.run(
      "rateLimiter.check",
      async (client: LimiterCommands) =>
        scriptReply.parse(
          await client.eval(SLIDING_WINDOW_SCRIPT, 1, key, rule.windowMs, rule.limit, randomUUID()),
        ),
    );
    const allowed = allowedFlag === 1;
    const resetMs = Math.max(0, reset);
    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - count),
      resetMs,
      retryAfterMs: allowed ? 0 : resetMs,
    };
  }
}
