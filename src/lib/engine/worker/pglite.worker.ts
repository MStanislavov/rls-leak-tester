/**
 * Web Worker entry. Thin glue only: the logic lives in `handler.ts`.
 *
 * The bundler follows PGlite's own `new URL("./pglite.wasm", import.meta.url)`
 * references and emits `pglite.wasm`, `initdb.wasm` and `pglite.data` as hashed
 * static files, so nothing is copied into `public/`.
 */
import { PGlite } from "@electric-sql/pglite";
import { createRequestHandler } from "./handler";
import { isWorkerRequest, type WorkerResponse } from "./protocol";

/** The part of `DedicatedWorkerGlobalScope` used here; the DOM lib types `self` as `Window`. */
interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

const scope = self as unknown as WorkerScope;

// In-memory database: a fresh worker is a fresh, empty Postgres.
const handle = createRequestHandler(() => PGlite.create());

scope.addEventListener("message", (event) => {
  if (!isWorkerRequest(event.data)) {
    return;
  }
  void handle(event.data).then((response) => {
    scope.postMessage(response);
  });
});
