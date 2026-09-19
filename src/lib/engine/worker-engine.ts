/**
 * The browser path: a `SqlEngine` over `PgliteWorkerClient`. DOM-free; the real worker comes from
 * `worker/create-worker.ts`.
 *
 * Every call has the client's timeout (the probe timeout of rules.yaml by default). A call that
 * exceeds it terminates the worker and rejects with `EngineTimeoutError`; whatever else was in
 * flight rejects with `EngineTerminatedError`. The engine stays usable, but **the next call boots
 * a new worker with an EMPTY database**: the caller replays `setupDatabase` and marks the probe
 * `inconclusive`. An open transaction dies with its worker and its handle is closed.
 *
 * Booting Postgres (download, WASM start) takes longer than a probe may, so the first call on
 * every new worker is preceded by `init` with the client's own, longer, init timeout. `init` is
 * never sent without one: a failed WASM load hangs `PGlite.create()` (ADR 0003).
 */
import type { SqlEngine } from "@/lib/runner/types";
import { createProtocolEngine, type EngineTransport } from "./protocol-engine";
import type { PgliteWorkerClient } from "./worker/client";

/** The part of `PgliteWorkerClient` the engine uses. */
export type WorkerClientLike = Pick<
  PgliteWorkerClient,
  "init" | "exec" | "query" | "dispose" | "alive" | "generation"
>;

export function createWorkerTransport(client: WorkerClientLike): EngineTransport {
  let boot: { readonly generation: number; readonly done: Promise<unknown> } | null = null;

  const ready = (): Promise<unknown> => {
    if (boot === null || !client.alive || boot.generation !== client.generation) {
      // `init` creates the worker synchronously, so `generation` is already the new one here.
      const done = client.init();
      const started = { generation: client.generation, done };
      boot = started;
      done.catch(() => {
        // A failed boot is retried by the next call instead of being remembered.
        if (boot === started) {
          boot = null;
        }
      });
    }
    return boot.done;
  };

  return {
    exec: async (sql) => {
      await ready();
      return client.exec(sql);
    },
    query: async (sql, params) => {
      await ready();
      return client.query(sql, params);
    },
    close: async () => {
      boot = null;
      client.dispose();
    },
  };
}

/**
 * One engine per run: `close()` terminates the worker. After a timeout the same engine answers
 * again from a new, empty database.
 */
export function createWorkerEngine(client: WorkerClientLike): SqlEngine {
  return createProtocolEngine(createWorkerTransport(client));
}
