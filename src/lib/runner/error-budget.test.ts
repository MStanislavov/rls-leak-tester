import { describe, expect, it } from "vitest";
import { DEFAULT_ERROR_BUDGET, errorCost, withErrorBudget } from "./error-budget";
import { EngineError, EngineWedgedError, SqlError, type SqlEngine } from "./types";

/** An engine whose statements fail as scripted: the SQL text names the SQLSTATE, `ok` succeeds. */
function scriptedEngine(): { engine: SqlEngine; sent: string[] } {
  const sent: string[] = [];
  const answer = (sql: string): Promise<{ rows: []; affectedRows: number }> => {
    sent.push(sql);
    if (sql === "engine") {
      return Promise.reject(new EngineError("wasm aborted"));
    }
    return sql === "ok" || sql === "ROLLBACK"
      ? Promise.resolve({ rows: [], affectedRows: 0 })
      : Promise.reject(new SqlError({ code: sql, message: `failed with ${sql}` }));
  };
  const engine: SqlEngine = {
    query: (sql) => answer(sql),
    exec: (sql) => answer(sql).then(() => undefined),
    close: () => Promise.resolve(),
    transaction: (callback) => {
      let closed = false;
      return callback({
        query: (sql) => answer(sql),
        exec: (sql) => answer(sql).then(() => undefined),
        rollback: async () => {
          closed = true;
          await answer(sent.includes("54001") ? "54001" : "ROLLBACK");
        },
        get closed() {
          return closed;
        },
      });
    },
  };
  return { engine, sent };
}

const code = (error: unknown): unknown => (error instanceof SqlError ? error.code : error);

describe("errorCost", () => {
  it("charges an error by how much of the session it uses up", () => {
    expect(["42501", "23503", "23505", "P0001"].map(errorCost)).toEqual([1, 1, 1, 1]);
    expect(["22012", "22P02", "42P01", "42703", "25P01", "XX000"].map(errorCost)).toEqual([
      2, 2, 2, 2, 2, 2,
    ]);
    expect(errorCost("42601")).toBe(8);
    expect(DEFAULT_ERROR_BUDGET.rebuildAt).toBeLessThan(DEFAULT_ERROR_BUDGET.abortAt);
  });
});

describe("withErrorBudget", () => {
  it("passes results and errors through and charges every SQL error, in and out of transactions", async () => {
    const { engine } = scriptedEngine();
    const budgeted = withErrorBudget(engine, { rebuildAt: 12, abortAt: 100 });
    await expect(budgeted.query("ok")).resolves.toEqual({ rows: [], affectedRows: 0 });
    await expect(budgeted.exec("ok")).resolves.toBeUndefined();
    expect(await budgeted.query("42501").catch(code)).toBe("42501");
    expect(await budgeted.exec("22012").catch(code)).toBe("22012");
    expect(budgeted.spent()).toBe(3);
    await budgeted.transaction(async (tx) => {
      expect(tx.closed).toBe(false);
      expect(await tx.query("42601").catch(code)).toBe("42601");
      expect(await tx.exec("23505").catch(code)).toBe("23505");
      await tx.rollback();
      expect(tx.closed).toBe(true);
    });
    expect(budgeted.spent()).toBe(12);
    expect(budgeted.exhausted()).toBe(true);
    await expect(budgeted.close()).resolves.toBeUndefined();
  });

  it("an engine failure is not a SQL error and costs nothing", async () => {
    const budgeted = withErrorBudget(scriptedEngine().engine, { rebuildAt: 1, abortAt: 2 });
    await expect(budgeted.query("engine")).rejects.toBeInstanceOf(EngineError);
    expect(budgeted.spent()).toBe(0);
    expect(budgeted.exhausted()).toBe(false);
  });

  it("sends nothing more once the budget is spent, except the ROLLBACK", async () => {
    const { engine, sent } = scriptedEngine();
    const budgeted = withErrorBudget(engine, { rebuildAt: 1, abortAt: 2 });
    await budgeted.transaction(async (tx) => {
      await tx.query("42501").catch(code);
      await tx.query("42501").catch(code);
      const refused = await tx.query("ok").catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(EngineWedgedError);
      expect(refused).toMatchObject({
        databaseLost: true,
        message: expect.stringContaining("too many SQL errors"),
      });
      await expect(tx.exec("ok")).rejects.toBeInstanceOf(EngineWedgedError);
      await tx.rollback();
    });
    await expect(budgeted.exec("ok")).rejects.toBeInstanceOf(EngineWedgedError);
    expect(sent).toEqual(["42501", "42501", "ROLLBACK"]);
  });

  it("54001 is the wedge: a lost database, also when the ROLLBACK raises it", async () => {
    const budgeted = withErrorBudget(scriptedEngine().engine);
    await budgeted.transaction(async (tx) => {
      await tx.query("ok");
      const wedged = await tx.query("54001").catch((error: unknown) => error);
      expect(wedged).toBeInstanceOf(EngineWedgedError);
      expect(wedged).toMatchObject({ message: expect.stringContaining("[54001]") });
      await expect(tx.rollback()).rejects.toBeInstanceOf(EngineWedgedError);
    });
    expect(budgeted.exhausted()).toBe(true);
    await expect(budgeted.query("ok")).rejects.toBeInstanceOf(EngineWedgedError);
  });

  it("25P02 on the FIRST statement of a transaction is the wedge, later it is an ordinary error", async () => {
    const budgeted = withErrorBudget(scriptedEngine().engine);
    await budgeted.transaction(async (tx) => {
      await tx.query("ok");
      expect(await tx.query("25P02").catch(code)).toBe("25P02");
    });
    expect(budgeted.exhausted()).toBe(false);
    await budgeted.transaction(async (tx) => {
      await expect(tx.query("25P02")).rejects.toBeInstanceOf(EngineWedgedError);
    });
    expect(budgeted.exhausted()).toBe(true);
    // Outside a transaction 25P02 cannot be the wedge's echo of an earlier BEGIN.
    const fresh = withErrorBudget(scriptedEngine().engine);
    expect(await fresh.query("25P02").catch(code)).toBe("25P02");
  });
});
