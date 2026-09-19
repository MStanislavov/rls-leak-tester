import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPOSED_SCHEMAS,
  exposedSchemasOf,
  SetupError,
  setupDatabase,
  type SupabaseSetupSql,
} from "./setup";
import { EngineError, EngineTimeoutError, SqlError, type SqlEngine } from "./types";

const PIN = "set time zone 'UTC'";
const CHECK = "savepoint rls_leak_tester_open_transaction_check";
const RESET = ["reset session authorization", "reset role", "reset all", PIN];

/**
 * A scripted engine: records every statement, `fail` decides what a statement throws. Like
 * Postgres it refuses SAVEPOINT outside a transaction block (25P01), unless `openAfter` names a
 * statement that leaves one open.
 */
function fakeEngine(fail: (sql: string) => unknown = () => undefined, openAfter?: string) {
  const executed: string[] = [];
  let open = false;
  const engine: SqlEngine = {
    exec: async (sql) => {
      executed.push(sql);
      const error = fail(sql);
      if (error !== undefined) {
        throw error;
      }
      if (sql === CHECK && !open) {
        throw new SqlError({
          code: "25P01",
          message: "SAVEPOINT can only be used in transaction blocks",
        });
      }
      open = (open || sql === openAfter) && sql !== "rollback";
    },
    query: async () => ({ rows: [], affectedRows: 0 }),
    transaction: async () => {
      throw new Error("setup never opens a transaction of its own");
    },
    close: async () => undefined,
  };
  return { engine, executed };
}

const SUPABASE: SupabaseSetupSql = {
  shimSql: "create role anon; create schema auth;",
  defaultGrantsSql: (schema, { autoExposeNewTables }) =>
    `grant usage on schema ${schema} to anon; -- ${autoExposeNewTables ? "legacy" : "explicit"}`,
  createSchemaSql: (schema) => `create schema if not exists ${schema};`,
};

describe("setupDatabase order", () => {
  it("supabase: shim, then the grants of every exposed schema, then schema, then seed", async () => {
    const { engine, executed } = fakeEngine();
    const summary = await setupDatabase(
      engine,
      {
        mode: "supabase",
        schemaSql: "create table t (id int); create table u (id int);",
        seedSql: "insert into t values (1);",
        options: { exposedSchemas: ["public", "api"], supabaseGrants: "explicit" },
      },
      SUPABASE,
    );
    expect(executed).toEqual([
      PIN,
      "create role anon",
      "create schema auth",
      "create schema if not exists public",
      "grant usage on schema public to anon",
      "create schema if not exists api",
      "grant usage on schema api to anon",
      "create table t (id int)",
      "create table u (id int)",
      CHECK,
      "insert into t values (1)",
      CHECK,
      ...RESET,
    ]);
    expect(summary).toEqual({
      mode: "supabase",
      exposedSchemas: ["public", "api"],
      supabaseGrants: "explicit",
      schemaStatements: 2,
      seedStatements: 1,
    });
  });

  it("supabase defaults: public, legacy grants", async () => {
    const seen: boolean[] = [];
    const { engine } = fakeEngine();
    const summary = await setupDatabase(
      engine,
      { mode: "supabase", schemaSql: "", seedSql: "" },
      {
        ...SUPABASE,
        defaultGrantsSql: (schema, options) => {
          seen.push(options.autoExposeNewTables);
          return SUPABASE.defaultGrantsSql(schema, options);
        },
      },
    );
    expect(seen).toEqual([true]);
    expect(summary).toMatchObject({ exposedSchemas: ["public"], supabaseGrants: "legacy" });
  });

  it("postgres: only the user's SQL runs", async () => {
    const { engine, executed } = fakeEngine();
    const summary = await setupDatabase(
      engine,
      { mode: "postgres", schemaSql: "create role app;", seedSql: "" },
      SUPABASE,
    );
    expect(executed).toEqual([PIN, "create role app", CHECK, CHECK, ...RESET]);
    expect(summary).toMatchObject({ supabaseGrants: null, schemaStatements: 1, seedStatements: 0 });
  });
});

