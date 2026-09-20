/**
 * What the export relies on in the matrix runner, pinned: the plan contexts a run returns, and
 * that the setup file holds exactly the statements `setupDatabase` runs before the schema.
 */
import { describe, expect, it } from "vitest";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import {
  cellId,
  planBlindUpdate,
  planEscapes,
  supabaseGrantsOf,
  supabasePrelude,
  updateReachColumn,
} from "@/lib/runner";
import { setupDatabase } from "@/lib/runner/setup";
import type { SqlEngine } from "@/lib/runner/types";
import { splitSqlStatements } from "@/lib/scenario";
import { MULTI_TENANT_SAAS } from "@/lib/scenario/templates";
import { run } from "../runner/helpers";
import { REACH_SHAPES } from "./fixtures";
import { contextOf } from "./unit-support";

describe("MatrixRun.cellContexts", () => {
  it("holds one context per probed cell, in cell order, and stays out of the result JSON", async () => {
    const { result, cellContexts } = await run(REACH_SHAPES);
    const probed = cellContexts.map((context) => cellId(context.expectation));
    expect(new Set(probed).size).toBe(probed.length);
    expect(result.cells.map((cell) => cell.id).filter((id) => probed.includes(id))).toEqual(probed);
    const unprobed = result.cells.filter((cell) => !probed.includes(cell.id));
    expect(unprobed.length).toBeGreaterThan(0);
    for (const cell of unprobed) {
      // Skipped, or inconclusive because its expectedRowsSql failed: no probe ever ran.
      expect(["skipped", "inconclusive"], cell.id).toContain(cell.status);
      expect([cell.sql, cell.statement, cell.subProbes], cell.id).toEqual(["", "", []]);
    }
    // An insert cell records no expected keys of its own; its sub-probes carry the expectation.
    for (const context of cellContexts.filter(
      (entry) => entry.expectation.operation !== "insert",
    )) {
      const cell = result.cells.find((candidate) => candidate.id === cellId(context.expectation));
      expect([...context.expectedKeys].sort(), cell?.id).toEqual(
        [...(cell?.expectedKeys ?? [])].sort(),
      );
    }
    expect(JSON.stringify(result)).not.toContain("updatableColumns");
  }, 60_000);
});

describe("the planners the export shares with the cells", () => {
  it("updateReachColumn prefers a readable column; planBlindUpdate needs an UPDATE grant and a row", () => {
    const context = contextOf("update", "own");
    expect(updateReachColumn(context)).toBe("body");
    expect(updateReachColumn({ ...context, selectableColumns: new Set(["id", "user_id"]) })).toBe(
      "user_id",
    );
    expect(planBlindUpdate(context)).toMatchObject({ sourceKey: '["1"]' });
    expect(planBlindUpdate({ ...context, updatableColumns: new Set() })).toBeNull();
    expect(planBlindUpdate({ ...context, truth: { ...context.truth, rows: [] } })).toBeNull();
  });

  it("planEscapes: the scope column first, the tenant column as well under scope own", () => {
    const own = planEscapes(contextOf("update", "own"), ['["1"]']);
    expect(own.map((plan) => (plan.status === "ok" ? plan.move.column : plan.reason))).toEqual([
      "user_id",
      "tenant_id",
    ]);
    const tenant = planEscapes(contextOf("update", "tenant"), []);
    expect(tenant).toEqual([
      {
        status: "skipped",
        reason: "The persona can update no row inside its scope, so there is nothing to move.",
      },
    ]);
  });
});

describe("supabasePrelude", () => {
  it("is empty in postgres mode and names the regime in supabase mode", () => {
    expect(supabasePrelude({ mode: "postgres" }, SUPABASE_SETUP_SQL)).toEqual([]);
    expect(supabaseGrantsOf({ mode: "postgres" })).toBeNull();
    expect(supabaseGrantsOf({ mode: "supabase" })).toBe("legacy");
    expect(
      supabaseGrantsOf({
        mode: "supabase",
        options: { exposedSchemas: ["public"], supabaseGrants: "explicit" },
      }),
    ).toBe("explicit");
  });

  it("is exactly what setupDatabase sends before the first statement of the schema", async () => {
    const scenario = {
      ...MULTI_TENANT_SAAS.fixed.scenario,
      options: { exposedSchemas: ["public", "api"], supabaseGrants: "legacy" as const },
    };
    const sent: string[] = [];
    const recorder: SqlEngine = {
      exec: (sql) => {
        sent.push(sql);
        // The open-transaction check expects "no transaction is open".
        return sql.startsWith("savepoint ")
          ? Promise.reject(Object.assign(new Error("no transaction"), { code: "25P01" }))
          : Promise.resolve();
      },
      query: () => Promise.resolve({ rows: [], affectedRows: 0 }),
      transaction: () => Promise.reject(new Error("not used")),
      close: () => Promise.resolve(),
    };
    await setupDatabase(recorder, scenario, SUPABASE_SETUP_SQL).catch(() => undefined);
    const firstOfSchema = splitSqlStatements(scenario.schemaSql)[0]?.text ?? "";
    const before = sent.slice(1, sent.indexOf(firstOfSchema));
    const prelude = supabasePrelude(scenario, SUPABASE_SETUP_SQL).flatMap(({ script }) =>
      splitSqlStatements(script).map((statement) => statement.text),
    );
    expect(sent[0]).toBe("set time zone 'UTC'");
    expect(prelude.length).toBeGreaterThan(10);
    expect(before).toEqual(prelude);
  });
});
