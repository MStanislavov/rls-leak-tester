import { describe, expect, it } from "vitest";
import { introspect, IntrospectionError } from "./introspect";
import type { SqlExecutor, SqlRow } from "./types";

/** Answers the table query with `row` and everything else with nothing. */
function engineWithTableRow(row: SqlRow): SqlExecutor {
  return {
    exec: async () => undefined,
    query: async (sql) => ({
      rows: sql.includes("c.relrowsecurity as rls_enabled") ? [row] : [],
      affectedRows: 0,
    }),
  };
}

const TABLE: SqlRow = {
  schema: "public",
  name: "t",
  owner: "postgres",
  rls_enabled: true,
  rls_forced: false,
  partitioned: false,
};

describe("introspect with a scripted engine", () => {
  it("sends the exposed schemas as one JSON parameter and never inside the SQL text", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const hostile = `public'); drop table t; --`;
    const catalog = await introspect(
      {
        exec: async () => undefined,
        query: async (sql, params = []) => {
          calls.push({ sql, params });
          return { rows: [], affectedRows: 0 };
        },
      },
      [hostile, hostile],
    );
    expect(catalog.exposedSchemas).toEqual([hostile]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.sql).not.toContain("drop table");
      expect(call.params.length === 0 || call.params[0] === JSON.stringify([hostile])).toBe(true);
    }
  });

  it("builds a table without columns or key when the catalog has none for it", async () => {
    const catalog = await introspect(engineWithTableRow(TABLE), ["public"]);
    expect(catalog.tables).toEqual([
      {
        schema: "public",
        name: "t",
        owner: "postgres",
        rlsEnabled: true,
        rlsForced: false,
        partitioned: false,
        columns: [],
        primaryKey: [],
      },
    ]);
  });

  it.each([
    ["text", { ...TABLE, owner: 7 }, 'Expected text in column "owner", got number'],
    ["a boolean", { ...TABLE, rls_enabled: "t" }, 'Expected a boolean in column "rls_enabled"'],
  ])("refuses a cell that is not %s instead of guessing", async (_kind, row, message) => {
    const failure = await introspect(engineWithTableRow(row), ["public"]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(IntrospectionError);
    expect((failure as Error).message).toContain(message);
  });

  it("refuses an unknown catalog code and a non-integer position", async () => {
    const withPolicy = (command: string): SqlExecutor => ({
      exec: async () => undefined,
      query: async (sql) => ({
        rows: sql.includes("p.polcmd::text as command")
          ? [
              {
                schema: "public",
                table_name: "t",
                name: "p",
                command,
                permissive: true,
                using_expr: null,
                check_expr: null,
              },
            ]
          : [],
        affectedRows: 0,
      }),
    });
    await expect(introspect(withPolicy("x"), ["public"])).rejects.toThrow(
      'Unknown code "x" in column "command"',
    );
    await expect(introspect(withPolicy("r"), ["public"])).resolves.toMatchObject({
      policies: [{ command: "select", roles: [], using: null, withCheck: null }],
    });

    const withColumn: SqlExecutor = {
      exec: async () => undefined,
      query: async (sql) => ({
        rows: sql.includes("a.attnum::int as position")
          ? [
              {
                schema: "public",
                table_name: "t",
                name: "c",
                position: "1",
                type: "int",
                not_null: false,
                generated: "",
                identity: "",
                expression: null,
              },
            ]
          : [],
        affectedRows: 0,
      }),
    };
    await expect(introspect(withColumn, ["public"])).rejects.toThrow(
      'Expected an integer in column "position"',
    );
  });
});
