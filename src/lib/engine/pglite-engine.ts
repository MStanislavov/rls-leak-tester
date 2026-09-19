/**
 * The in-process PGlite adapter: a `SqlEngine` on a FRESH in-memory Postgres, for Node (tests, a
 * future CLI). It drives the same request handler the Web Worker runs, without `postMessage`, so
 * Node and the browser share every line between the port and PGlite.
 *
 * There is no timeout here: PGlite cannot cancel a query and a running query blocks its thread
 * (ADR 0002). Only the worker path (`worker-engine.ts`) can end a runaway statement.
 */
import { PGlite } from "@electric-sql/pglite";
import type { SqlEngine } from "@/lib/runner/types";
import { createProtocolEngine, type EngineTransport } from "./protocol-engine";
import { SqlExecutionError, WorkerTerminatedError } from "./worker/client";
import { createRequestHandler, type DatabaseFactory, type RequestHandler } from "./worker/handler";
import type { WorkerRequest, WorkerResponse } from "./worker/protocol";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type OkResponse = Extract<WorkerResponse, { ok: true }>;

/** Calls the handler directly. Responses are unwrapped exactly as `PgliteWorkerClient` does. */
export function createLoopbackTransport(handle: RequestHandler): EngineTransport {
  let nextId = 1;

  const request = async <T extends OkResponse["type"]>(
    message: DistributiveOmit<WorkerRequest, "id">,
    type: T,
  ): Promise<Extract<OkResponse, { type: T }>> => {
    const response = await handle({ ...message, id: nextId++ } as WorkerRequest);
    if (!response.ok) {
      throw new SqlExecutionError(response.error);
    }
    if (response.type !== type) {
      throw new WorkerTerminatedError("The database handler sent a response of the wrong type");
    }
    return response as Extract<OkResponse, { type: T }>;
  };

  return {
    exec: async (sql) => (await request({ type: "exec", sql }, "exec")).results,
    query: async (sql, params) => (await request({ type: "query", sql, params }, "query")).result,
    close: async () => {
      await request({ type: "close" }, "close");
    },
  };
}

/**
 * Starts a fresh in-memory Postgres and resolves once it answers. Every call is a new, empty
 * database; `close()` releases it (an open instance holds roughly 160 MB in Node).
 */
export async function createPgliteEngine(
  createDatabase: DatabaseFactory = () => PGlite.create(),
): Promise<SqlEngine> {
  const handle = createRequestHandler(createDatabase);
  const started = await handle({ id: 0, type: "init" });
  if (!started.ok) {
    throw new SqlExecutionError(started.error);
  }
  return createProtocolEngine(createLoopbackTransport(handle));
}
