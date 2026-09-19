import { describe, expect, it } from "vitest";
import {
  EngineError,
  EngineTerminatedError,
  EngineTimeoutError,
  SqlError,
} from "@/lib/runner/types";
import { createProtocolEngine, toPortError, type EngineTransport } from "./protocol-engine";
import { SqlExecutionError, WorkerTerminatedError, WorkerTimeoutError } from "./worker/client";
import type { SqlResultSet } from "./worker/protocol";

const EMPTY: SqlResultSet = { fields: [], rows: [], affectedRows: 0 };

function sqlFailure(code: string | null, position: string | null = null): SqlExecutionError {
  return new SqlExecutionError({
    message: `failed ${code}`,
    code,
    detail: null,
    hint: null,
    position,
  });
}

/** Records every statement; `fail` decides per statement whether the transport throws. */
function fakeTransport(fail: (sql: string) => unknown = () => undefined) {
  const sent: string[] = [];
  const run = (sql: string) => {
    sent.push(sql);
    const error = fail(sql);
    if (error !== undefined) {
      throw error;
    }
  };
  const transport: EngineTransport = {
    exec: async (sql) => {
      run(sql);
      return [EMPTY];
    },
    query: async (sql) => {
      run(sql);
      return EMPTY;
    },
    close: async () => {
      run("<close>");
    },
  };
  return { transport, sent };
}

describe("toPortError", () => {
  it("maps a failure with a SQLSTATE to SqlError and keeps its fields", () => {
    const error = toPortError(
      new SqlExecutionError({
        message: "duplicate key",
        code: "23505",
        detail: "Key (id)=(1) already exists.",
        hint: "h",
        position: "15",
      }),
    );
    expect(error).toBeInstanceOf(SqlError);
    expect(error).toMatchObject({
      code: "23505",
      message: "duplicate key",
      detail: "Key (id)=(1) already exists.",
      hint: "h",
      position: 15,
    });
  });

  it("drops a position that is not a positive integer", () => {
    expect(toPortError(sqlFailure("42601", "abc"))).toMatchObject({ position: undefined });
    expect(toPortError(sqlFailure("42601", "0"))).toMatchObject({ position: undefined });
    expect(toPortError(sqlFailure("42601", null))).toMatchObject({ position: undefined });
  });

  it("treats a failure without a SQLSTATE as an engine failure, never as a Postgres verdict", () => {
    const error = toPortError(sqlFailure(null));
    expect(error).toBeInstanceOf(EngineError);
    expect(error).not.toBeInstanceOf(SqlError);
    expect(error).toMatchObject({ databaseLost: false });
  });

  it("maps a timeout and a termination to errors that say the database is lost", () => {
    const timeout = toPortError(new WorkerTimeoutError(5_000));
    expect(timeout).toBeInstanceOf(EngineTimeoutError);
    expect(timeout).toMatchObject({
      name: "EngineTimeoutError",
      timeoutMs: 5_000,
      databaseLost: true,
    });

    const gone = toPortError(new WorkerTerminatedError("crashed"));
    expect(gone).toBeInstanceOf(EngineTerminatedError);
    expect(gone).toMatchObject({ message: "crashed", databaseLost: true });
  });

  it("passes port errors through and wraps everything else", () => {
    const already = new SqlError({ code: "42501", message: "denied" });
    expect(toPortError(already)).toBe(already);
    const lost = new EngineTimeoutError(1);
    expect(toPortError(lost)).toBe(lost);
    expect(toPortError(new TypeError("bad"))).toMatchObject({
      name: "EngineError",
      message: "bad",
    });
    expect(toPortError("plain")).toMatchObject({ name: "EngineError", message: "plain" });
  });
});

describe("createProtocolEngine with a scripted transport", () => {
  it("turns field-ordered cells into rows; a missing cell is null and a repeated name keeps the last", async () => {
    const { transport } = fakeTransport();
    transport.query = async () => ({
      fields: [
        { name: "a", dataTypeId: 23 },
        { name: "a", dataTypeId: 23 },
        { name: "b", dataTypeId: 25 },
      ],
      rows: [[1, 2]],
      affectedRows: 3,
    });
    const engine = createProtocolEngine(transport);
    await expect(engine.query("select")).resolves.toEqual({
      rows: [{ a: 2, b: null }],
      affectedRows: 3,
    });
  });

  it("wraps a transaction in BEGIN and COMMIT", async () => {
    const { transport, sent } = fakeTransport();
    const engine = createProtocolEngine(transport);
    await engine.transaction(async (tx) => {
      await tx.query("select 1");
      await tx.exec("select 2");
    });
    expect(sent).toEqual(["BEGIN", "select 1", "select 2", "COMMIT"]);
  });

  it("does not run the callback when BEGIN fails", async () => {
    const { transport, sent } = fakeTransport((sql) =>
      sql === "BEGIN" ? sqlFailure("25001") : undefined,
    );
    let ran = false;
    await expect(
      createProtocolEngine(transport).transaction(async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "25001" });
    expect(ran).toBe(false);
    expect(sent).toEqual(["BEGIN"]);
  });

  it("rolls back when the callback throws, and a failing ROLLBACK does not hide the cause", async () => {
    const { transport, sent } = fakeTransport((sql) =>
      sql === "ROLLBACK" ? sqlFailure("08006") : undefined,
    );
    const cause = new Error("probe failed");
    await expect(
      createProtocolEngine(transport).transaction(async () => {
        throw cause;
      }),
    ).rejects.toBe(cause);
    expect(sent).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("reports a failing COMMIT and sends no ROLLBACK after it", async () => {
    const { transport, sent } = fakeTransport((sql) =>
      sql === "COMMIT" ? sqlFailure("23503") : undefined,
    );
    await expect(
      createProtocolEngine(transport).transaction(async () => "value"),
    ).rejects.toMatchObject({ code: "23503" });
    expect(sent).toEqual(["BEGIN", "COMMIT"]);
  });

  it("sends nothing more after a timeout inside a transaction: the worker and its database are gone", async () => {
    const { transport, sent } = fakeTransport((sql) =>
      sql === "select pg_sleep(10)" ? new WorkerTimeoutError(5_000) : undefined,
    );
    const engine = createProtocolEngine(transport);
    let handleClosed = false;
    const failure = await engine
      .transaction(async (tx) => {
        try {
          await tx.query("select pg_sleep(10)");
        } finally {
          // The probe pattern: rollback in finally. It must not wake a new, empty worker.
          await tx.rollback();
          handleClosed = tx.closed;
        }
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineTimeoutError);
    expect(handleClosed).toBe(true);
    expect(sent).toEqual(["BEGIN", "select pg_sleep(10)"]);

    // The engine object stays usable for the replay of setup.
    await engine.exec("create table replayed (n int)");
    expect(sent.at(-1)).toBe("create table replayed (n int)");
  });

  it("keeps the queue moving after a failed call", async () => {
    const { transport, sent } = fakeTransport((sql) =>
      sql === "bad" ? sqlFailure("42601") : undefined,
    );
    const engine = createProtocolEngine(transport);
    const results = await Promise.allSettled([
      engine.exec("bad"),
      engine.query("good"),
      engine.close(),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(sent).toEqual(["bad", "good", "<close>"]);
  });
});
