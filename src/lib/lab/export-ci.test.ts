/**
 * The lab's side of "Export CI check": readiness, and the view over a real run of a template.
 * What the files contain and that they execute is proven in tests/export.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import { CI_EXPORT_FILE_NAMES, SQL_DIRECTORY, WORKFLOW_PATH } from "@/lib/export";
import { runMatrix, type MatrixRun } from "@/lib/runner";
import type { Scenario } from "@/lib/scenario";
import { MULTI_TENANT_SAAS } from "@/lib/scenario/templates";
import { CI_EXPORT_COVERAGE_NOTE, buildCiExportView, ciExportReadiness } from "./export-ci";
import { scenarioFromTemplate } from "./scenario-edit";

const run = (scenario: Scenario): Promise<MatrixRun> =>
  runMatrix(scenario, { createEngine: () => createPgliteEngine(), supabase: SUPABASE_SETUP_SQL });

const leaky = scenarioFromTemplate(MULTI_TENANT_SAAS, "leaky");
const fixed = scenarioFromTemplate(MULTI_TENANT_SAAS, "fixed");
let leakyRun: MatrixRun;
let fixedRun: MatrixRun;

/**
 * Two real PGlite matrix runs. Alone that takes about a second; with the full suite booting WASM in
 * every worker it can pass Vitest's default hook timeout, which made this file fail now and then.
 * The same watchdog as the other real-PGlite suites; not a product threshold.
 */
const REAL_ENGINE_HOOK_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  [leakyRun, fixedRun] = await Promise.all([run(leaky), run(fixed)]);
}, REAL_ENGINE_HOOK_TIMEOUT_MS);

describe("ciExportReadiness", () => {
  it("needs a completed run", () => {
    expect(
      ciExportReadiness({ busy: false, matrixRun: null, resultIsStale: false, scenario: leaky }),
    ).toBe("no-run");
  });

  it("waits for a run in flight, whatever is left of the last one", () => {
    expect(
      ciExportReadiness({ busy: true, matrixRun: leakyRun, resultIsStale: false, scenario: leaky }),
    ).toBe("running");
    expect(
      ciExportReadiness({ busy: true, matrixRun: null, resultIsStale: false, scenario: leaky }),
    ).toBe("running");
  });

  it("is stale when the scenario was edited after the run or no longer validates", () => {
    expect(
      ciExportReadiness({ busy: false, matrixRun: leakyRun, resultIsStale: true, scenario: leaky }),
    ).toBe("stale");
    expect(
      ciExportReadiness({ busy: false, matrixRun: leakyRun, resultIsStale: false, scenario: null }),
    ).toBe("stale");
  });

  it("is ready when the last run is a run of the current text", () => {
    expect(
      ciExportReadiness({
        busy: false,
        matrixRun: leakyRun,
        resultIsStale: false,
        scenario: leaky,
      }),
    ).toBe("ready");
  });
});

