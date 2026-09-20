/**
 * The verified-fix loop. The comparison is tested on hand-made results, one rule at a time, and
 * the whole loop once against a real PGlite with the multi-tenant template: the SQL of the fixed
 * variant must come out as verified, and SQL that keeps `WITH CHECK (true)` must not.
 */
import { describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import type { CellResult, CellStatus, MatrixResult, MatrixRun } from "@/lib/runner";
import { MAX_SQL_LENGTH, splitSqlStatements, type Operation } from "@/lib/scenario";
import { MULTI_TENANT_SAAS, TODOS_SHARING } from "@/lib/scenario/templates";
import { runLab, type LabRunOutcome, type LabRunPorts } from "./run-lab";
import type { SetupErrorView } from "./setup-error-view";
import {
  FIX_COMMENT,
  appendFixSql,
  applyProposedFix,
  cellChangeText,
  cellChangeTitle,
  compareRuns,
  unexpectedStatements,
  verifyProposedFix,
} from "./verify-fix";

const LEAKY = MULTI_TENANT_SAAS.leaky.scenario;

const REAL_FIX = `drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());`;

/** Re-creates the policy with the bug still in it. */
const WRONG_FIX = `drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (true);`;

/**
 * Leaves the leaky policy alone and rewrites the data instead: the schema runs before the seed, so
 * the trigger makes every seeded todo public and "everyone reads everything" looks expected.
 */
const MASKING_TRIGGER = `create function public.__mask() returns trigger language plpgsql as $$ begin new.is_public := true; return new; end $$;
create trigger __mask before insert on "public"."todos" for each row execute function public.__mask();`;

function cell(
  personaId: string,
  operation: Operation,
  status: CellStatus,
  leakedKeys: readonly string[] = [],
  table = "projects",
): CellResult {
  return {
    id: `${personaId}|public.${table}|${operation}`,
    personaId,
    schema: "public",
    table,
    operation,
    scope: "tenant",
    expectationSource: "explicit",
    status,
    reason: null,
    expectedKeys: [],
    actualKeys: [...leakedKeys],
    blindKeys: [],
    leakedKeys,
    missingKeys: [],
    statement: "",
    sql: "",
    perRowFallback: false,
    error: null,
    subProbes: [],
    policies: [],
    rlsBypass: null,
  };
}

function resultOf(cells: readonly CellResult[]): MatrixResult {
  const counts = { pass: 0, leak: 0, escape: 0, overblock: 0, inconclusive: 0, skipped: 0 };
  for (const each of cells) {
    counts[each.status] += 1;
  }
  const leaking = counts.leak + counts.escape > 0;
  return {
    version: 1,
    scenarioId: "test",
    mode: "supabase",
    verdict: leaking ? "LEAKING" : counts.pass > 0 ? "ISOLATED" : "NOT PROVEN",
    counts,
    totalCells: cells.length,
    missingSchemas: [],
    personas: [],
    tables: [],
    cells,
    orphanExpectations: [],
  };
}

function done(cells: readonly CellResult[]): LabRunOutcome {
  // Only `result` is read by the comparison.
  const run = { result: resultOf(cells) } as MatrixRun;
  return { kind: "done", run, findings: [] };
}

const TARGET = "alice|public.projects|update";
const BEFORE = resultOf([
  cell("alice", "select", "pass"),
  cell("alice", "update", "escape"),
  cell("bob", "update", "escape"),
  cell("bob", "delete", "overblock"),
  cell("carol", "select", "leak", ["k1"]),
  cell("anon", "select", "inconclusive"),
]);

const SETUP_ERROR: SetupErrorView = {
  phase: "schema",
  editor: "schema",
  sqlState: "42P01",
  message: 'relation "public.nope" does not exist',
  detail: null,
  hint: null,
  statement: "drop policy p on public.nope",
  statementLine: 70,
  errorLine: 70,
  timedOut: false,
};

describe("appendFixSql", () => {
  it("appends after the schema, behind a comment, and keeps both scripts whole", () => {
    const schema = "create table t (id int primary key);\n\n";
    const text = appendFixSql(schema, "  alter table t enable row level security;  ");

    expect(text).toBe(
      `create table t (id int primary key);\n\n${FIX_COMMENT}\nalter table t enable row level security;\n`,
    );
    expect(splitSqlStatements(text).map((statement) => statement.text)).toEqual([
      "create table t (id int primary key)",
      "alter table t enable row level security",
    ]);
  });

  it("terminates a last statement that has no semicolon, also behind a line comment", () => {
    for (const schema of ["create table t (id int)", "create table t (id int) -- no end;"]) {
      const statements = splitSqlStatements(appendFixSql(schema, "grant select on t to anon"));
      expect(statements).toHaveLength(2);
      expect(statements[1]?.text).toBe("grant select on t to anon");
    }
  });

  it("adds no terminator when a semicolon inside a string or a dollar quote is the last one", () => {
    const schema = "create function f() returns int language sql as $$ select 1; $$;";
    expect(appendFixSql(schema, "grant select on t to anon")).not.toContain("\n;\n");
  });

  it("works on an empty schema", () => {
    expect(appendFixSql("  \n", "grant select on t to anon;")).toBe(
      `${FIX_COMMENT}\ngrant select on t to anon;\n`,
    );
  });
});

describe("applyProposedFix", () => {
  it("returns a COPY with the SQL at the end of the schema and leaves the scenario alone", () => {
    const before = JSON.stringify(LEAKY);
    const applied = applyProposedFix(LEAKY, REAL_FIX);

    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.statementCount).toBe(2);
    expect(applied.scenario).not.toBe(LEAKY);
    expect(applied.scenario.schemaSql.startsWith(LEAKY.schemaSql.trimEnd())).toBe(true);
    expect(applied.scenario.schemaSql.endsWith(`${REAL_FIX}\n`)).toBe(true);
    expect(applied.scenario.seedSql).toBe(LEAKY.seedSql);
    expect(applied.scenario.expectations).toEqual(LEAKY.expectations);
    expect(JSON.stringify(LEAKY)).toBe(before);
  });

  it("refuses a proposal without a statement", () => {
    for (const sql of ["", "   \n", "-- nothing to change\n/* really */"]) {
      const applied = applyProposedFix(LEAKY, sql);
      expect(applied).toMatchObject({ ok: false, reason: "empty" });
    }
  });

  it("refuses a proposal that makes the schema longer than a scenario may be", () => {
    const applied = applyProposedFix(
      LEAKY,
      `create policy p on public.projects using ('${"x".repeat(MAX_SQL_LENGTH)}' = '');`,
    );

    expect(applied).toMatchObject({ ok: false, reason: "invalid" });
    expect(applied.ok ? "" : applied.message).toContain("schemaSql");
  });
});

