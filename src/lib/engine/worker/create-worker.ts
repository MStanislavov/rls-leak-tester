/**
 * Browser-only. The `new Worker(new URL(..., import.meta.url))` form is the one
 * both Turbopack and webpack recognise statically; it must stay a literal.
 *
 * Import this module with a dynamic `import()` from a client component so the
 * worker and PGlite never reach a page that does not use them.
 */
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
