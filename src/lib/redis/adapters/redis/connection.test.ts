import type { RedisOptions } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import { RedisUnavailableError } from "../../errors";
import {
  REDIS_CONNECTION_DEFAULTS,
  RedisConnection,
  buildClientOptions,
  type RedisClient,
} from "./connection";

interface FakeClient {
  status: string;
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  disconnect: ReturnType<typeof vi.fn<() => void>>;
  on: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn<(key: string) => Promise<string | null>>>;
}

function fakeClient(): FakeClient {
  const client: FakeClient = {
    status: "wait",
    connect: vi.fn(() => {
      client.status = "ready";
      return Promise.resolve();
    }),
    disconnect: vi.fn(() => {
      client.status = "end";
    }),
    on: vi.fn(),
    get: vi.fn(() => Promise.resolve("value")),
  };
  return client;
}

type CreateClient = (url: string, options: RedisOptions) => RedisClient;

/** The fake has the members the connection touches; the cast is the seam of the test. */
const asClient = (client: FakeClient): RedisClient => client as unknown as RedisClient;

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("buildClientOptions", () => {
  it("is lazy, has no offline queue and never retries on its own", () => {
    const options = buildClientOptions(1500, 900);
    expect(options).toMatchObject({
      lazyConnect: true,
      connectTimeout: 1500,
      commandTimeout: 900,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
    });
    expect(options.retryStrategy?.(1)).toBeNull();
    expect(options.retryStrategy?.(50)).toBeNull();
  });
});

describe("RedisConnection", () => {
  it("creates no client until the first command, then one with the fail-fast options", async () => {
    const client = fakeClient();
    const createClient = vi.fn<CreateClient>(() => asClient(client));
    const connection = new RedisConnection({ url: "rediss://cache.example:6380", createClient });
    expect(createClient).not.toHaveBeenCalled();

    expect(await connection.run("cache.get", (redis) => redis.get("k"))).toBe("value");
    await connection.run("cache.get", (redis) => redis.get("k"));

    expect(createClient).toHaveBeenCalledTimes(1);
    const [url, options] = createClient.mock.calls[0] ?? [];
    expect(url).toBe("rediss://cache.example:6380");
    expect(options).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: REDIS_CONNECTION_DEFAULTS.connectTimeoutMs,
      commandTimeout: REDIS_CONNECTION_DEFAULTS.commandTimeoutMs,
    });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
    const listener: unknown = client.on.mock.calls[0]?.[1];
    expect(typeof listener === "function" && listener(new Error("ignored"))).toBeUndefined();
  });

  it("passes custom timeouts on", async () => {
    const createClient = vi.fn<CreateClient>(() => asClient(fakeClient()));
    const connection = new RedisConnection({
      url: "redis://127.0.0.1:6379",
      connectTimeoutMs: 111,
      commandTimeoutMs: 222,
      createClient,
    });
    await connection.run("cache.get", (redis) => redis.get("k"));
    expect(createClient.mock.calls[0]?.[1]).toMatchObject({
      connectTimeout: 111,
      commandTimeout: 222,
    });
  });

  it("shares one connection attempt between concurrent commands", async () => {
    const client = fakeClient();
    const gate = deferred();
    client.connect.mockImplementation(() =>
      gate.promise.then(() => {
        client.status = "ready";
      }),
    );
    const connection = new RedisConnection({
      url: "redis://127.0.0.1:6379",
      createClient: () => asClient(client),
    });

    const commands = [1, 2, 3].map(() => connection.run("cache.get", (redis) => redis.get("k")));
    gate.resolve();
    expect(await Promise.all(commands)).toEqual(["value", "value", "value"]);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("wraps a failed command, cause included, and names only the operation", async () => {
    const client = fakeClient();
    const cause = new Error("Command timed out");
    client.get.mockRejectedValue(cause);
    const connection = new RedisConnection({
      url: "redis://127.0.0.1:6379",
      createClient: () => asClient(client),
    });

    const error: unknown = await connection
      .run("cache.get", (redis) => redis.get("k"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(error).toMatchObject({ operation: "cache.get", cause });
  });

  it("fails fast after a failed connection, and tries again after the cool-down", async () => {
    let now = 10_000;
    const client = fakeClient();
    client.connect.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const connection = new RedisConnection({
      url: "redis://127.0.0.1:6379",
      reconnectCooldownMs: 500,
      clock: () => now,
      createClient: () => asClient(client),
    });
    const get = () => connection.run("cache.get", (redis) => redis.get("k"));

    await expect(get()).rejects.toMatchObject({
      name: "RedisUnavailableError",
      cause: new Error("connect ECONNREFUSED"),
    });
    expect(client.connect).toHaveBeenCalledTimes(1);

    now += 499;
    await expect(get()).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(client.connect, "no attempt during the cool-down").toHaveBeenCalledTimes(1);

    now += 1;
    expect(await get()).toBe("value");
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it("opens the connection again, on demand, after it was lost", async () => {
    const client = fakeClient();
    const connection = new RedisConnection({
      url: "redis://127.0.0.1:6379",
      createClient: () => asClient(client),
    });
    await connection.run("cache.get", (redis) => redis.get("k"));

    client.status = "end";
    expect(await connection.run("cache.get", (redis) => redis.get("k"))).toBe("value");
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it("close() drops the client; the next command builds a new one", async () => {
    const clients = [fakeClient(), fakeClient()];
    const createClient = vi.fn(() =>
      asClient(clients[createClient.mock.calls.length - 1] ?? fakeClient()),
    );
    const connection = new RedisConnection({ url: "redis://127.0.0.1:6379", createClient });

    connection.close();
    expect(createClient, "closing an unused connection does nothing").not.toHaveBeenCalled();

    await connection.run("cache.get", (redis) => redis.get("k"));
    connection.close();
    expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);

    await connection.run("cache.get", (redis) => redis.get("k"));
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(clients[1]?.connect).toHaveBeenCalledTimes(1);
  });

  it("close() during a connection attempt does not disturb the attempt of the next client", async () => {
    const first = fakeClient();
    const second = fakeClient();
    const firstGate = deferred();
    const secondGate = deferred();
    first.connect.mockImplementation(() => firstGate.promise);
    second.connect.mockImplementation(() =>
      secondGate.promise.then(() => {
        second.status = "ready";
      }),
    );
    const queue = [first, second];
    const connection = new RedisConnection({
      url: "redis://127.0.0.1:6379",
      createClient: () => asClient(queue.shift() ?? fakeClient()),
    });
    const get = () => connection.run("cache.get", (redis) => redis.get("k"));

    const abandoned = get();
    connection.close();
    const onSecond = get();
    firstGate.reject(new Error("Connection is closed."));
    await expect(abandoned).rejects.toBeInstanceOf(RedisUnavailableError);

    // The old attempt has settled; a third command must still join the second attempt.
    const joined = get();
    secondGate.resolve();
    expect(await Promise.all([onSecond, joined])).toEqual(["value", "value"]);
    expect(second.connect).toHaveBeenCalledTimes(1);

    // Nor does the failure of the dropped client start a cool-down for the new one.
    second.status = "end";
    expect(await get()).toBe("value");
    expect(second.connect).toHaveBeenCalledTimes(2);
  });
});