describe("applyProposedFix: the statement allow-list", () => {
  it("refuses a proposal that holds any other kind of statement, and names it", () => {
    const proposals: readonly (readonly [string, string])[] = [
      [MASKING_TRIGGER, "create function public.__mask()"],
      [`${REAL_FIX}\ndelete from public.projects;`, "delete from public.projects"],
      [`${REAL_FIX}\nalter table public.projects disable row level security;`, "alter table"],
      [`${REAL_FIX}\nalter table public.projects drop column tenant_id;`, "alter table"],
      ["create rule r as on insert to public.projects do instead nothing", "create rule r"],
    ];
    for (const [sql, named] of proposals) {
      const applied = applyProposedFix(LEAKY, sql);

      expect(applied).toMatchObject({ ok: false, reason: "unexpected" });
      expect(applied.ok ? "" : applied.message).toContain(named);
    }
  });
});

describe("unexpectedStatements", () => {
  it("accepts ALTER TABLE only to enable or force row level security", () => {
    expect(
      unexpectedStatements(
        `alter table public.t enable row level security;
         ALTER TABLE IF EXISTS ONLY "public"."my table" FORCE ROW LEVEL SECURITY;
         alter table t enable row level security, force row level security;`,
      ),
    ).toEqual([]);
    for (const sql of [
      "alter table public.t disable row level security",
      "alter table public.t no force row level security",
      "alter table public.t enable row level security, disable trigger all",
      "alter table public.t disable trigger all",
      "alter table public.t drop column tenant_id",
      "alter table public.t alter column is_public set default true",
      "alter table public.t rename to u",
      "alter table public.t owner to anon",
      "alter table public.t enable row level security /* */ , add column x int",
    ]) {
      expect(unexpectedStatements(sql), sql).toHaveLength(1);
    }
  });

  it("accepts what the model was asked for", () => {
    expect(unexpectedStatements(REAL_FIX)).toEqual([]);
    expect(
      unexpectedStatements(
        "-- why\nALTER POLICY p ON public.t USING (true);\n/* c */ alter table public.t force row level security; GRANT select on public.t to anon; revoke all on public.t from anon",
      ),
    ).toEqual([]);
  });

  it("names every other statement by its first words", () => {
    expect(
      unexpectedStatements(
        "drop table public.projects; create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$; delete from public.projects",
      ),
    ).toEqual(["drop table public.projects", "create or replace", "delete from public.projects"]);
  });
});