describe("setupDatabase failures", () => {
  it("wraps a Postgres error with the statement and keeps the cause", async () => {
    const cause = new SqlError({
      code: "42P07",
      message: "already exists",
      hint: "h",
      position: 14,
    });
    const { engine, executed } = fakeEngine((sql) => (sql.includes("u") ? cause : undefined));
    const error = await setupDatabase(
      engine,
      {
        mode: "postgres",
        schemaSql: "create table t (id int);\ncreate table u (id int);\nselect 3;",
        seedSql: "",
      },
      SUPABASE,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SetupError);
    expect(error).toMatchObject({
      phase: "schema",
      statementIndex: 1,
      statement: "create table u (id int)",
      line: 2,
      column: 1,
      sqlState: "42P07",
      message: "already exists",
      hint: "h",
      position: 14,
      cause,
    });
    // Nothing after the failing statement runs.
    expect(executed).toEqual([PIN, "create table t (id int)", "create table u (id int)"]);
  });

  it.each([
    ["schema", "begin", "create table t (id int);\n  begin;\ninsert into t values (1);", ""],
    ["seed", "START TRANSACTION", "", "START TRANSACTION;\ninsert into t values (1);"],
  ] as const)(
    "a transaction the %s SQL leaves open is refused, and rolled back",
    async (phase, opener, schemaSql, seedSql) => {
      const { engine, executed } = fakeEngine(undefined, opener);
      const error = await setupDatabase(
        engine,
        { mode: "postgres", schemaSql, seedSql },
        SUPABASE,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SetupError);
      expect(error).toMatchObject({
        phase,
        statement: opener,
        sqlState: "25001",
        message: expect.stringContaining("has no COMMIT"),
      });
      expect((error as SetupError).line).toBe(phase === "schema" ? 2 : 1);
      expect(executed.at(-1)).toBe("rollback");
      expect(executed).not.toContain("reset all");
    },
  );

  it("blames the last statement when no BEGIN is in sight (the transaction came from a function)", async () => {
    const { engine } = fakeEngine(undefined, "call open_one()");
    const error = await setupDatabase(
      engine,
      { mode: "postgres", schemaSql: "select 1; call open_one();", seedSql: "" },
      SUPABASE,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      phase: "schema",
      statement: "call open_one()",
      statementIndex: 1,
    });
  });

  it("lets another failure of the transaction check through as it is", async () => {
    const odd = new SqlError({ code: "25P02", message: "current transaction is aborted" });
    const { engine } = fakeEngine((sql) => (sql === CHECK ? odd : undefined));
    await expect(
      setupDatabase(engine, { mode: "postgres", schemaSql: "", seedSql: "" }, SUPABASE),
    ).rejects.toBe(odd);
  });

  it("reports an engine failure without a SQLSTATE, and a thrown non-error too", async () => {
    const broken = await setupDatabase(
      fakeEngine((sql) => (sql === PIN ? undefined : new EngineError("wasm aborted"))).engine,
      { mode: "postgres", schemaSql: "select 1;", seedSql: "" },
      SUPABASE,
    ).catch((caught: unknown) => caught);
    expect(broken).toMatchObject({ phase: "schema", sqlState: null, message: "wasm aborted" });

    const odd = await setupDatabase(
      fakeEngine((sql) => (sql === "select 1" ? "plain string" : undefined)).engine,
      { mode: "postgres", schemaSql: "", seedSql: "select 1;" },
      SUPABASE,
    ).catch((caught: unknown) => caught);
    expect(odd).toMatchObject({ phase: "seed", sqlState: null, message: "plain string" });
  });

  it("names the phase when the product's own SQL fails", async () => {
    const error = await setupDatabase(
      fakeEngine((sql) =>
        sql.startsWith("grant") ? new SqlError({ code: "3F000", message: "no schema" }) : undefined,
      ).engine,
      { mode: "supabase", schemaSql: "", seedSql: "" },
      SUPABASE,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ phase: "grants", sqlState: "3F000" });
  });

  it("passes a lost database through unchanged: the caller replays, the statement is not to blame", async () => {
    const timeout = new EngineTimeoutError(5_000);
    await expect(
      setupDatabase(
        fakeEngine((sql) => (sql === PIN ? undefined : timeout)).engine,
        { mode: "postgres", schemaSql: "select pg_sleep(60);", seedSql: "" },
        SUPABASE,
      ),
    ).rejects.toBe(timeout);
  });
});

describe("exposedSchemasOf", () => {
  it("defaults to public, removes duplicates and keeps the given order", () => {
    expect(exposedSchemasOf({})).toEqual([...DEFAULT_EXPOSED_SCHEMAS]);
    expect(exposedSchemasOf({ options: { exposedSchemas: [], supabaseGrants: "legacy" } })).toEqual(
      ["public"],
    );
    expect(
      exposedSchemasOf({ options: { exposedSchemas: ["b", "a", "b"], supabaseGrants: "legacy" } }),
    ).toEqual(["b", "a"]);
  });
});
