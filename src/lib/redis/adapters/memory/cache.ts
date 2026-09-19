/** In-memory cache with the semantics of the Redis adapter: every entry expires. */
import { assertKeyPrefix, type RedisKey } from "../../keys";
import { assertPositiveInteger, type Cache } from "../../ports";
import type { TtlMap } from "./ttl-map";

export class MemoryCache implements Cache {
  private readonly entries: TtlMap<string>;
  private readonly keyPrefix: string;

  constructor(entries: TtlMap<string>, keyPrefix: string) {
    this.entries = entries;
    this.keyPrefix = keyPrefix;
  }

  get(key: RedisKey): Promise<string | undefined> {
    return Promise.resolve().then(() => {
      assertKeyPrefix(this.keyPrefix, key);
      return this.entries.get(key);
    });
  }

  set(key: RedisKey, value: string, ttlSeconds: number): Promise<void> {
    return Promise.resolve().then(() => {
      assertKeyPrefix(this.keyPrefix, key);
      assertPositiveInteger("ttlSeconds", ttlSeconds);
      this.entries.put(key, value, ttlSeconds * 1000);
    });
  }

  delete(key: RedisKey): Promise<boolean> {
    return Promise.resolve().then(() => {
      assertKeyPrefix(this.keyPrefix, key);
      return this.entries.remove(key);
    });
  }
}
