/** In-memory lock with `SET NX PX` semantics: free or expired means acquirable. */
import { randomUUID } from "node:crypto";

import { assertKeyPrefix, type RedisKey } from "../../keys";
import { assertPositiveInteger, type Lock, type LockLease } from "../../ports";
import type { TtlMap } from "./ttl-map";

export class MemoryLock implements Lock {
  private readonly holders: TtlMap<string>;
  private readonly keyPrefix: string;

  constructor(holders: TtlMap<string>, keyPrefix: string) {
    this.holders = holders;
    this.keyPrefix = keyPrefix;
  }

  acquire(key: RedisKey, ttlMs: number): Promise<LockLease | undefined> {
    return Promise.resolve().then(() => {
      assertKeyPrefix(this.keyPrefix, key);
      assertPositiveInteger("ttlMs", ttlMs);
      if (this.holders.get(key) !== undefined) return undefined;
      const token = randomUUID();
      this.holders.put(key, token, ttlMs);
      return { key, token };
    });
  }

  release(lease: LockLease): Promise<boolean> {
    return Promise.resolve().then(() => {
      assertKeyPrefix(this.keyPrefix, lease.key);
      if (this.holders.get(lease.key) !== lease.token) return false;
      return this.holders.remove(lease.key);
    });
  }
}
