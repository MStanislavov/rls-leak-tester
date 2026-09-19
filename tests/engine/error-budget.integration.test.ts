/**
 * The premise of `src/lib/runner/error-budget.ts`, held against the real PGlite: a session that
 * has spent the default budget still answers correctly, whatever kind of error spent it, and the
 * wedge itself (54001) surfaces as a lost database, not as a SQL error a probe could misread.
 */
import { describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { DEFAULT_ERROR_BUDGET, errorCost, withErrorBudget } from "@/lib/runner/error-budget";
import { EngineWedgedError, SqlError, type SqlEngine } from "@/lib/runner/types";

const TIMEOUT_MS = 120_000;

const SETUP = `
  create role app nologin;
  create table t (id int primary key, body text);
  alter table t enable row level security;
  create policy p on t for all to app using (true) with check (false);
  grant all on t to app;
  insert into t values (1, 'a');`;

/** One failing statement in a rolled-back transaction, as a probe would send it. */
async function fail(engine: SqlEngine, statements: readonly string[]): Promise<string> {
  return engine.transaction(async (tx) => {
    try {
      for (const statement of statements) {
        await tx.query(statement);
      }
      return "no error";
    } catch (error) {
      if (error instanceof SqlError) {
        return error.code;
      }
      throw error;
    } finally {
      await tx.rollback();
    }
  });
}

const KINDS: readonly (readonly [string, string, readonly string[]])[] = [
  ["a policy violation", "42501", ["set local role app", "update t set body = body"]],
  ["a data exception", "22012", ["select 1 / 0"]],
  ["an undefined table", "42P01", ["select * from nope"]],
  ["a syntax error", "42601", ["selec 1"]],
];

describe("the default error budget against PGlite", () => {
  it.each(KINDS)(
    "a session that spent the whole budget on %s (%s) still answers",
    async (_name, sqlState, statements) => {
      const unlimited = { rebuildAt: Number.MAX_SAFE_INTEGER, abortAt: Number.MAX_SAFE_INTEGER };
      const engine = withErrorBudget(await createPgliteEngine(), unlimited);
      try {
        await engine.exec(SETUP);
        const errors = Math.ceil(DEFAULT_ERROR_BUDGET.abortAt / errorCost(sqlState));
        for (let index = 0; index < errors; index += 1) {
          expect(await fail(engine, statements)).toBe(sqlState);
        }
        expect(engine.spent()).toBeGreaterThanOrEqual(DEFAULT_ERROR_BUDGET.abortAt);
        const { rows } = await engine.query("select count(*)::text as n from t");
        expect(rows).toEqual([{ n: "1" }]);
      } finally {
        await engine.close();
      }
    },
    TIMEOUT_MS,
  );

  it(
    "the wedge is reported as a lost database, and the budget then refuses the session",
    async () => {
      const unlimited = { rebuildAt: Number.MAX_SAFE_INTEGER, abortAt: Number.MAX_SAFE_INTEGER };
      const engine = withErrorBudget(await createPgliteEngine(), unlimited);
      try {
        let failure: unknown = null;
        let errors = 0;
        // Syntax errors are the most expensive kind: measured at 370 on PGlite 0.5.8.
        for (; errors < 2000 && failure === null; errors += 1) {
          failure = await fail(engine, ["selec 1"]).then(
            () => null,
            (error: unknown) => error,
          );
        }
        expect(failure).toBeInstanceOf(EngineWedgedError);
        expect(failure).toMatchObject({ databaseLost: true });
        expect(errors).toBeGreaterThan(DEFAULT_ERROR_BUDGET.abortAt / errorCost("42601"));
        expect(engine.exhausted()).toBe(true);
        await expect(engine.query("select 1")).rejects.toBeInstanceOf(EngineWedgedError);
      } finally {
        await engine.close().catch(() => undefined);
      }
    },
    TIMEOUT_MS,
  );
});
