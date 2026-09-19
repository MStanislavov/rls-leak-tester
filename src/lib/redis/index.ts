/**
 * Public surface of the Redis layer. Server code imports from `@/lib/redis`; the
 * adapters and the ioredis client stay internal (rules.yaml REDIS-001). A route
 * that imports this module declares `export const runtime = "nodejs"` (REDIS-002).
 */
export { RedisUnavailableError, isRedisUnavailable } from "./errors";
export {
  createRedisServices,
  getRedisServices,
  resetRedisServices,
  type RedisLayerConfig,
  type RedisServices,
} from "./factory";
export {
  createKeyBuilder,
  type KeyBuilder,
  type KeyPurpose,
  type RateLimitScope,
  type RateLimitSubjectKind,
  type RedisKey,
} from "./keys";
export {
  EXPLANATION_CACHE_TTL_SECONDS,
  RATE_LIMITS,
  SCENARIO_CACHE_TTL_SECONDS,
  SINGLE_FLIGHT_LOCK_TTL_MS,
  rateLimitRule,
} from "./policy";
export type {
  Cache,
  Clock,
  Lock,
  LockLease,
  RateLimitResult,
  RateLimitRule,
  RateLimiter,
} from "./ports";
export { checkRateLimits, rateLimitHeaders, type RateLimitSubject } from "./rate-limit";
export { readThrough, type ReadThroughOptions } from "./read-through";
export {
  singleFlight,
  waitForValue,
  type SingleFlightOptions,
  type SingleFlightResult,
  type WaitOptions,
} from "./single-flight";
