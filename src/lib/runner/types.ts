/**
 * The SqlEngine port (brief 3.5): the only thing the runner knows about a database.
 *
 * It lives in `src/lib/runner` and not in `src/lib/engine` because the runner must be able to
 * value-import the error classes (`instanceof SqlError` is how a probe is classified), and
 * SEC-004 forbids the runner every value import from `src/lib/engine`. The adapters in
 * `src/lib/engine` import this module; `src/lib/engine/port.ts` re-exports it for the UI.
 *
 * The contract every adapter keeps, so that results are byte-identical in Node and in the worker:
 *
 * - A cell is a `SqlValue`. `bigint`, dates, `bytea`, arrays and JSON arrive as text (ISO 8601 for
 *   dates, `\x..` for bytes, JSON text for arrays and json/jsonb). Select `::text` when the exact
 *   spelling matters.
 * - `query` runs ONE statement with `$1` parameters (extended protocol); `exec` runs a script of
 *   many statements without parameters (simple protocol). A multi-statement `exec` without its own
 *   `BEGIN` is one implicit transaction.
 * - Inside `transaction` use the `tx` handle only. A call on the engine itself waits until the
 *   transaction has ended, so awaiting one inside the callback never resolves (ADR 0002).
 * - `transaction` commits when the callback resolves and rolls back when it throws. After
 *   `tx.rollback()` the handle is closed. The probe pattern is: work, then `tx.rollback()` in
 *   `finally`.
 * - Postgres errors are thrown as `SqlError` with the SQLSTATE in `code`. A lost database is an
 *   `EngineError`: after `EngineTimeoutError` or `EngineTerminatedError` the same engine object is
 *   usable again but points at an EMPTY database; replay `setupDatabase` before the next probe.
 *   After `EngineWedgedError` the engine is NOT usable: close it and create a new one. The matrix
 *   runner always does the latter, so it treats every lost database alike.
 */

/** One value of a result row. */
export type SqlValue = string | number | boolean | null;

/** A query parameter. Pass JSON (claims) as its text. */
export type SqlParam = string | number | boolean | null;

export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlQueryResult {
  readonly rows: readonly SqlRow[];
  /** Rows touched by INSERT, UPDATE or DELETE; 0 for everything else. */
  readonly affectedRows: number;
}

export interface SqlExecutor {
  /** One statement, `$1` style parameters. */
  query(sql: string, params?: readonly SqlParam[]): Promise<SqlQueryResult>;
  /** A script of one or more statements, no parameters, no result. */
  exec(sql: string): Promise<void>;
}

export interface SqlTransaction extends SqlExecutor {
  /** Sends ROLLBACK and closes the handle. Safe to call twice and after an error. */
  rollback(): Promise<void>;
  readonly closed: boolean;
}

export interface SqlEngine extends SqlExecutor {
  transaction<T>(callback: (tx: SqlTransaction) => Promise<T>): Promise<T>;
  /** Releases the database. The engine must not be used afterwards. */
  close(): Promise<void>;
}

export interface SqlErrorFields {
  readonly code: string;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly hint?: string | undefined;
  /** 1-based character offset into the statement, when Postgres reports one. */
  readonly position?: number | undefined;
}

/** Postgres raised an error. `code` is the SQLSTATE (`42501`, `23505`, ...). */
export class SqlError extends Error {
  override readonly name = "SqlError";
  readonly code: string;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly position: number | undefined;

  constructor(fields: SqlErrorFields) {
    super(fields.message);
    this.code = fields.code;
    this.detail = fields.detail;
    this.hint = fields.hint;
    this.position = fields.position;
  }
}

/** The engine itself failed; the statement did not get a verdict from Postgres. */
export class EngineError extends Error {
  override readonly name: string = "EngineError";
  /** `true` when the database is gone and setup has to be replayed. */
  readonly databaseLost: boolean = false;
}

/** A call exceeded its timeout. The worker was terminated: the database is empty now. */
export class EngineTimeoutError extends EngineError {
  override readonly name = "EngineTimeoutError";
  override readonly databaseLost = true;

  constructor(readonly timeoutMs: number) {
    super(`The database did not answer within ${timeoutMs} ms and was terminated`);
  }
}

/** The worker went away for another reason (crash, dispose, a timeout of another call). */
export class EngineTerminatedError extends EngineError {
  override readonly name = "EngineTerminatedError";
  override readonly databaseLost = true;
}

/**
 * The session can no longer give a trustworthy answer: PGlite's error stack is exhausted (54001,
 * then 25P02 on every statement), or the run's budget of SQL errors is spent before that happens.
 * Unlike a timeout the old engine is NOT usable again: close it and build a new one.
 */
export class EngineWedgedError extends EngineError {
  override readonly name = "EngineWedgedError";
  override readonly databaseLost = true;
}

/** SQLSTATE 42501: a policy violation or a missing privilege. The classifier reads it as blocked. */
export const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
