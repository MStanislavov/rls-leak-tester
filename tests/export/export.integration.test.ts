/**
 * The CI export, tested by EXECUTING its output (brief 3.8, 5.1) in a fresh PGlite that was
 * prepared the way the exported workflow prepares Postgres:
 *
 * - every template: the fixed variant runs green, the leaky variant fails, and the exception
 *   names exactly the cells the template declares as failing;
 * - the database is unchanged afterwards, whether the file passed or failed;
 * - fixtures with every probe shape the templates lack: the exported file reports exactly the
 *   cells, statuses and keys the matrix runner reports (the two cannot drift unnoticed).
 *
 * `scripts/verify-export-postgres.sh` runs the same files against a real Postgres in Docker.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CI_EXPORT_FILE_NAMES } from "@/lib/export";
import { cellId, type CellResult } from "@/lib/runner";
import { compareText, type Scenario } from "@/lib/scenario";
import {
  MULTI_TENANT_SAAS,
  TEMPLATES,
  TODOS_SHARING,
  templateVariants,
  type TemplateVariant,
} from "@/lib/scenario/templates";
import { tenantScenario } from "../runner/fixtures";
import {
  COLUMN_GRANTS,
  ESCAPES_AND_INSERTS,
  HOSTILE_TEXT,
  HOSTILE_TEXT_LEAKY,
  NOTHING_TO_PROVE,
  REACH_SHAPES,
  SESSION_STATE,
  SUPABASE_BLIND,
  writeOnlyGrant,
} from "./fixtures";
import {
  cellIdsOf,
  dumpEverything,
  exportOf,
  failedCells,
  fileOf,
  prepareLikeWorkflow,
  runTestFile,
  type Exported,
  type TestFileOutcome,
} from "./helpers";

const TIMEOUT_MS = 120_000;
const { test: TEST_SQL } = CI_EXPORT_FILE_NAMES;

interface Executed extends Exported {
  readonly outcome: TestFileOutcome;
  readonly before: string;
  readonly after: string;
}

async function execute(scenario: Scenario, inconclusive?: "fail" | "warn"): Promise<Executed> {
  const exported = await exportOf(scenario, inconclusive === undefined ? {} : { inconclusive });
  const engine = await prepareLikeWorkflow(exported.ciExport);
  try {
    const before = await dumpEverything(engine);
    const outcome = await runTestFile(engine, fileOf(exported.ciExport, TEST_SQL));
    return { ...exported, outcome, before, after: await dumpEverything(engine) };
  } finally {
    await engine.close();
  }
}

/** `status id`, sorted: the form the declaration and the exception are compared in. */
function declared(variant: TemplateVariant): string[] {
  return variant.expectedFailures
    .map(
      (failure) =>
        `${failure.status} ${failure.personaId}|${failure.schema}.${failure.table}|${failure.operation}`,
    )
    .sort(compareText);
}

function reported(outcome: TestFileOutcome, exported: Pick<Exported, "matrix">): string[] {
  return outcome.passed
    ? []
    : failedCells(outcome.error, cellIdsOf(exported))
        .map((cell) => `${cell.status} ${cell.id}`)
        .sort(compareText);
}

describe.each(TEMPLATES.map((template) => ({ id: template.id, template })))(
  "exported check of the template $id",
  ({ template }) => {
    let fixed: Executed;
    let leaky: Executed;

    beforeAll(async () => {
      fixed = await execute(template.fixed.scenario);
      leaky = await execute(template.leaky.scenario);
    }, TIMEOUT_MS);

    it("the fixed variant runs green", () => {
      expect(fixed.outcome).toEqual({ passed: true });
      expect(fixed.ciExport.skippedCells).toBe(0);
      expect(fixed.ciExport.checkedCells).toBe(fixed.matrix.result.totalCells);
    });

    it("the leaky variant fails, and the exception names exactly the declared cells", () => {
      expect(leaky.outcome.passed).toBe(false);
      expect(declared(template.leaky)).not.toEqual([]);
      expect(reported(leaky.outcome, leaky)).toEqual(declared(template.leaky));
      if (!leaky.outcome.passed) {
        expect(leaky.outcome.error.code).toBe("P0001");
        expect(leaky.outcome.error.message).toMatch(/^RLS Leak Tester: LEAKING\. /);
        for (const failure of template.leaky.expectedFailures) {
          const persona = template.leaky.scenario.personas.find(
            (candidate) => candidate.id === failure.personaId,
          );
          // Readable: persona, role, operation, table and the keys are all in the line.
          expect(leaky.outcome.error.message).toContain(
            `${persona?.label} as role ${persona?.dbRole}: ${failure.operation.toUpperCase()} on ${failure.schema}.${failure.table}`,
          );
        }
      }
    });

    it("leaves the database unchanged, green or red", () => {
      expect(fixed.after).toBe(fixed.before);
      expect(leaky.after).toBe(leaky.before);
    });
  },
);

