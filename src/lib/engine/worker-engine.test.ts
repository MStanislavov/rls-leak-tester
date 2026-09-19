import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineError, EngineTimeoutError, SqlError } from "@/lib/runner/types";
import { createWorkerEngine } from "./worker-engine";
import { PgliteWorkerClient, type WorkerLike } from "./worker/client";
import type { WorkerRequest, WorkerResponse } from "./worker/protocol";

type Script = (request: WorkerRequest) => WorkerResponse | "hang";

/** A worker that answers from a script on the next task, or never (a runaway query). */
class ScriptedWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = [];
  terminated = false;
  private listener: ((event: { data: unknown }) => void) | null = null;

  constructor(private readonly script: Script) {}

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
    const answer = this.script(message);
    if (answer !== "hang") {
      setTimeout(() => this.listener?.({ data: answer }), 0);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: "message" | "error", listener: (event: never) => void): void {
    if (type === "message") {
      this.listener = listener as (event: { data: unknown }) => void;
    }
  }
}

const answer: Script = (request) => {
  switch (request.type) {
    case "init":
      return {
        id: request.id,
        ok: true,
        type: "init",
        result: { version: "PostgreSQL 18.3", startupMs: 1 },
      };
    case "exec":
      return { id: request.id, ok: true, type: "exec", results: [] };
    case "query":
      return {
        id: request.id,
        ok: true,
        type: "query",
        result: { fields: [{ name: "n", dataTypeId: 23 }], rows: [[1]], affectedRows: 0 },
      };
    case "close":
      return { id: request.id, ok: true, type: "close" };
  }
};

function setup(script: Script, options?: ConstructorParameters<typeof PgliteWorkerClient>[1]) {
  const workers: ScriptedWorker[] = [];
  const client = new PgliteWorkerClient(() => {
    const worker = new ScriptedWorker(script);
    workers.push(worker);
    return worker;
  }, options);
  return { engine: createWorkerEngine(client), client, workers };
}

const types = (worker: ScriptedWorker | undefined) => worker?.sent.map((message) => message.type);

/**
 * Lets the scripted answers and the promise chains between them run. Rounds of 1 ms, not 0:
 * measured with Vitest 5 fake timers, `advanceTimersByTimeAsync(0)` does not fire a zero-delay
 * timer that was created during an earlier zero-length advance, so the second answer of a chain
 * (init, then the statement) would never arrive. Ten rounds stay far below every timeout used here.
 */
async function rounds(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

async function settle<T>(work: Promise<T>): Promise<T> {
  const outcome = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await rounds();
  const result = await outcome;
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkerEngine", () => {
  it("boots the worker with init once, before the first statement", async () => {
    const { engine, client, workers } = setup(answer);
    expect(client.alive).toBe(false);

    await expect(settle(engine.query("select 1 as n"))).resolves.toEqual({
      rows: [{ n: 1 }],
      affectedRows: 0,
    });
    await settle(engine.exec("select 2"));

    expect(workers).toHaveLength(1);
    expect(types(workers[0])).toEqual(["init", "query", "exec"]);
  });

  it("gives init its own, longer timeout: a slow boot is not a probe timeout", async () => {
    const { engine, workers } = setup(
      (request) => (request.type === "init" ? "hang" : answer(request)),
      { execTimeoutMs: 1_000, initTimeoutMs: 30_000 },
    );
    const pending = engine.query("select 1");
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    // Five seconds in, well past the exec timeout, and nothing was terminated.
    expect(workers[0]?.terminated).toBe(false);
    expect(types(workers[0])).toEqual(["init"]);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(await caught).toBeInstanceOf(EngineTimeoutError);
    expect(await caught).toMatchObject({ timeoutMs: 30_000 });
    expect(workers[0]?.terminated).toBe(true);
  });

  it("terminates the worker on a runaway statement and starts from an empty database afterwards", async () => {
    const { engine, client, workers } = setup(
      (request) =>
        request.type === "query" && request.sql.includes("pg_sleep") ? "hang" : answer(request),
      { execTimeoutMs: 5_000 },
    );
    await settle(engine.exec("create table t (n int)"));

    const runaway = engine.query("select pg_sleep(60)").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await runaway;
    expect(error).toBeInstanceOf(EngineTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 5_000, databaseLost: true });
    expect(workers[0]?.terminated).toBe(true);
    expect(client.alive).toBe(false);

    // Same engine object, new worker: it is booted again before the statement is sent.
    await settle(engine.query("select 1"));
    expect(workers).toHaveLength(2);
    expect(client.generation).toBe(2);
    expect(types(workers[1])).toEqual(["init", "query"]);
  });

  it("ends an open transaction with its worker and never sends ROLLBACK to the new one", async () => {
    const { engine, workers } = setup(
      (request) =>
        request.type === "query" && request.sql.includes("pg_sleep") ? "hang" : answer(request),
      { execTimeoutMs: 5_000 },
    );
    const run = engine
      .transaction(async (tx) => {
        try {
          await tx.query("select set_config('role', $1, true)", ["authenticated"]);
          await tx.query("select pg_sleep(60)");
        } finally {
          await tx.rollback();
        }
      })
      .catch((error: unknown) => error);
    await rounds();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await run).toBeInstanceOf(EngineTimeoutError);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.sent.map((m) => ("sql" in m ? m.sql : m.type))).toEqual([
      "init",
      "BEGIN",
      "select set_config('role', $1, true)",
      "select pg_sleep(60)",
    ]);
  });

  it("maps a Postgres error to SqlError and keeps the worker", async () => {
    const { engine, client, workers } = setup((request) =>
      request.type === "query"
        ? {
            id: request.id,
            ok: false,
            error: {
              message: "permission denied for table notes",
              code: "42501",
              detail: null,
              hint: null,
              position: null,
            },
          }
        : answer(request),
    );
    const error = await settle(engine.query("select * from notes")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SqlError);
    expect(error).toMatchObject({ code: "42501", message: "permission denied for table notes" });
    expect(client.alive).toBe(true);
    expect(workers[0]?.terminated).toBe(false);
  });

  it("retries a failed boot on the next call instead of remembering it", async () => {
    let boots = 0;
    const { engine, workers } = setup((request) => {
      if (request.type === "init") {
        boots += 1;
        if (boots === 1) {
          return {
            id: request.id,
            ok: false,
            error: {
              message: "wasm failed to load",
              code: null,
              detail: null,
              hint: null,
              position: null,
            },
          };
        }
      }
      return answer(request);
    });
    const first = await settle(engine.query("select 1")).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(EngineError);
    expect(first).not.toBeInstanceOf(SqlError);
    expect(first).toMatchObject({ message: "wasm failed to load" });

    await expect(settle(engine.query("select 1"))).resolves.toMatchObject({ rows: [{ n: 1 }] });
    expect(boots).toBe(2);
    expect(types(workers[0])).toEqual(["init", "init", "query"]);
  });

  it("close terminates the worker", async () => {
    const { engine, client, workers } = setup(answer);
    await settle(engine.exec("select 1"));
    await settle(engine.close());
    expect(workers[0]?.terminated).toBe(true);
    expect(client.alive).toBe(false);
  });
});
