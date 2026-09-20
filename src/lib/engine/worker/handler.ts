/**
 * The logic that runs inside the worker, kept free of `self` and of the PGlite
 * import so it can be tested in Node against a real PGlite instance.
 */
import type {
  SqlCell,
  SqlErrorInfo,
  SqlResultSet,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

/** One result as PGlite reports it in `rowMode: "array"`. */
export interface WorkerDatabaseResult {
  rows: unknown[];
  affectedRows?: number;
  fields: Array<{ name: string; dataTypeID: number }>;
}

/** The slice of PGlite's API the worker needs. `PGlite` satisfies it. */
export interface WorkerDatabase {
  /** Simple protocol: many statements, no parameters, one result per statement. */
  exec(sql: string, options: { rowMode: "array" }): Promise<WorkerDatabaseResult[]>;
  /** Extended protocol: one statement with `$1` parameters. */
  query(
    sql: string,
    params: Array<string | number | boolean | null>,
    options: { rowMode: "array" },
  ): Promise<WorkerDatabaseResult>;
  close(): Promise<void>;
}

export type DatabaseFactory = () => Promise<WorkerDatabase>;

export type RequestHandler = (request: WorkerRequest) => Promise<WorkerResponse>;

/** JSON has no bigint: it travels as its decimal text. */
function bigintAsText(_key: string, inner: unknown): unknown {
  return typeof inner === "bigint" ? inner.toString() : inner;
}

function toHex(bytes: Uint8Array): string {
  let hex = String.raw`\x`;
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Turns whatever PGlite's parsers produced into a structured-clone-safe cell. */
export function toCell(value: unknown): SqlCell {
  if (value === null || value === undefined) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    default:
      break;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return toHex(value);
  }
  return JSON.stringify(value, bigintAsText);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The message for a thrown object that carries none. `String` would only say "[object Object]",
 * so its data is shown as JSON; what JSON cannot express (a cycle, a `toJSON` that returns
 * nothing) falls back to the object's tag.
 */
function describeThrownObject(value: object): string {
  let json: unknown;
  try {
    json = JSON.stringify(value, bigintAsText);
  } catch {
    json = undefined;
  }
  return typeof json === "string" ? json : Object.prototype.toString.call(value);
}

/** Maps a thrown value to plain data. PGlite's `DatabaseError` carries `code`. */
export function toErrorInfo(error: unknown): SqlErrorInfo {
  if (typeof error === "object" && error !== null) {
    const fields = error as Record<string, unknown>;
    return {
      message: typeof fields.message === "string" ? fields.message : describeThrownObject(error),
      code: stringOrNull(fields.code),
      detail: stringOrNull(fields.detail),
      hint: stringOrNull(fields.hint),
      position: stringOrNull(fields.position),
    };
  }
  return { message: String(error), code: null, detail: null, hint: null, position: null };
}

function toResultSet(result: WorkerDatabaseResult): SqlResultSet {
  return {
    fields: result.fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID })),
    rows: result.rows.map((row) => (Array.isArray(row) ? row.map(toCell) : [toCell(row)])),
    affectedRows: result.affectedRows ?? 0,
  };
}

/**
 * Builds the worker's request handler. The database is created once, on the
 * first request of any type, and requests are answered strictly in order.
 *
 * There is one connection, so a transaction needs no session id: `BEGIN` sent
 * through `exec` leaves the connection inside that transaction for the requests
 * that follow, until `COMMIT` or `ROLLBACK` (ADR 0002). Keeping other callers
 * out of an open transaction is the client's job (`protocol-engine.ts`).
 * `close` releases the database; the next request would start an empty one.
 */
export function createRequestHandler(
  createDatabase: DatabaseFactory,
  now: () => number = () => performance.now(),
): RequestHandler {
  let ready: Promise<{ db: WorkerDatabase; version: string; startupMs: number }> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const start = () => {
    ready ??= (async () => {
      const startedAt = now();
      const db = await createDatabase();
      const [result] = await db.exec("select version()", { rowMode: "array" });
      const firstRow = result?.rows[0];
      const version = Array.isArray(firstRow) ? String(firstRow[0]) : "";
      return { db, version, startupMs: Math.round(now() - startedAt) };
    })();
    // A failed start must not poison the worker: the next request tries again.
    ready.catch(() => {
      ready = null;
    });
    return ready;
  };

  // Closing a database that never started must not start one.
  const close = async (): Promise<void> => {
    const current = ready;
    ready = null;
    if (current) {
      const { db } = await current;
      await db.close();
    }
  };

  const answer = async (request: WorkerRequest): Promise<WorkerResponse> => {
    try {
      if (request.type === "close") {
        await close();
        return { id: request.id, ok: true, type: "close" };
      }
      const { db, version, startupMs } = await start();
      switch (request.type) {
        case "init":
          return { id: request.id, ok: true, type: "init", result: { version, startupMs } };
        case "query": {
          const result = await db.query(request.sql, [...request.params], { rowMode: "array" });
          return { id: request.id, ok: true, type: "query", result: toResultSet(result) };
        }
        case "exec": {
          const results = await db.exec(request.sql, { rowMode: "array" });
          return { id: request.id, ok: true, type: "exec", results: results.map(toResultSet) };
        }
      }
    } catch (error) {
      return { id: request.id, ok: false, error: toErrorInfo(error) };
    }
  };

  return (request) => {
    const response = queue.then(() => answer(request));
    queue = response;
    return response;
  };
}
