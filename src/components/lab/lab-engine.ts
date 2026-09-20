"use client";

/**
 * The one place of the lab that reaches the engine (SEC-004: a `"use client"` module). PGlite,
 * the worker and the Supabase shim are loaded with `import()` on first use, so they are in no
 * chunk of any other page and not even in the lab's first paint.
 */
import { PROBE_TIMEOUT_MS, type LabRunPorts } from "@/lib/lab";

let ports: Promise<LabRunPorts> | null = null;

/** A fresh worker, so a fresh in-memory Postgres, per `createEngine()` call. */
export function loadLabPorts(): Promise<LabRunPorts> {
  if (ports === null) {
    const loading = Promise.all([
      import("@/lib/engine/worker/create-worker"),
      import("@/lib/engine/supabase-setup-sql"),
    ]).then(([worker, setup]): LabRunPorts => ({
      createEngine: async () => {
        const { engine, client } = worker.createPgliteWorkerEngine({
          execTimeoutMs: PROBE_TIMEOUT_MS,
        });
        // `dispose` terminates the worker at once; `engine.close()` would wait its turn.
        return { engine, terminate: () => client.dispose() };
      },
      supabase: setup.SUPABASE_SETUP_SQL,
    }));
    ports = loading;
    // A failed chunk load is retried by the next run instead of being remembered.
    loading.catch(() => {
      if (ports === loading) {
        ports = null;
      }
    });
  }
  return ports;
}