describe("compareRuns", () => {
  it("verified: the target passes and nothing else changed", () => {
    const after = done([
      cell("alice", "select", "pass"),
      cell("alice", "update", "pass"),
      cell("bob", "update", "pass"),
      cell("bob", "delete", "overblock"),
      cell("carol", "select", "leak", ["k1"]),
      cell("anon", "select", "inconclusive"),
    ]);

    const outcome = compareRuns(BEFORE, after, [TARGET]);

    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") {
      return;
    }
    expect(outcome.fixed.map((change) => change.id)).toEqual([TARGET]);
    expect(outcome.fixed[0]).toMatchObject({ before: "escape", after: "pass" });
    expect(outcome.alsoFixed.map((change) => change.id)).toEqual(["bob|public.projects|update"]);
    expect(outcome.remaining.map((change) => change.id)).toEqual([
      "bob|public.projects|delete",
      "carol|public.projects|select",
    ]);
    expect(outcome.verdictBefore).toBe("LEAKING");
    // Verified for its cell; the scenario as a whole still leaks, and the outcome says so.
    expect(outcome.verdictAfter).toBe("LEAKING");
  });

  it("did not pass: the target still fails", () => {
    const outcome = compareRuns(BEFORE, done(BEFORE.cells), [TARGET]);

    expect(outcome).toMatchObject({ kind: "did-not-pass", setupError: null, regressed: [] });
    expect(outcome.kind === "did-not-pass" ? outcome.stillFailing : []).toEqual([
      expect.objectContaining({ id: TARGET, before: "escape", after: "escape" }),
    ]);
  });

  it.each<CellStatus>(["leak", "overblock", "inconclusive", "skipped"])(
    "did not pass: the target became %s, which is not a pass",
    (status) => {
      const after = done(
        BEFORE.cells.map((each) => (each.id === TARGET ? { ...each, status } : each)),
      );

      const outcome = compareRuns(BEFORE, after, [TARGET]);

      expect(outcome.kind).toBe("did-not-pass");
      expect(outcome.kind === "did-not-pass" ? outcome.stillFailing[0]?.after : null).toBe(status);
    },
  );

  it("did not pass: every target must pass, not just one", () => {
    const second = "bob|public.projects|update";
    const after = done(
      BEFORE.cells.map((each) => (each.id === TARGET ? { ...each, status: "pass" } : each)),
    );

    const outcome = compareRuns(BEFORE, after, [TARGET, second]);

    expect(outcome.kind === "did-not-pass" ? outcome.stillFailing.map((c) => c.id) : []).toEqual([
      second,
    ]);
  });

  it.each<CellStatus>(["leak", "escape", "overblock", "inconclusive", "skipped"])(
    "did not pass: the target passes but a cell that passed is %s now",
    (status) => {
      const after = done(
        BEFORE.cells.map((each) => {
          if (each.id === TARGET) {
            return { ...each, status: "pass" as const };
          }
          return each.id === "alice|public.projects|select" ? { ...each, status } : each;
        }),
      );

      const outcome = compareRuns(BEFORE, after, [TARGET]);

      expect(outcome).toMatchObject({ kind: "did-not-pass", stillFailing: [] });
      expect(outcome.kind === "did-not-pass" ? outcome.regressed : []).toEqual([
        expect.objectContaining({
          id: "alice|public.projects|select",
          before: "pass",
          after: status,
        }),
      ]);
    },
  );

  it("did not pass: a cell that passed no longer exists", () => {
    const after = done(
      BEFORE.cells
        .filter((each) => each.id !== "alice|public.projects|select")
        .map((each) => (each.id === TARGET ? { ...each, status: "pass" as const } : each)),
    );

    const outcome = compareRuns(BEFORE, after, [TARGET]);

    expect(outcome.kind === "did-not-pass" ? outcome.regressed : []).toEqual([
      expect.objectContaining({ before: "pass", after: null }),
    ]);
  });

  it("did not pass: an overblock or an unproven cell became an isolation failure", () => {
    for (const id of ["bob|public.projects|delete", "anon|public.projects|select"]) {
      const after = done(
        BEFORE.cells.map((each) => {
          if (each.id === TARGET) {
            return { ...each, status: "pass" as const };
          }
          return each.id === id ? { ...each, status: "leak" as const, leakedKeys: ["k9"] } : each;
        }),
      );

      const outcome = compareRuns(BEFORE, after, [TARGET]);

      expect(outcome.kind === "did-not-pass" ? outcome.regressed.map((c) => c.id) : []).toEqual([
        id,
      ]);
    }
  });

  it("did not pass: a cell that leaked before leaks more rows now", () => {
    const after = done(
      BEFORE.cells.map((each) => {
        if (each.id === TARGET) {
          return { ...each, status: "pass" as const };
        }
        return each.status === "leak" ? { ...each, leakedKeys: ["k1", "k2"] } : each;
      }),
    );

    const outcome = compareRuns(BEFORE, after, [TARGET]);

    expect(outcome.kind === "did-not-pass" ? outcome.regressed : []).toEqual([
      expect.objectContaining({ leakedBefore: 1, leakedAfter: 2 }),
    ]);
  });

  it("did not pass: a table the proposal created leaks; a skipped or passing new cell is fine", () => {
    const fixed = BEFORE.cells.map((each) =>
      each.id === TARGET ? { ...each, status: "pass" as const } : each,
    );

    const leakingNew = compareRuns(
      BEFORE,
      done([...fixed, cell("anon", "select", "leak", ["k"], "backdoor")]),
      [TARGET],
    );
    const harmlessNew = compareRuns(
      BEFORE,
      done([
        ...fixed,
        cell("anon", "select", "pass", [], "audit"),
        cell("anon", "insert", "skipped", [], "audit"),
      ]),
      [TARGET],
    );

    expect(leakingNew.kind === "did-not-pass" ? leakingNew.regressed : []).toEqual([
      expect.objectContaining({ id: "anon|public.backdoor|select", before: null, after: "leak" }),
    ]);
    expect(harmlessNew.kind).toBe("verified");
  });

  it("not a regression: a cell that failed before fails differently, or is gone", () => {
    const after = done(
      BEFORE.cells
        .filter((each) => each.id !== "anon|public.projects|select")
        .map((each) => {
          if (each.id === TARGET) {
            return { ...each, status: "pass" as const };
          }
          return each.id === "bob|public.projects|update"
            ? { ...each, status: "leak" as const }
            : each;
        }),
    );

    expect(compareRuns(BEFORE, after, [TARGET]).kind).toBe("verified");
  });

  it("did not pass: the SQL did not even apply", () => {
    const outcome = compareRuns(BEFORE, { kind: "setup-error", error: SETUP_ERROR }, [TARGET]);

    expect(outcome).toEqual({
      kind: "did-not-pass",
      stillFailing: [],
      regressed: [],
      setupError: SETUP_ERROR,
      verdictAfter: null,
    });
  });

  it("NOT PROVEN after: every cell inconclusive is never a verified fix", () => {
    const after = done(BEFORE.cells.map((each) => ({ ...each, status: "inconclusive" as const })));

    const outcome = compareRuns(BEFORE, after, [TARGET]);

    expect(outcome).toMatchObject({ kind: "did-not-pass", verdictAfter: "NOT PROVEN" });
    expect(outcome.kind === "did-not-pass" ? outcome.regressed.map((c) => c.id) : []).toEqual([
      "alice|public.projects|select",
    ]);
  });

  it("incomplete: cancelled, ceiling and engine failure prove nothing", () => {
    expect(compareRuns(BEFORE, { kind: "cancelled" }, [TARGET])).toMatchObject({
      kind: "incomplete",
      reason: "cancelled",
    });
    for (const reason of ["ceiling", "engine"] as const) {
      expect(
        compareRuns(BEFORE, { kind: "failed", reason, message: `stopped: ${reason}` }, [TARGET]),
      ).toEqual({ kind: "incomplete", reason, message: `stopped: ${reason}` });
    }
  });

  it("incomplete: no target, an unknown target, or a target that did not fail", () => {
    const allPass = done(BEFORE.cells.map((each) => ({ ...each, status: "pass" as const })));
    for (const targets of [
      [],
      ["nobody|public.projects|select"],
      ["alice|public.projects|select"],
      [TARGET, "anon|public.projects|select"],
    ]) {
      expect(compareRuns(BEFORE, allPass, targets)).toMatchObject({
        kind: "incomplete",
        reason: "no-target",
      });
    }
  });
});

