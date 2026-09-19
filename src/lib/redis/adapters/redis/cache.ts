/** Redis cache: `GET`, `SET ... EX`, `DEL`. There is no write without a TTL (REDIS-001). */
import type Redis from "ioredis";

import { assertKeyPrefix, type RedisKey } from "../../keys";
import { assertPositiveInteger, type Cache } from "../../ports";
import type { RedisConnection } from "./connection";

/** The commands this adapter sends. */
type CacheCommands = Pick<Redis, "get" | "set" | "del">;

export class RedisCache implements Cache {
  private readonly connection: RedisConnection;
  private readonly keyPrefix: string;

  constructor(connection: RedisConnection, keyPrefix: string) {
    this.connection = connection;
    this.keyPrefix = keyPrefix;
  }

  async get(key: RedisKey): Promise<string | undefined> {
    assertKeyPrefix(this.keyPrefix, key);
    const value = await this.connection.run("cache.get", (client: CacheCommands) =>
      client.get(key),
    );
    return value ?? undefined;
  }

  async set(key: RedisKey, value: string, ttlSeconds: number): Promise<void> {
    assertKeyPrefix(this.keyPrefix, key);
    assertPositiveInteger("ttlSeconds", ttlSeconds);
    await this.connection.run("cache.set", (client: CacheCommands) =>
      client.set(key, value, "EX", ttlSeconds),
    );
  }

  async delete(key: RedisKey): Promise<boolean> {
    assertKeyPrefix(this.keyPrefix, key);
    const removed = await this.connection.run("cache.delete", (client: CacheCommands) =>
      client.del(key),
    );
    return removed > 0;
  }
}
