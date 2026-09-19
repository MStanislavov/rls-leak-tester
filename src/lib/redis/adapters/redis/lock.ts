/**
 * Redis lock: `SET key token PX ttl NX` to acquire, and a compare-and-delete Lua
 * script to release, so that a holder whose lease expired can never delete the
 * lock of its successor. The lock always has a TTL (REDIS-001).
 */
import { randomUUID } from "node:crypto";

import type Redis from "ioredis";

import { assertKeyPrefix, type RedisKey } from "../../keys";
import { assertPositiveInteger, type Lock, type LockLease } from "../../ports";
import type { RedisConnection } from "./connection";

/** The commands this adapter sends. */
type LockCommands = Pick<Redis, "set" | "eval">;

/** KEYS[1] the lock, ARGV[1] the token of the lease. Returns 1 when it was released. */
export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RedisLock implements Lock {
  private readonly connection: RedisConnection;
  private readonly keyPrefix: string;

  constructor(connection: RedisConnection, keyPrefix: string) {
    this.connection = connection;
    this.keyPrefix = keyPrefix;
  }

  async acquire(key: RedisKey, ttlMs: number): Promise<LockLease | undefined> {
    assertKeyPrefix(this.keyPrefix, key);
    assertPositiveInteger("ttlMs", ttlMs);
    const token = randomUUID();
    const reply = await this.connection.run("lock.acquire", (client: LockCommands) =>
      client.set(key, token, "PX", ttlMs, "NX"),
    );
    return reply === "OK" ? { key, token } : undefined;
  }

  async release(lease: LockLease): Promise<boolean> {
    assertKeyPrefix(this.keyPrefix, lease.key);
    const reply = await this.connection.run("lock.release", (client: LockCommands) =>
      client.eval(RELEASE_SCRIPT, 1, lease.key, lease.token),
    );
    return reply === 1;
  }
}
