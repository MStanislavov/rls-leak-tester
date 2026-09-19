/**
 * The one implementation of the `SqlEngine` port. It talks to the request handler of
 * `worker/handler.ts` through a transport: the Web Worker client in the browser, a direct
 * in-process call in Node. Both paths therefore run the same handler, the same cell
 * normalisation and the same transaction logic, which is what keeps results identical.
 *
 * Transactions: PGlite has one connection, so `BEGIN` leaves that connection inside the
 * transaction for every request that follows (ADR 0002). This module keeps the statements of one
 * transaction together by holding a lock from `BEGIN` to `COMMIT` / `ROLLBACK`: a call on the
 * engine itself waits until the open transaction has ended, exactly like PGlite's own
 * `db.query` inside `db.transaction`. Inside the callback use the `tx` handle only.
 *
 * A lost database (worker timeout, crash, dispose) ends the transaction with it. The handle is
 * closed without sending `ROLLBACK`, because the next request would boot a new, empty worker.
 */
import {
  EngineError,
  EngineTerminatedError,
  EngineTimeoutError,
  SqlError,
  type SqlEngine,
  type SqlParam,
  type SqlQueryResult,
  type SqlRow,
  type SqlTransaction,
} from "@/lib/runner/types";
import { SqlExecutionError, WorkerTerminatedError, WorkerTimeoutError } from "./worker/client";
import type { SqlParamValue, SqlResultSet } from "./worker/protocol";

/** What the engine needs from the other side. `PgliteWorkerClient` has this shape. */
export interface EngineTransport {
  exec(sql: string): Promise<readonly SqlResultSet[]>;
  query(sql: string, params: readonly SqlParamValue[]): Promise<SqlResultSet>;
  close(): Promise<void>;
}

function toPosition(position: string | null): number | undefined {
  if (position === null) {
    return undefined;
  }
  const value = Number.parseInt(position, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Maps what a transport throws to the error classes of the port. */
export function toPortError(error: unknown): Error {
  if (error instanceof SqlError || error instanceof EngineError) {
    return error;
  }
  if (error instanceof WorkerTimeoutError) {
    return new EngineTimeoutError(error.timeoutMs);
  }
  if (error instanceof WorkerTerminatedError) {
    return new EngineTerminatedError(error.message);
  }
  if (error instanceof SqlExecutionError) {
    // No SQLSTATE means Postgres never judged the statement: an engine failure (ADR 0002).
    return error.code === null
      ? new EngineError(error.message)
      : new SqlError({
          code: error.code,
          message: error.message,
          detail: error.detail ?? undefined,
          hint: error.hint ?? undefined,
          position: toPosition(error.position),
        });
  }
  return new EngineError(error instanceof Error ? error.message : String(error));
}

function toQueryResult(result: SqlResultSet): SqlQueryResult {
  const names = result.fields.map((field) => field.name);
  const rows = result.rows.map((cells) => {
    const row: Record<string, SqlRow[string]> = {};
    names.forEach((name, index) => {
      row[name] = cells[index] ?? null;
    });
    return row;
  });
  return { rows, affectedRows: result.affectedRows };
}

export function createProtocolEngine(transport: EngineTransport): SqlEngine {
  // Every top-level call waits for the one before it; a transaction holds its turn until it ends.
  let turn: Promise<unknown> = Promise.resolve();

  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = turn.then(work);
    turn = result.catch(() => undefined);
    return result;
  };

  const send = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw toPortError(error);
    }
  };

  const rawQuery = (sql: string, params: readonly SqlParam[]): Promise<SqlQueryResult> =>
    send(async () => toQueryResult(await transport.query(sql, params)));

  const rawExec = (sql: string): Promise<void> =>
    send(async () => {
      await transport.exec(sql);
    });

  const runTransaction = async <T>(callback: (tx: SqlTransaction) => Promise<T>): Promise<T> => {
    await rawExec("BEGIN");
    let closed = false;
    let lost = false;

    const guarded = async <R>(work: () => Promise<R>): Promise<R> => {
      if (closed) {
        throw new EngineError("Transaction is closed");
      }
      try {
        return await work();
      } catch (error) {
        if (error instanceof EngineError && error.databaseLost) {
          lost = true;
          closed = true;
        }
        throw error;
      }
    };

    const end = async (statement: "COMMIT" | "ROLLBACK"): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await rawExec(statement);
    };

    const tx: SqlTransaction = {
      query: (sql, params = []) => guarded(() => rawQuery(sql, params)),
      exec: (sql) => guarded(() => rawExec(sql)),
      rollback: () => end("ROLLBACK"),
      get closed() {
        return closed;
      },
    };

    try {
      const value = await callback(tx);
      await end("COMMIT");
      return value;
    } catch (error) {
      if (!lost) {
        // The original error matters more than a failed ROLLBACK of a broken connection.
        await end("ROLLBACK").catch(() => undefined);
      }
      throw error;
    }
  };

  return {
    query: (sql, params = []) => exclusive(() => rawQuery(sql, params)),
    exec: (sql) => exclusive(() => rawExec(sql)),
    transaction: (callback) => exclusive(() => runTransaction(callback)),
    close: () => exclusive(() => send(() => transport.close())),
  };
}
