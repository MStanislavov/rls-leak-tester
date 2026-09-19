/**
 * One lazily connected ioredis client, built to fail fast.
 *
 * - `lazyConnect`: nothing connects until the first command, so importing the
 *   module or building the services costs nothing (and `next build` needs no Redis).
 * - No offline queue and no automatic reconnect: a command never waits in memory
 *   for a server that is gone. When the connection is lost the client goes to
 *   `end`, and the next command opens it again, on demand.
 * - Concurrent commands share one connection attempt, and after a failed attempt
 *   the next ones are refused for `reconnectCooldownMs` instead of queueing up
 *   behind a connect timeout each.
 * - `redis://` and `rediss://` both work: ioredis switches TLS on for `rediss:`.
 *
 * Every failure leaves as `RedisUnavailableError`, whose message carries the
 * operation name only: never the URL, which may hold a password.
 */
import Redis, { type RedisOptions } from "ioredis";

import { RedisUnavailableError } from "../../errors";
import type { Clock } from "../../ports";

/** The part of ioredis the adapters use. A test passes a fake with these members. */
export type RedisClient = Pick<
  Redis,
  "status" | "connect" | "disconnect" | "on" | "get" | "set" | "del" | "eval"
>;

export interface RedisConnectionOptions {
  /** `redis://` or `rediss://`, validated by `src/lib/config`. */
  readonly url: string;
  readonly connectTimeoutMs?: number | undefined;
  readonly commandTimeoutMs?: number | undefined;
  readonly reconnectCooldownMs?: number | undefined;
  /** Defaults to `Date.now`. */
  readonly clock?: Clock | undefined;
  /** Defaults to a real ioredis client. */
  readonly createClient?: ((url: string, options: RedisOptions) => RedisClient) | undefined;
}

export const REDIS_CONNECTION_DEFAULTS = {
  connectTimeoutMs: 2000,
  commandTimeoutMs: 2000,
  reconnectCooldownMs: 1000,
} as const;

/** Pure: the ioredis options of the fail-fast policy described above. */
export function buildClientOptions(
  connectTimeoutMs: number,
  commandTimeoutMs: number,
): RedisOptions {
  return {
    lazyConnect: true,
    connectTimeout: connectTimeoutMs,
    commandTimeout: commandTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    autoResendUnfulfilledCommands: false,
    autoResubscribe: false,
  };
}

export class RedisConnection {
  private readonly options: RedisConnectionOptions;
  private readonly clock: Clock;
  private readonly cooldownMs: number;
  private client: RedisClient | undefined;
  private connecting: Promise<void> | undefined;
  private retryAt = 0;

  constructor(options: RedisConnectionOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
    this.cooldownMs = options.reconnectCooldownMs ?? REDIS_CONNECTION_DEFAULTS.reconnectCooldownMs;
  }

  /** Runs one command on a ready client. Rejects with `RedisUnavailableError` only. */
  async run<T>(operation: string, command: (client: RedisClient) => Promise<T>): Promise<T> {
    try {
      const client = await this.readyClient();
      return await command(client);
    } catch (error) {
      throw new RedisUnavailableError(operation, error);
    }
  }

  /** Drops the connection. The next command opens a new one. */
  close(): void {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    this.retryAt = 0;
    client?.disconnect();
  }

  private async readyClient(): Promise<RedisClient> {
    const client = (this.client ??= this.open());
    if (client.status === "ready") return client;
    await (this.connecting ?? this.connect(client));
    return client;
  }

  private open(): RedisClient {
    const create = this.options.createClient ?? ((url, options) => new Redis(url, options));
    const client = create(
      this.options.url,
      buildClientOptions(
        this.options.connectTimeoutMs ?? REDIS_CONNECTION_DEFAULTS.connectTimeoutMs,
        this.options.commandTimeoutMs ?? REDIS_CONNECTION_DEFAULTS.commandTimeoutMs,
      ),
    );
    // Without a listener ioredis prints every connection error to the console. The
    // error itself reaches the caller through the rejected command or connect().
    client.on("error", () => undefined);
    return client;
  }

  private connect(client: RedisClient): Promise<void> {
    if (this.clock() < this.retryAt) {
      return Promise.reject(new Error("The last connection attempt failed; not retrying yet"));
    }
    const attempt: Promise<void> = client
      .connect()
      .catch((error: unknown) => {
        // A client that close() already dropped says nothing about the next one.
        if (this.client === client) this.retryAt = this.clock() + this.cooldownMs;
        throw error;
      })
      .finally(() => {
        // After close() a newer attempt may be in flight; only clear our own.
        if (this.connecting === attempt) this.connecting = undefined;
      });
    this.connecting = attempt;
    return attempt;
  }
}
