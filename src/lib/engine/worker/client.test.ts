import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  PgliteWorkerClient,
  SqlExecutionError,
  WorkerTerminatedError,
  WorkerTimeoutError,
  type WorkerLike,
} from "./client";
import type { WorkerRequest, WorkerResponse } from "./protocol";

/** A scriptable stand-in for the DOM Worker. */
class FakeWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = [];
  terminated = false;
  private messageListener: ((event: { data: unknown }) => void) | null = null;
  private errorListener: ((event: { message?: string }) => void) | null = null;

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: "message" | "error", listener: (event: never) => void): void {
    if (type === "message") {
      this.messageListener = listener as (event: { data: unknown }) => void;
    } else {
      this.errorListener = listener as (event: { message?: string }) => void;
    }
  }

  reply(data: unknown): void {
    this.messageListener?.({ data });
  }

  crash(message?: string): void {
    this.errorListener?.({ message });
  }

  lastId(): number {
    const last = this.sent.at(-1);
    if (!last) {
      throw new Error("nothing was sent");
    }
    return last.id;
  }
}

function setup(options?: ConstructorParameters<typeof PgliteWorkerClient>[1]) {
  const workers: FakeWorker[] = [];
  const client = new PgliteWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, options);
  const current = (): FakeWorker => {
    const worker = workers.at(-1);
    if (!worker) {
      throw new Error("no worker was created");
    }
    return worker;
  };
  return { client, workers, current };
}

