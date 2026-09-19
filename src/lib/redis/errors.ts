/**
 * The one failure a caller of the Redis ports has to handle.
 *
 * Every error that comes out of the Redis adapters (no connection, a timeout, a
 * reply that makes no sense) is a `RedisUnavailableError`. `/api/explain` answers
 * it with `503` in production: an unmetered model endpoint is a cost risk, so it
 * fails closed. The message names the operation, never a key, a value or the URL.
 */
export class RedisUnavailableError extends Error {
  /** Short name of the port operation that failed, for logs: `cache.get`, `lock.acquire`, ... */
  readonly operation: string;

  constructor(operation: string, cause?: unknown) {
    super(`Redis is unavailable (${operation})`, { cause });
    this.name = "RedisUnavailableError";
    this.operation = operation;
  }
}

export function isRedisUnavailable(error: unknown): error is RedisUnavailableError {
  return error instanceof RedisUnavailableError;
}
