/**
 * The SQL runtime against the TypeScript it mirrors, in a real PGlite: a 42501 must be read by
 * the exported file exactly as `classify.ts` reads it, and keys must compare as whole keys.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { runtimeName, runtimeSql } from "@/lib/export/runtime";
import { isBlocked, isRowSecurityViolation, isStatementDenial } from "@/lib/runner";
import type { SqlEngine } from "@/lib/runner/types";

const FAILURES: readonly (readonly [sqlState: string, message: string])[] = [
  ["42501", "permission denied for table notes"],
  ["42501", "permission denied for view v"],
  ["42501", "permission denied for function is_member"],
  ["42501", "permission denied for schema private"],
  ["42501", "permission denied for schemas"],
  ["42501", "permission denied for type private.status"],
  ["42501", "permission denied for sequence notes_id_seq"],
  ["42501", "permission denied for foreign-data wrapper w"],
  ["42501", "permission denied for large object 1"],
  ["42501", "permission denied for parameter x"],
  ["42501", 'new row violates row-level security policy for table "notes"'],
  ["42501", 'new row violates row-level security policy "p" for table "notes"'],
  ["42501", 'query would be affected by row-level security policy for table "notes"'],
  ["42501", "not yours"],
  ["42501", "it says: permission denied for schema private"],
  ["23505", 'duplicate key value violates unique constraint "k"'],
  ["23503", "permission denied for table notes"],
  ["22P02", "invalid input syntax for type uuid"],
  ["RLT01", "A statement the runner sends as the superuser failed: [42501] permission denied"],
];

describe("the SQL runtime", () => {
  let engine: SqlEngine;

  beforeAll(async () => {
    engine = await createPgliteEngine();
    await engine.exec(runtimeSql(3, "fail"));
  }, 60_000);

  afterAll(async () => {
    await engine.close();
  });

  it.each(FAILURES)("reads [%s] %s as classify.ts does", async (sqlState, message) => {
    const { rows } = await engine.query(
      `select ${runtimeName("blocked")}($1, $2) as blocked,
              ${runtimeName("row_violation")}($1, $2) as row_violation,
              ${runtimeName("statement_denial")}($1, $2) as statement_denial`,
      [sqlState, message],
    );
    const failure = { sqlState, message };
    expect(rows).toEqual([
      {
        blocked: isBlocked(failure),
        row_violation: isRowSecurityViolation(failure),
        statement_denial: isStatementDenial(failure),
      },
    ]);
  });

  it("compares keys as whole keys: order and length of a composite key matter", async () => {
    const { rows } = await engine.query(
      `select ${runtimeName("minus")}('[["1","2"],["2","1"],["3","3"]]', '[["2","1"],["3"]]')::text as minus,
              ${runtimeName("unite")}('[["b"],["a"]]', '[["a"],["c"]]')::text as united,
              ${runtimeName("has_key")}('[["1","2"]]', '["2","1"]') as swapped,
              ${runtimeName("has_key")}('[["1","2"]]', '["1","2"]') as same,
              ${runtimeName("keys")}('[{"k0":"2","k1":"x"},{"k0":"1","k1":"y"},{"k0":"2","k1":"x"}]', 2)::text as keys`,
    );
    expect(rows).toEqual([
      {
        minus: '[["1", "2"], ["3", "3"]]',
        united: '[["a"], ["b"], ["c"]]',
        swapped: false,
        same: true,
        keys: '[["1", "y"], ["2", "x"]]',
      },
    ]);
  });

  it("a blind UPDATE touched the rows whose version changed or that are gone", async () => {
    const { rows } = await engine.query(
      `select ${runtimeName("touched")}(
         '[{"k0":"1","row_version":"t:(0,1)"},{"k0":"2","row_version":"t:(0,2)"},{"k0":"3","row_version":"t:(0,3)"}]',
         '[{"k0":"1","row_version":"t:(0,1)"},{"k0":"2","row_version":"t:(0,9)"}]', 1)::text as touched`,
    );
    expect(rows).toEqual([{ touched: '[["2"], ["3"]]' }]);
  });

  it("refuses to probe as anyone but the persona, and with row_security off", async () => {
    await engine.exec("create role app_user nologin");
    const become = (identity: string, role: string): Promise<unknown> =>
      engine.query(`select ${runtimeName("become")}(array[${identity}]::text[], $1)`, [role]);
    await expect(become("'select 1'", "app_user")).rejects.toMatchObject({
      code: "RLT02",
      message: expect.stringContaining('would have run as "postgres" instead of "app_user"'),
    });
    await expect(
      become(
        `$$select set_config('role', 'app_user', true), set_config('row_security', 'off', true)$$`,
        "app_user",
      ),
    ).rejects.toMatchObject({
      code: "RLT02",
      message: expect.stringContaining("row_security = off"),
    });
  });

  it("a failing superuser statement never looks like a refusal", async () => {
    await expect(
      engine.query(`select ${runtimeName("superuser_rows")}('select * from no_such_table')`),
    ).rejects.toMatchObject({
      code: "RLT01",
      message: expect.stringContaining("as the superuser failed: [42P01]"),
    });
    await expect(
      engine.query(`select ${runtimeName("superuser_exec")}(array['select 1', 'select 1/0'])`),
    ).rejects.toMatchObject({ code: "RLT01", message: expect.stringContaining("[22012]") });
  });
});