describe("buildCiExportView", () => {
  it("previews the test file and the workflow, in that order, under their exact names", () => {
    const built = buildCiExportView({
      scenario: leaky,
      run: leakyRun,
      supabase: SUPABASE_SETUP_SQL,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.view.proof.map((file) => file.name)).toEqual([
      "rls-isolation.test.sql",
      "rls-isolation.yml",
    ]);
    expect(built.view.proof.map((file) => file.path)).toEqual([
      `${SQL_DIRECTORY}/rls-isolation.test.sql`,
      WORKFLOW_PATH,
    ]);
    expect(built.view.sqlDirectory).toBe(SQL_DIRECTORY);
    expect(built.view.workflowPath).toBe(WORKFLOW_PATH);
  });

  it("keeps what the workflow loads first apart, in the workflow's order", () => {
    const built = buildCiExportView({
      scenario: leaky,
      run: leakyRun,
      supabase: SUPABASE_SETUP_SQL,
    });
    expect(built.ok && built.view.companions.map((file) => file.name)).toEqual(
      leaky.mode === "supabase"
        ? [CI_EXPORT_FILE_NAMES.setup, CI_EXPORT_FILE_NAMES.schema, CI_EXPORT_FILE_NAMES.seed]
        : [CI_EXPORT_FILE_NAMES.schema, CI_EXPORT_FILE_NAMES.seed],
    );
  });

  it("says that CI fails on the cells that do not pass in the run", () => {
    const built = buildCiExportView({
      scenario: leaky,
      run: leakyRun,
      supabase: SUPABASE_SETUP_SQL,
    });
    const notPassing = leakyRun.result.cells.filter(
      (cell) => cell.status !== "pass" && cell.status !== "skipped",
    ).length;
    expect(notPassing).toBeGreaterThan(0);
    expect(built.ok && built.view.failingCells).toBe(notPassing);
    expect(built.ok && built.view.outcome).toContain(
      `fails on ${notPassing === 1 ? "1 cell" : `${notPassing} cells`}`,
    );
    expect(built.ok && built.view.checkedCells + built.view.skippedCells).toBe(
      leakyRun.result.totalCells,
    );
  });

  it("says what CI guards when every cell passes", () => {
    const built = buildCiExportView({
      scenario: fixed,
      run: fixedRun,
      supabase: SUPABASE_SETUP_SQL,
    });
    expect(fixedRun.result.verdict).toBe("ISOLATED");
    expect(built.ok && built.view.failingCells).toBe(0);
    expect(built.ok && built.view.outcome).toContain("fails as soon as one of them stops matching");
  });

  it("says what the file does not cover, and has no warning for a seed with explicit keys", () => {
    const built = buildCiExportView({
      scenario: fixed,
      run: fixedRun,
      supabase: SUPABASE_SETUP_SQL,
    });
    expect(built.ok && built.view.outcome).toContain(CI_EXPORT_COVERAGE_NOTE);
    expect(CI_EXPORT_COVERAGE_NOTE).toContain("A table added to an exposed schema later");
    expect(built.ok && built.view.warnings).toEqual([]);
  });

  it("warns before the download when the seed leaves its keys to a volatile default", async () => {
    const volatile: Scenario = {
      ...fixed,
      id: "volatile-keys",
      schemaSql: `create role app_user nologin;
        create table todos (id uuid primary key default gen_random_uuid(), user_id uuid not null);
        alter table todos enable row level security;
        create policy own on todos for all to app_user using (user_id::text = current_setting('request.jwt.claims', true)::jsonb ->> 'sub');
        grant select, insert, update, delete on todos to app_user;`,
      seedSql: "insert into todos (user_id) values ('11111111-1111-4111-8111-111111111111');",
      mode: "postgres",
      personas: [
        {
          id: "alice",
          label: "Alice",
          dbRole: "app_user",
          claims: { sub: "11111111-1111-4111-8111-111111111111" },
        },
      ],
      tables: [],
      expectations: [],
    };
    const built = buildCiExportView({
      scenario: volatile,
      run: await run(volatile),
      supabase: SUPABASE_SETUP_SQL,
    });
    expect(built.ok && built.view.warnings).toEqual([
      expect.stringContaining("public.todos: the keys of the seeded rows are not in the seed"),
    ]);
    expect(built.ok && built.view.outcome).toMatch(
      /^As it is, the workflow stops at its preflight on every run and proves nothing/,
    );
  });

  it("does not count an inconclusive cell as failing when the export only warns about it", () => {
    const first = leakyRun.result.cells.find((cell) => cell.status === "pass");
    expect(first).toBeDefined();
    const inconclusive: MatrixRun = {
      ...leakyRun,
      result: {
        ...leakyRun.result,
        cells: leakyRun.result.cells.map((cell) =>
          cell === first ? { ...cell, status: "inconclusive" as const } : cell,
        ),
      },
    };
    const input = { scenario: leaky, run: inconclusive, supabase: SUPABASE_SETUP_SQL };
    const failing = buildCiExportView(input);
    const warning = buildCiExportView({ ...input, inconclusive: "warn" });
    expect(failing.ok && warning.ok && failing.view.failingCells - warning.view.failingCells).toBe(
      1,
    );
  });

  it("mentions the cells that are only a comment in the test file", () => {
    const probed = leakyRun.cellContexts.slice(1);
    const built = buildCiExportView({
      scenario: leaky,
      run: { result: leakyRun.result, cellContexts: probed },
      supabase: SUPABASE_SETUP_SQL,
    });
    expect(built.ok && built.view.skippedCells).toBeGreaterThanOrEqual(1);
    expect(built.ok && built.view.outcome).toMatch(/could not be probed and (is|are) listed/);
  });

  it("answers with a message when the run is a run of another scenario", () => {
    const built = buildCiExportView({
      scenario: { ...leaky, id: "another-scenario" },
      run: leakyRun,
      supabase: SUPABASE_SETUP_SQL,
    });
    expect(built).toEqual({ ok: false, message: expect.stringContaining("another-scenario") });
  });
});
