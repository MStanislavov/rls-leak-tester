/**
 * A map whose entries expire, the in-memory stand-in for a Redis keyspace.
 *
 * Expiry is lazy (checked on read) and the size is bounded: a write into a full
 * map first drops what has expired and then the oldest entries, so a long-running
 * dev server cannot grow without limit. The clock is injected.
 */
import { assertPositiveInteger, type Clock } from "../../ports";

export const DEFAULT_MAX_ENTRIES = 10_000;

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

export class TtlMap<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly clock: Clock;
  private readonly maxEntries: number;

  constructor(clock: Clock, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    assertPositiveInteger("maxEntries", maxEntries);
    this.clock = clock;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Writes or replaces an entry. There is no write without a TTL. */
  put(key: string, value: V, ttlMs: number): void {
    assertPositiveInteger("ttlMs", ttlMs);
    // Delete first, so that a replaced key moves to the young end of the insertion order.
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) this.evict();
    this.entries.set(key, { value, expiresAt: this.clock() + ttlMs });
  }

  remove(key: string): boolean {
    const live = this.get(key) !== undefined;
    this.entries.delete(key);
    return live;
  }

  /** Milliseconds left, or `undefined` for a missing or expired key. */
  ttlMs(key: string): number | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    const left = entry.expiresAt - this.clock();
    return left > 0 ? left : undefined;
  }

  /** The keys that have not expired. */
  keys(): string[] {
    const now = this.clock();
    return [...this.entries].filter(([, entry]) => entry.expiresAt > now).map(([key]) => key);
  }

  private evict(): void {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
