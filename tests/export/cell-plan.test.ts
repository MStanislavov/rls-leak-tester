/**
 * The plan of one exported cell, from hand-built contexts: which statements of the shared
 * builders end up in it, in which spelling, and what is skipped.
 */
import { describe, expect, it } from "vitest";
import { maxParamsOf, planCell, type CellPlan } from "@/lib/export/cell-plan";
import {
  NO_ROW_TO_CLONE_REMARK,
  NO_WRITABLE_COLUMN_REMARK,
  planBlindUpdate,
  updateRowProbe,
} from "@/lib/runner";
import { ALICE, NOTES, NOTES_TRUTH, column, contextOf } from "./unit-support";

function planOf<K extends CellPlan["kind"]>(
  plan: CellPlan,
  kind: K,
): Extract<CellPlan, { kind: K }> {
  if (plan.kind !== kind) {
    throw new Error(`Expected a ${kind} plan, got ${plan.kind}`);
  }
  return plan as Extract<CellPlan, { kind: K }>;
}

describe("planCell", () => {
  it("heads every cell with its id, label, identity statements and sorted keys", () => {
    const plan = planOf(planCell(contextOf("select", "tenant"), "Alice"), "select");
    expect(plan).toMatchObject({
      id: "alice|public.notes|select",
      label: "Alice as role app_user: SELECT on public.notes, scope tenant",
      role: "app_user",
      keyColumns: 1,
      expectedKeys: ['["1"]', '["2"]'],
      truthKeys: ['["1"]', '["2"]', '["3"]'],
      reach: 'select "id"::text as k0 from "public"."notes"',
      count: 'select count(*)::text as visible_rows from "public"."notes"',
    });
    expect(plan.identity).toHaveLength(3);
    expect(plan.identity[0]).toBe("select set_config('role', 'app_user', true)");
    expect(plan.identity[1]).toContain(`'{"sub":"${ALICE}","tenant_id":1}'`);
    expect(plan.identity[2]).toContain("set_config('row_security', 'on', true)");
    expect(maxParamsOf(plan)).toBe(0);
  });

  it("a per-row statement keeps its parameters, and its text does not depend on the key", () => {
    const plan = planOf(planCell(contextOf("delete", "own"), "Alice"), "delete");
    expect(plan.row).toEqual({
      sql: 'delete from "public"."notes" where "id"::text = $1::text returning "id"::text as k0',
      values: [],
    });
    expect(plan.blind).toBe('delete from "public"."notes"');
    expect(plan.readKeys).toBe('select "id"::text as k0 from "public"."notes"');
    expect(maxParamsOf(plan)).toBe(1);
    const update = planOf(planCell(contextOf("update", "own"), "Alice"), "update");
    expect(update.row.sql).toBe(updateRowProbe(NOTES_TRUTH, "body", '["1"]').sql);
    expect(update.row.sql).toBe(updateRowProbe(NOTES_TRUTH, "body", '["999"]').sql);
    expect(update.row.sql).not.toContain("''");
  });

  it("update: takeover variants, the blind plan, and one escape pair per moved column", () => {
    const plan = planOf(planCell(contextOf("update", "own"), "Alice"), "update");
    expect(plan.reach).toBe(
      'update "public"."notes" set "body" = "body" returning "id"::text as k0',
    );
    expect(plan.pulls.map((pull) => pull.values)).toEqual([[ALICE, "1"], [ALICE], ["1"]]);
    expect(plan.pulls[0]?.sql).toBe(
      'update "public"."notes" set "user_id" = $1::text::uuid, "tenant_id" = $2::text::integer where "id"::text = $3::text returning "id"::text as k0',
    );
    expect(plan.blind?.source).toEqual([
      `create temporary table "rls_leak_tester_source" on commit drop as select * from "public"."notes" where "id"::text = '1'`,
      'grant select on pg_temp."rls_leak_tester_source" to "app_user"',
    ]);
    expect(plan.blind?.constants[0]).toBe(
      'update "public"."notes" set "body" = (select "body" from pg_temp."rls_leak_tester_source")',
    );
    expect(plan.blind?.pulls).toHaveLength(3);
    // Scope own with a tenant claim: the owner column moves, and the tenant column as well.
    expect(plan.escapes.map((escape) => escape.label)).toEqual([
      "user_id = 22222222-2222-4222-8222-222222222222",
      "tenant_id = 2",
    ]);
    expect(plan.escapes[1]).toMatchObject({
      targeted: { values: ["2"] },
      bulk: `update "public"."notes" set "tenant_id" = '2'::integer`,
      read: `select "id"::text as k0 from "public"."notes" where "tenant_id"::text = '2'`,
      before: ['["3"]'],
    });
    expect(plan.skippedEscapes).toEqual([]);
    expect(maxParamsOf(plan)).toBe(3);
  });

  it("update: an escape that can never run is a reason", () => {
    const plan = planOf(planCell(contextOf("update", "all"), "Alice"), "update");
    expect(plan.escapes).toEqual([]);
    expect(plan.skippedEscapes).toEqual([
      'Every row is inside scope "all": there is nowhere to escape to.',
    ]);
  });

  it("update: the blind plan also names columns the role holds no UPDATE on, after the granted ones", () => {
    // The runner plans no blind UPDATE without a grant (planBlindUpdate is null). The exported
    // file outlives the grants of its run: a later `grant update` must be measured, not skipped.
    const none = { updatableColumns: new Set<string>() };
    expect(planBlindUpdate(contextOf("update", "own", none))).toBeNull();
    const ungranted = planOf(planCell(contextOf("update", "own", none), "Alice"), "update");
    expect(ungranted.blind?.constants).toEqual([
      'update "public"."notes" set "body" = (select "body" from pg_temp."rls_leak_tester_source")',
      'update "public"."notes" set "user_id" = (select "user_id" from pg_temp."rls_leak_tester_source")',
      'update "public"."notes" set "tenant_id" = (select "tenant_id" from pg_temp."rls_leak_tester_source")',
    ]);
    expect(ungranted.blind?.source).toHaveLength(2);
    expect(ungranted.blind?.versions).toContain('from "public"."notes"');
    const partly = { updatableColumns: new Set(["tenant_id"]) };
    const plan = planOf(planCell(contextOf("update", "own", partly), "Alice"), "update");
    expect(plan.blind?.constants.map((sql) => /set "(\w+)"/.exec(sql)?.[1])).toEqual([
      "tenant_id",
      "body",
      "user_id",
    ]);
    // Nothing to read a value from: no blind plan, as in the runner.
    const empty = { ...NOTES_TRUTH, rows: [] };
    expect(
      planOf(planCell(contextOf("update", "own", { truth: empty }), "Alice"), "update").blind,
    ).toBeNull();
  });

  it("update: a table whose every column is generated is skipped with the runner's reason", () => {
    const generated = {
      ...NOTES,
      columns: [column("id", "integer", { identity: "always" })],
    };
    expect(planCell(contextOf("update", "own", { table: generated }), "Alice")).toEqual({
      kind: "skipped",
      id: "alice|public.notes|update",
      operation: "update",
      label: "Alice as role app_user: UPDATE on public.notes, scope own",
      reason: NO_WRITABLE_COLUMN_REMARK,
    });
  });

  it("insert: one clone per class and side, all through the same insert statement", () => {
    const plan = planOf(planCell(contextOf("insert", "own"), "Alice"), "insert");
    expect(plan.grant).toBe('grant select on pg_temp."rls_leak_tester_source" to "app_user"');
    expect(plan.clones.map(({ kind, expected, sourceKey }) => [kind, expected, sourceKey])).toEqual(
      [
        ["insert-own", "allowed", '["1"]'],
        ["insert-same-tenant", "blocked", '["2"]'],
        ["insert-other", "blocked", '["3"]'],
      ],
    );
    expect(new Set(plan.clones.map((clone) => clone.insert))).toEqual(
      new Set([
        `insert into "public"."notes" ("id", "user_id", "tenant_id", "body") select '1003'::integer, "user_id", "tenant_id", "body" from pg_temp."rls_leak_tester_source"`,
      ]),
    );
    expect(plan.clones[1]?.source).toContain(`where "id"::text = '2'`);
    expect(maxParamsOf(plan)).toBe(0);
  });

  it("insert: nothing to clone, or no fresh key, is skipped with the runner's reason", () => {
    const empty = { ...NOTES_TRUTH, rows: [] };
    expect(planCell(contextOf("insert", "own", { truth: empty }), "Alice")).toMatchObject({
      kind: "skipped",
      reason: NO_ROW_TO_CLONE_REMARK,
    });
    const textKey = { ...NOTES, columns: [column("id", "text"), ...NOTES.columns.slice(1)] };
    const skipped = planCell(contextOf("insert", "own", { table: textKey }), "Alice");
    expect(skipped.kind).toBe("skipped");
    expect(planOf(skipped, "skipped").reason).toContain("No fresh value can be made");
  });
});