describe("determinism", () => {
  it.each(templateVariants().map(({ variant }) => ({ id: variant.scenario.id, variant })))(
    "$id: two independent runs export byte-identical files",
    async ({ variant }) => {
      const first = await exportOf(variant.scenario);
      const second = await exportOf(variant.scenario);
      expect(second.ciExport.files).toEqual(first.ciExport.files);
      expect(first.ciExport.files.map((file) => file.name)).toEqual([
        CI_EXPORT_FILE_NAMES.setup,
        CI_EXPORT_FILE_NAMES.schema,
        CI_EXPORT_FILE_NAMES.seed,
        CI_EXPORT_FILE_NAMES.test,
        CI_EXPORT_FILE_NAMES.workflow,
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "the same file gives the same answer twice in one session",
    async () => {
      const exported = await exportOf(MULTI_TENANT_SAAS.leaky.scenario);
      const { ciExport } = exported;
      const engine = await prepareLikeWorkflow(ciExport);
      try {
        const first = await runTestFile(engine, fileOf(ciExport, TEST_SQL));
        const second = await runTestFile(engine, fileOf(ciExport, TEST_SQL));
        expect(first.passed).toBe(false);
        expect(reported(second, exported)).toEqual(reported(first, exported));
      } finally {
        await engine.close();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------------------------
// The export against the runner, cell by cell
// ---------------------------------------------------------------------------------------------

interface ReportedCell {
  readonly id: string;
  readonly status: string;
  readonly leakedKeys: string[];
  readonly missingKeys: string[];
}

const KEYS_IN_LINE = /: leaked keys (none|\[.*?\]); missing keys (none|\[.*?\])(;|$)/;

/** `[["1"], ["2"]]` as the runner spells keys: `["1"]`, `["2"]`. */
function keysOf(text: string | undefined): string[] {
  if (text === undefined || text === "none") {
    return [];
  }
  return (JSON.parse(text) as string[][]).map((key) => JSON.stringify(key));
}

function reportedCells(executed: Executed): ReportedCell[] {
  const { outcome } = executed;
  if (outcome.passed) {
    return [];
  }
  return failedCells(outcome.error, cellIdsOf(executed)).map(({ id, status, line }) => {
    const match = KEYS_IN_LINE.exec(line);
    return { id, status, leakedKeys: keysOf(match?.[1]), missingKeys: keysOf(match?.[2]) };
  });
}

/** What the runner says about the cells it probed and did not pass, in the same shape. */
function runnerCells(executed: Executed): ReportedCell[] {
  const probed = new Set(
    executed.matrix.cellContexts.map((context) => cellId(context.expectation)),
  );
  return executed.matrix.result.cells
    .filter((cell: CellResult) => probed.has(cell.id))
    .filter((cell) => cell.status !== "pass" && cell.status !== "skipped")
    .map((cell) => ({
      id: cell.id,
      status: cell.status,
      leakedKeys: [...cell.leakedKeys],
      missingKeys: [...cell.missingKeys],
    }));
}

const FIXTURES = [
  { scenario: REACH_SHAPES, green: false },
  { scenario: ESCAPES_AND_INSERTS, green: false },
  { scenario: SUPABASE_BLIND, green: false },
  { scenario: tenantScenario("leaky"), green: false },
  { scenario: tenantScenario("fixed"), green: true },
  { scenario: HOSTILE_TEXT, green: true },
  { scenario: HOSTILE_TEXT_LEAKY, green: false },
  { scenario: SESSION_STATE, green: true },
  { scenario: COLUMN_GRANTS, green: false },
  { scenario: writeOnlyGrant(true), green: false },
].map((fixture) => ({ id: fixture.scenario.id, ...fixture }));

describe.each(FIXTURES)("the exported check agrees with the matrix runner: $id", (fixture) => {
  const { scenario, green } = fixture;
  let executed: Executed;

  beforeAll(async () => {
    executed = await execute(scenario);
  }, TIMEOUT_MS);

  it("reports the same cells with the same status and the same leaked and missing keys", () => {
    const fromRunner = runnerCells(executed);
    expect(fromRunner.length === 0).toBe(green);
    expect(executed.outcome.passed).toBe(green);
    expect(reportedCells(executed)).toEqual(fromRunner);
  });

  it("counts every probed cell, and turns every other cell into a comment with its reason", () => {
    const { ciExport, matrix } = executed;
    expect(ciExport.checkedCells + ciExport.skippedCells).toBe(matrix.result.totalCells);
    const sql = fileOf(ciExport, TEST_SQL);
    for (const cell of matrix.result.cells.filter((candidate) => candidate.status === "skipped")) {
      expect(sql).toContain(`${cell.id}: `);
      expect(sql).toContain(`-- NOT CHECKED: `);
      expect(sql).toContain((cell.reason ?? "").slice(0, 40));
    }
    if (!executed.outcome.passed) {
      // The counts are the runner's over the probed cells, status by status: a leak is never
      // lumped with an overblock. (A cell whose expectedRowsSql failed is a comment, not a check.)
      const failed = runnerCells(executed).map((cell) => cell.status);
      const count = (...statuses: string[]): number =>
        failed.filter((status) => statuses.includes(status)).length;
      const counts = {
        leak: count("leak"),
        escape: count("escape"),
        overblock: count("overblock"),
        inconclusive: count("inconclusive"),
        pass: matrix.result.counts.pass,
      };
      const [headline = ""] = executed.outcome.error.message.split("\n");
      expect(headline).toContain(
        `Of ${ciExport.checkedCells} checked cells: ${counts.leak + counts.escape} leaked or escaped, ${counts.overblock} overblocked, ${counts.inconclusive} inconclusive, ${counts.pass} passed; 0 warnings.`,
      );
      expect(headline.startsWith("RLS Leak Tester: LEAKING. ")).toBe(
        counts.leak + counts.escape > 0,
      );
    }
  });

  it("leaves the database unchanged", () => {
    expect(executed.after).toBe(executed.before);
  });
});

describe("a quoted name with a space is really compared", () => {
  it(
    "the leaky hostile fixture reports its cells under their full ids",
    async () => {
      const executed = await execute(HOSTILE_TEXT_LEAKY);
      const ids = reportedCells(executed).map((cell) => cell.id);

      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids)
        expect(id).toMatch(/^alice\|public\.Odd "Table\|(select|insert|update|delete)$/);
      expect(reportedCells(executed)).toContainEqual(
        expect.objectContaining({
          id: 'alice|public.Odd "Table|select',
          status: "leak",
          leakedKeys: ['["2"]'],
        }),
      );
    },
    TIMEOUT_MS,
  );
});

describe("the fixtures reach every branch of the runtime", () => {
  it(
    "reach shapes: per-row fallback, takeover, blind shapes, the row count, skipped cells",
    async () => {
      const { result } = (await exportOf(REACH_SHAPES)).matrix;
      const statusOf = (id: string): string | undefined =>
        result.cells.find((cell) => cell.id === id)?.status;
      expect(result.cells.some((cell) => cell.perRowFallback)).toBe(true);
      expect(result.cells.some((cell) => cell.blindKeys.length > 0)).toBe(true);
      expect(statusOf("alice|public.notes_leaky|update")).toBe("leak");
      expect(statusOf("alice|public.notes_blind|delete")).toBe("leak");
      expect(statusOf("alice|public.notes_locked|select")).toBe("overblock");
      expect(statusOf("alice|public.one_each|update")).toBe("inconclusive");
      expect(statusOf("alice|public.folders|delete")).toBe("inconclusive");
      expect(statusOf("alice|public.counters|update")).toBe("leak");
      expect(statusOf("alice|public.slugs|update")).toBe("leak");
      expect(statusOf("alice|public.only_unique|update")).toBe("inconclusive");
      expect(statusOf("visitor|public.profiles|select")).toBe("leak");
      expect(statusOf("visitor|public.half|select")).toBe("inconclusive");
      expect(statusOf("visitor|public.hidden|select")).toBe("pass");
      expect(statusOf("visitor|public.broken|select")).toBe("inconclusive");
      expect(statusOf("alice|public.notes_ok|select")).toBe("inconclusive");
      expect(statusOf("ghost|public.notes_ok|select")).toBe("skipped");
      expect(statusOf("alice|public.nopk|select")).toBe("skipped");
    },
    TIMEOUT_MS,
  );

  it(
    "escapes and inserts: both escape shapes, the tenant move, overblock, constraint errors",
    async () => {
      const { result } = (await exportOf(ESCAPES_AND_INSERTS)).matrix;
      const cellOf = (id: string): CellResult | undefined =>
        result.cells.find((cell) => cell.id === id);
      const escaped = (id: string): string[] =>
        (cellOf(id)?.subProbes ?? [])
          .filter((probe) => probe.status === "escape")
          .map((probe) => probe.kind);
      expect(escaped("alice|public.t_check_true|update")).toEqual(["escape-bulk"]);
      expect(escaped("alice|public.t_select_all|update")).toEqual([
        "escape-targeted",
        "escape-bulk",
      ]);
      expect(cellOf("alice|public.t_own|update")?.subProbes).toHaveLength(4);
      expect(cellOf("alice|public.t_check_true|insert")?.status).toBe("escape");
      expect(cellOf("alice|public.t_strict|insert")?.status).toBe("overblock");
      expect(cellOf("alice|public.unique_slugs|insert")?.status).toBe("inconclusive");
      expect(cellOf("alice|public.docs|update")?.status).toBe("leak");
      expect(cellOf("alice|public.by_text|insert")?.status).toBe("skipped");
      expect(cellOf("alice|public.all_generated|update")?.status).toBe("skipped");
      expect(cellOf("alice|public.line_items|insert")?.status).toBe("pass");
    },
    TIMEOUT_MS,
  );

  it(
    "column grants: a collision on the granted column stays inconclusive beside denied constants",
    async () => {
      const { result } = (await exportOf(COLUMN_GRANTS)).matrix;
      const statusOf = (id: string): string | undefined =>
        result.cells.find((cell) => cell.id === id)?.status;
      expect(statusOf("mallory|public.tags|update")).toBe("inconclusive");
      expect(statusOf("mallory|public.posts|update")).toBe("leak");
      expect(statusOf("mallory|public.sealed|update")).toBe("pass");
    },
    TIMEOUT_MS,
  );
});

describe("what decides the exit status", () => {
  it(
    "inconclusive: fail by default, a warning on request",
    async () => {
      // by_text and unique_slugs aside, this table alone has an inconclusive cell and no leak.
      const scenario: Scenario = {
        ...ESCAPES_AND_INSERTS,
        id: "export-inconclusive-only",
        expectations: [],
        schemaSql: `
          create role app_user nologin;
          create table unique_slugs (id int primary key, user_id uuid not null, slug text not null unique);
          alter table unique_slugs enable row level security;
          create policy own on unique_slugs for all using (user_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub'));
          grant select, insert, update, delete on unique_slugs to app_user;
          insert into unique_slugs values (1, '11111111-1111-4111-8111-111111111111', 'hello');`,
        tables: [],
      };
      const strict = await execute(scenario);
      expect(reported(strict.outcome, strict)).toEqual([
        "inconclusive alice|public.unique_slugs|insert",
      ]);
      if (!strict.outcome.passed) {
        expect(strict.outcome.error.message).toContain("[23505]");
        // Nothing leaked: the headline must not say so.
        expect(strict.outcome.error.message.split("\n")[0]).toBe(
          "RLS Leak Tester: NOT PROVEN, no leak or escape was measured. Of 4 checked cells: 0 leaked or escaped, 0 overblocked, 1 inconclusive, 3 passed; 0 warnings.",
        );
      }
      const lenient = await execute(scenario, "warn");
      expect(lenient.outcome).toEqual({ passed: true });
      expect(fileOf(lenient.ciExport, TEST_SQL)).toContain("is a warning.");
      expect(lenient.after).toBe(lenient.before);
    },
    TIMEOUT_MS,
  );

  it(
    "overblock alone fails the run, and is not called a leak",
    async () => {
      const scenario: Scenario = {
        ...ESCAPES_AND_INSERTS,
        id: "export-overblock-only",
        expectations: [],
        schemaSql: `
          create role app_user nologin;
          create table locked (id int primary key, user_id uuid not null, body text);
          alter table locked enable row level security;
          create policy nobody on locked for select using (false);
          grant select on locked to app_user;
          insert into locked values (1, '11111111-1111-4111-8111-111111111111', 'hello');`,
        tables: [],
      };
      const executed = await execute(scenario);
      const { counts } = executed.matrix.result;
      expect(counts).toMatchObject({ leak: 0, escape: 0, inconclusive: 0 });
      expect(counts.overblock).toBeGreaterThan(0);
      expect(executed.outcome.passed).toBe(false);
      if (!executed.outcome.passed) {
        const [headline = ""] = executed.outcome.error.message.split("\n");
        expect(headline).toBe(
          `RLS Leak Tester: OVERBLOCKING, no leak or escape was measured. Of ${executed.ciExport.checkedCells} checked cells: 0 leaked or escaped, ${counts.overblock} overblocked, 0 inconclusive, ${counts.pass} passed; 0 warnings.`,
        );
        expect(headline).not.toContain("LEAKING");
      }
    },
    TIMEOUT_MS,
  );

  it(
    "nothing measured is NOT PROVEN, never a pass",
    async () => {
      const executed = await execute(NOTHING_TO_PROVE);
      expect(executed.ciExport.checkedCells).toBe(0);
      expect(executed.outcome.passed).toBe(false);
      if (!executed.outcome.passed) {
        expect(executed.outcome.error.message).toMatch(/^RLS Leak Tester: NOT PROVEN\./);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "a changed seed and a missing role are setup failures with their own message",
    async () => {
      const { ciExport } = await exportOf(TODOS_SHARING.fixed.scenario);
      const engine = await prepareLikeWorkflow(ciExport);
      try {
        await engine.exec(
          "delete from public.todos where id = (select min(id::text)::uuid from public.todos)",
        );
        await engine.exec("alter role anon rename to anon_renamed");
        const outcome = await runTestFile(engine, fileOf(ciExport, TEST_SQL));
        expect(outcome.passed).toBe(false);
        if (!outcome.passed) {
          expect(outcome.error.message).toContain('[setup] the role "anon" does not exist');
          expect(outcome.error.message).toContain(
            "[setup] the rows of public.todos are not the rows this file was exported for",
          );
          expect(outcome.error.message).toContain("export the check again");
        }
      } finally {
        await engine.close();
      }
    },
    TIMEOUT_MS,
  );

  it(
    "a session that would bypass row level security is refused, not believed",
    async () => {
      // row_security = off in the database's defaults survives RESET ALL; the pinned settings of
      // every probe switch it back on, so the file still fails on the leak it must find.
      const exported = await exportOf(TODOS_SHARING.leaky.scenario);
      const { ciExport } = exported;
      const engine = await prepareLikeWorkflow(ciExport);
      try {
        await engine.exec("set row_security = off");
        const outcome = await runTestFile(engine, fileOf(ciExport, TEST_SQL));
        expect(reported(outcome, exported)).toEqual(declared(TODOS_SHARING.leaky));
      } finally {
        await engine.close();
      }
    },
    TIMEOUT_MS,
  );
});