const execOk = (id: number): WorkerResponse => ({
  id,
  ok: true,
  type: "exec",
  results: [{ fields: [{ name: "n", dataTypeId: 23 }], rows: [[1]], affectedRows: 0 }],
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PgliteWorkerClient", () => {
  it("creates the worker lazily and only once", async () => {
    const { client, workers, current } = setup();
    expect(client.generation).toBe(0);
    expect(client.alive).toBe(false);

    const first = client.exec("select 1");
    current().reply(execOk(current().lastId()));
    await first;
    const second = client.exec("select 2");
    current().reply(execOk(current().lastId()));
    await second;

    expect(workers).toHaveLength(1);
    expect(client.generation).toBe(1);
    expect(client.alive).toBe(true);
    expect(current().sent.map((message) => message.type)).toEqual(["exec", "exec"]);
  });

  it("resolves init with the version and start-up time", async () => {
    const { client, current } = setup();
    const pending = client.init();
    current().reply({
      id: current().lastId(),
      ok: true,
      type: "init",
      result: { version: "PostgreSQL 18.3", startupMs: 900 },
    });
    await expect(pending).resolves.toEqual({ version: "PostgreSQL 18.3", startupMs: 900 });
  });

  it("matches responses to requests by id, in any order", async () => {
    const { client, current } = setup();
    const a = client.exec("select 'a'");
    const idA = current().lastId();
    const b = client.exec("select 'b'");
    const idB = current().lastId();

    current().reply({ ...execOk(idB), results: [] });
    current().reply(execOk(idA));

    await expect(b).resolves.toEqual([]);
    await expect(a).resolves.toHaveLength(1);
  });

  it("sends query with its parameters and resolves the single result set", async () => {
    const { client, current } = setup();
    const pending = client.query("select $1::int as n", [7]);
    expect(current().sent.at(-1)).toEqual({
      id: current().lastId(),
      type: "query",
      sql: "select $1::int as n",
      params: [7],
    });
    current().reply({
      id: current().lastId(),
      ok: true,
      type: "query",
      result: { fields: [{ name: "n", dataTypeId: 23 }], rows: [[7]], affectedRows: 0 },
    });
    await expect(pending).resolves.toEqual({
      fields: [{ name: "n", dataTypeId: 23 }],
      rows: [[7]],
      affectedRows: 0,
    });

    // No parameters is an empty list on the wire, never undefined.
    const bare = client.query("select 1");
    expect(current().sent.at(-1)).toMatchObject({ type: "query", params: [] });
    current().reply(execOk(current().lastId()));
    // An exec-shaped answer to a query is a protocol failure, not a result.
    await expect(bare).rejects.toBeInstanceOf(WorkerTerminatedError);
  });

  it("times a query out like an exec: the worker is terminated", async () => {
    const { client, current } = setup({ execTimeoutMs: 1_000 });
    const pending = client.query("select pg_sleep(10)");
    const first = current();
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await caught;
    expect(error).toBeInstanceOf(WorkerTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 1_000 });
    expect(first.terminated).toBe(true);
    expect(client.alive).toBe(false);
  });

  it("turns a worker-side failure into SqlExecutionError with the SQLSTATE", async () => {
    const { client, current } = setup();
    const pending = client.exec("select * from missing");
    current().reply({
      id: current().lastId(),
      ok: false,
      error: {
        message: 'relation "missing" does not exist',
        code: "42P01",
        detail: null,
        hint: null,
        position: "15",
      },
    });
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SqlExecutionError);
    expect(error).toMatchObject({ code: "42P01", position: "15" });
    // A SQL error is not a reason to lose the database.
    expect(client.alive).toBe(true);
    expect(current().terminated).toBe(false);
  });

  it("terminates the worker on timeout and rejects with WorkerTimeoutError", async () => {
    const { client, current } = setup();
    const pending = client.exec("select pg_sleep(10)", 1_500);
    const rejection = expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(current().terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(current().terminated).toBe(true);
    expect(client.alive).toBe(false);
  });

  it("rejects everything else in flight when one request times out", async () => {
    const { client } = setup();
    const slow = client.exec("select pg_sleep(10)", 1_000);
    const queuedBehindIt = client.exec("select 1", 60_000);
    const slowRejection = expect(slow).rejects.toBeInstanceOf(WorkerTimeoutError);
    const queuedRejection = expect(queuedBehindIt).rejects.toBeInstanceOf(WorkerTerminatedError);

    await vi.advanceTimersByTimeAsync(1_000);

    await slowRejection;
    await queuedRejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a new worker for the next request after a timeout", async () => {
    const { client, workers, current } = setup();
    const slow = client.exec("select pg_sleep(10)", 1_000);
    const rejection = expect(slow).rejects.toBeInstanceOf(WorkerTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    const dead = current();

    const next = client.exec("select 1");
    expect(workers).toHaveLength(2);
    expect(client.generation).toBe(2);
    expect(current()).not.toBe(dead);

    // A late answer from the terminated worker must not resolve anything.
    dead.reply(execOk(current().lastId()));
    current().reply(execOk(current().lastId()));
    await expect(next).resolves.toHaveLength(1);
  });

  it("uses the default exec timeout when none is given", async () => {
    const { client, current } = setup();
    const pending = client.exec("select 1");
    const rejection = expect(pending).rejects.toMatchObject({ timeoutMs: DEFAULT_EXEC_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(DEFAULT_EXEC_TIMEOUT_MS);
    await rejection;
    expect(current().terminated).toBe(true);
  });

  it("honours timeouts from the constructor options", async () => {
    const { client } = setup({ execTimeoutMs: 50, initTimeoutMs: 80 });
    const exec = expect(client.exec("select 1")).rejects.toMatchObject({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await exec;
    const init = expect(client.init()).rejects.toMatchObject({ timeoutMs: 80 });
    await vi.advanceTimersByTimeAsync(80);
    await init;
  });

  it("clears the timer when the answer arrives in time", async () => {
    const { client, current } = setup();
    const pending = client.exec("select 1", 1_000);
    current().reply(execOk(current().lastId()));
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current().terminated).toBe(false);
  });

  it("rejects in-flight requests when the worker crashes, then recovers", async () => {
    const { client, workers, current } = setup();
    const pending = client.exec("select 1");
    const rejection = expect(pending).rejects.toThrow(/crashed: out of memory/);
    current().crash("out of memory");
    await rejection;
    expect(current().terminated).toBe(true);

    const pendingWithoutMessage = client.exec("select 1");
    const second = expect(pendingWithoutMessage).rejects.toThrow(/crashed: unknown/);
    current().crash();
    await second;
    expect(workers).toHaveLength(2);
  });

  it("ignores malformed messages and unknown ids", async () => {
    const { client, current } = setup();
    const pending = client.exec("select 1");
    current().reply("not a response");
    current().reply({ id: 9_999, ok: true, type: "exec", results: [] });
    current().reply(execOk(current().lastId()));
    await expect(pending).resolves.toHaveLength(1);
  });

  it("rejects a response whose type does not match the request", async () => {
    const { client, current } = setup();
    const pending = client.init();
    current().reply(execOk(current().lastId()));
    await expect(pending).rejects.toBeInstanceOf(WorkerTerminatedError);

    const exec = client.exec("select 1");
    current().reply({
      id: current().lastId(),
      ok: true,
      type: "init",
      result: { version: "x", startupMs: 1 },
    });
    await expect(exec).rejects.toBeInstanceOf(WorkerTerminatedError);
  });

  it("dispose terminates the worker, rejects what is pending and stays usable", async () => {
    const { client, workers, current } = setup();
    const pending = client.exec("select 1");
    const rejection = expect(pending).rejects.toBeInstanceOf(WorkerTerminatedError);
    client.dispose();
    await rejection;
    expect(current().terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    client.dispose(); // harmless when there is no worker

    const again = client.exec("select 1");
    current().reply(execOk(current().lastId()));
    await expect(again).resolves.toHaveLength(1);
    expect(workers).toHaveLength(2);
  });
});
