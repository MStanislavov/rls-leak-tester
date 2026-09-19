/**
 * The budget of SQL errors of one database session.
 *
 * Measured on PGlite 0.5.8: every SQL error costs the session stack that a ROLLBACK does not give
 * back. When it is used up a statement fails with 54001 (stack depth limit exceeded), the
 * ROLLBACK fails too, and from then on EVERY statement answers 25P02. A runner that kept going
 * would read those answers as "inconclusive" for the rest of the run and could still call the
 * scenario ISOLATED. Successful statements cost nothing (12,000 savepoint cycles are fine), and a
 * fresh engine starts from zero. How many errors a session survives depends on where the error
 * is raised (one failing statement per rolled-back transaction, until 54001):
 *
 *   42501 missing privilege 3046   42501 RLS WITH CHECK 2976   23503 2974   23505 2977
 *   P0001 raised in a trigger 2964   25P01 2569   22012 1871 (1701 through `exec`)
 *   22P02 1845   42703 1845   42P01 1794   42601 syntax error 370
 *
 * So an error is charged in units of the cheapest kind (about 2,960 of them fit): 1 for 42501,
 * class 23 and class P0, 8 for a syntax error, 2 for everything else. The engine a run probes
 * through is wrapped here:
 *
 * - every `SqlError` is charged;
 * - at `rebuildAt` the runner replaces the database BEFORE the next cell (`exhausted()`);
 * - at `abortAt` no further statement is sent: the call fails with `EngineWedgedError`, the cell
 *   that needed so many errors ends `inconclusive`, and the runner rebuilds;
 * - 54001, and 25P02 on the first statement of a transaction (which nothing in that transaction
 *   can have caused), are the wedge itself and become `EngineWedgedError` as well. This is the
 *   backstop for an error kind that costs more than the table above knows.
 *
 * `EngineWedgedError.databaseLost` is `true`, so everything that handles a lost database (the
 * executor, the cells, `runMatrix`) handles this without knowing about it.
 */
import {
  EngineWedgedError,
  SqlError,
  type SqlEngine,
  type SqlExecutor,
  type SqlTransaction,
} from "./types";

export interface ErrorBudget {
  /** Units after which the database is rebuilt before the next cell. */
  readonly rebuildAt: number;
  /** Units after which the session refuses every further statement. */
  readonly abortAt: number;
}

/**
 * About a third and two thirds of the 2,960 units a session survives: one cell may still raise a
 * thousand 42501 after the last check, and the session is never driven near the edge, where a
 * function that swallows exceptions could turn a 54001 into a wrong answer.
 */
export const DEFAULT_ERROR_BUDGET: ErrorBudget = { rebuildAt: 1000, abortAt: 2000 };

/** What one error costs, in units of the cheapest kind; see the table in the header. */
export function errorCost(sqlState: string): number {
  if (sqlState === "42601") {
    return 8;
  }
  const cheap = sqlState === "42501" || sqlState.startsWith("23") || sqlState.startsWith("P0");
  return cheap ? 1 : 2;
}

const SQLSTATE_STACK_DEPTH = "54001";
const SQLSTATE_ABORTED_TRANSACTION = "25P02";

export interface BudgetedEngine extends SqlEngine {
  /** Units this session has spent so far. */
  spent(): number;
  /** `true` once the session should be replaced before more work is given to it. */
  exhausted(): boolean;
}

export function withErrorBudget(
  engine: SqlEngine,
  budget: ErrorBudget = DEFAULT_ERROR_BUDGET,
): BudgetedEngine {
  let spent = 0;

  /** Counts a SQL error and turns the wedge itself into `EngineWedgedError`. */
  const counted = async <T>(work: () => Promise<T>, firstOfTransaction: boolean): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof SqlError)) {
        throw error;
      }
      spent += errorCost(error.code);
      const wedged =
        error.code === SQLSTATE_STACK_DEPTH ||
        (firstOfTransaction && error.code === SQLSTATE_ABORTED_TRANSACTION);
      if (wedged) {
        spent = Math.max(spent, budget.abortAt);
        throw new EngineWedgedError(
          `The database session is worn out ([${error.code}] ${error.message}) and is rebuilt.`,
        );
      }
      throw error;
    }
  };

  const guarded = <T>(work: () => Promise<T>, firstOfTransaction: boolean): Promise<T> => {
    if (spent >= budget.abortAt) {
      return Promise.reject(
        new EngineWedgedError(
          `This database session has raised too many SQL errors (${spent} of about 2,960 units of error stack are spent, and PGlite stops working when they run out). Nothing more is sent to it and the database is rebuilt. This cell needs more failing statements than one session can take and could not be measured completely.`,
        ),
      );
    }
    return counted(work, firstOfTransaction);
  };

  const wrap = (executor: SqlExecutor, inTransaction: boolean): SqlExecutor => {
    let first = inTransaction;
    const next = (): boolean => {
      const isFirst = first;
      first = false;
      return isFirst;
    };
    return {
      query: (sql, params) => guarded(() => executor.query(sql, params), next()),
      exec: (sql) => guarded(() => executor.exec(sql), next()),
    };
  };

  const outer = wrap(engine, false);
  return {
    ...outer,
    transaction: (callback) =>
      engine.transaction((tx) => {
        const inner = wrap(tx, true);
        const handle: SqlTransaction = {
          ...inner,
          // Always sent, whatever the budget says; a worn-out session fails it with 54001 too.
          rollback: () => counted(() => tx.rollback(), false),
          get closed() {
            return tx.closed;
          },
        };
        return callback(handle);
      }),
    close: () => engine.close(),
    spent: () => spent,
    exhausted: () => spent >= budget.rebuildAt,
  };
}
