/**
 * Browser-only. The `new Worker(new URL(..., import.meta.url))` form is the one
 * both Turbopack and webpack recognise statically; it must stay a literal.
 *
 * Import this module with a dynamic `import()` from a client component so the
 * worker and PGlite never reach a page that does not use them.
 */
import type { SqlEngine } from "@/lib/runner/types";
import { createWorkerEngine } from "../worker-engine";
import { PgliteWorkerClient, type WorkerClientOptions } from "./client";

export function createPgliteWorker(): Worker {
  return new Worker(new URL("./pglite.worker.ts", import.meta.url), {
    type: "module",
    name: "pglite",
  });
}

export function createPgliteWorkerClient(options?: WorkerClientOptions): PgliteWorkerClient {
  return new PgliteWorkerClient(createPgliteWorker, options);
}

/**
 * The browser's `SqlEngine`: a fresh worker, so a fresh in-memory Postgres. Create one per run and
 * `close()` it afterwards. `client` is exposed for the UI (`generation` grows after a timeout).
 */
export function createPgliteWorkerEngine(options?: WorkerClientOptions): {
  readonly engine: SqlEngine;
  readonly client: PgliteWorkerClient;
} {
  const client = createPgliteWorkerClient(options);
  return { engine: createWorkerEngine(client), client };
}