describe("cell change texts", () => {
  it("names the cell the way the drawer does and says what happened in words", () => {
    const after = done([
      cell("alice", "update", "escape"),
      cell("carol", "select", "leak", ["k1", "k2"]),
    ]);
    const outcome = compareRuns(
      resultOf([
        cell("alice", "update", "escape"),
        cell("carol", "select", "pass"),
        cell("bob", "select", "pass"),
      ]),
      after,
      ["alice|public.projects|update"],
    );
    if (outcome.kind !== "did-not-pass") {
      throw new Error("expected did-not-pass");
    }
    const [still] = outcome.stillFailing;
    const [leaks, gone] = outcome.regressed;

    expect(still === undefined ? "" : cellChangeTitle(still)).toBe(
      "UPDATE public.projects as alice",
    );
    expect(still === undefined ? "" : cellChangeText(still)).toBe("was escape, still escape");
    expect(leaks === undefined ? "" : cellChangeText(leaks)).toBe(
      "was pass, now leak (2 rows beyond the scope)",
    );
    expect(gone === undefined ? "" : cellChangeText(gone)).toBe(
      "was pass, the cell no longer exists",
    );
  });

  it("says when a cell is new, and counts one row as one row", () => {
    const outcome = compareRuns(
      resultOf([cell("alice", "update", "escape")]),
      done([cell("alice", "update", "pass"), cell("anon", "select", "leak", ["k"], "extra")]),
      ["alice|public.projects|update"],
    );
    const change = outcome.kind === "did-not-pass" ? outcome.regressed[0] : undefined;

    expect(change === undefined ? "" : cellChangeText(change)).toBe(
      "new cell, now leak (1 row beyond the scope)",
    );
  });
});

