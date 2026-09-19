/**
 * Message protocol between the page and the PGlite Web Worker.
 *
 * Everything that crosses `postMessage` is plain data: no class instances, no
 * functions, no `bigint`. Cells are normalised inside the worker so both sides
 * see the same deterministic shape.
 */

/** One value of a result row. `bigint`, dates, bytes and JSON arrive as strings. */
export type SqlCell = string | number | boolean | null;

export interface SqlField {
  readonly name: string;
  readonly dataTypeId: number;
}

/** The result of one statement. Rows are arrays in field order. */
export interface SqlResultSet {
  readonly fields: readonly SqlField[];
  readonly rows: ReadonlyArray<readonly SqlCell[]>;
  readonly affectedRows: number;
}

/** A failure inside the worker. `code` is the SQLSTATE when Postgres raised it. */
export interface SqlErrorInfo {
  readonly message: string;
  readonly code: string | null;
  readonly detail: string | null;
  readonly hint: string | null;
  readonly position: string | null;
}

export type WorkerRequest =
  | { readonly id: number; readonly type: "init" }
  | { readonly id: number; readonly type: "exec"; readonly sql: string };

export type WorkerRequestType = WorkerRequest["type"];

export interface InitResult {
  /** `select version()`, which proves a real Postgres answered. */
  readonly version: string;
  /** Milliseconds from the start of `PGlite.create()` to the first answer. */
  readonly startupMs: number;
}

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly type: "init"; readonly result: InitResult }
  | {
      readonly id: number;
      readonly ok: true;
      readonly type: "exec";
      readonly results: readonly SqlResultSet[];
    }
  | { readonly id: number; readonly ok: false; readonly error: SqlErrorInfo };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || typeof value.id !== "number") {
    return false;
  }
  if (value.type === "init") {
    return true;
  }
  return value.type === "exec" && typeof value.sql === "string";
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.ok !== "boolean") {
    return false;
  }
  if (!value.ok) {
    return isRecord(value.error) && typeof value.error.message === "string";
  }
  if (value.type === "init") {
    return isRecord(value.result) && typeof value.result.version === "string";
  }
  return value.type === "exec" && Array.isArray(value.results);
}