describe("verifyProposedFix", () => {
  it("does not run anything when the proposal holds no statement", async () => {
    let runs = 0;
    const verified = await verifyProposedFix({
      scenario: LEAKY,
      before: BEFORE,
      targetCellIds: [TARGET],
      proposedPolicySql: "-- nothing",
      run: () => {
        runs += 1;
        return Promise.resolve<LabRunOutcome>({ kind: "cancelled" });
      },
    });

    expect(runs).toBe(0);
    expect(verified).toMatchObject({
      schemaSql: null,
      outcome: { kind: "incomplete", reason: "not-applied" },
    });
  });

  it("does not run, and never verifies, a proposal with statements outside the allow-list", async () => {
    let runs = 0;
    const verified = await verifyProposedFix({
      scenario: TODOS_SHARING.leaky.scenario,
      before: BEFORE,
      targetCellIds: [TARGET],
      proposedPolicySql: MASKING_TRIGGER,
      run: () => {
        runs += 1;
        return Promise.resolve<LabRunOutcome>({ kind: "cancelled" });
      },
    });

    expect(runs).toBe(0);
    expect(verified.schemaSql).toBeNull();
    expect(verified.outcome).toMatchObject({ kind: "incomplete", reason: "not-applied" });
    expect(verified.outcome.kind === "incomplete" ? verified.outcome.message : "").toContain(
      "create function public.__mask()",
    );
  });

  it("hands the COPY and the options to the run, and compares what comes back", async () => {
    const controller = new AbortController();
    const seen: { schemaSql: string; signal: AbortSignal | undefined }[] = [];
    const verified = await verifyProposedFix({
      scenario: LEAKY,
      before: BEFORE,
      targetCellIds: [TARGET],
      proposedPolicySql: REAL_FIX,
      options: { signal: controller.signal },
      run: (scenario, options) => {
        seen.push({ schemaSql: scenario.schemaSql, signal: options?.signal });
        return Promise.resolve<LabRunOutcome>({ kind: "cancelled" });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.schemaSql).toContain(REAL_FIX);
    expect(seen[0]?.signal).toBe(controller.signal);
    expect(verified.schemaSql).toBe(seen[0]?.schemaSql);
    expect(verified.outcome).toMatchObject({ kind: "incomplete", reason: "cancelled" });
  });

  describe("against a real database (PGlite in Node)", () => {
    const ports: LabRunPorts = {
      createEngine: async () => {
        const engine = await createPgliteEngine();
        return { engine, terminate: () => void engine.close().catch(() => undefined) };
      },
      supabase: SUPABASE_SETUP_SQL,
    };
    const run = (scenario: typeof LEAKY): Promise<LabRunOutcome> => runLab(scenario, ports);

    it("does not call a trigger that masks the seed data a fix of the leaky policy", async () => {
      const scenario = TODOS_SHARING.leaky.scenario;
      const before = await run(scenario);
      if (before.kind !== "done") {
        throw new Error(`the leaky template did not run: ${before.kind}`);
      }
      const target = "anon|public.todos|select";
      expect(before.run.result.cells.find((each) => each.id === target)?.status).toBe("leak");

      const masked = await verifyProposedFix({
        scenario,
        before: before.run.result,
        targetCellIds: [target],
        proposedPolicySql: MASKING_TRIGGER,
        run,
      });

      expect(masked.outcome.kind).toBe("incomplete");
      expect(masked.schemaSql).toBeNull();
    }, 120_000);

    it("verifies the fix of the fixed variant and refuses one that keeps the bug", async () => {
      const before = await run(LEAKY);
      if (before.kind !== "done") {
        throw new Error(`the leaky template did not run: ${before.kind}`);
      }
      const target = "alice|public.projects|update";
      expect(before.run.result.cells.find((each) => each.id === target)?.status).toBe("escape");
      const input = {
        scenario: LEAKY,
        before: before.run.result,
        targetCellIds: [target],
        run,
      };

      const real = await verifyProposedFix({ ...input, proposedPolicySql: REAL_FIX });
      const wrong = await verifyProposedFix({ ...input, proposedPolicySql: WRONG_FIX });
      const broken = await verifyProposedFix({
        ...input,
        proposedPolicySql: "drop policy projects_update on public.no_such_table;",
      });

      expect(real.outcome).toMatchObject({
        kind: "verified",
        verdictBefore: "LEAKING",
        verdictAfter: "ISOLATED",
        remaining: [],
      });
      expect(
        real.outcome.kind === "verified" ? real.outcome.alsoFixed.map((c) => c.id) : [],
      ).toEqual(["bob|public.projects|update", "carol|public.projects|update"]);
      expect(wrong.outcome).toMatchObject({
        kind: "did-not-pass",
        setupError: null,
        regressed: [],
      });
      expect(
        wrong.outcome.kind === "did-not-pass" ? wrong.outcome.stillFailing.map((c) => c.id) : [],
      ).toEqual([target]);
      expect(broken.outcome).toMatchObject({
        kind: "did-not-pass",
        setupError: { phase: "schema", sqlState: "42P01" },
      });
    }, 120_000);
  });
});
