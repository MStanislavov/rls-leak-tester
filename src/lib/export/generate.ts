/**
 * The CI export (brief 3.8): the files that keep a scenario's verdict true in a repository.
 *
 * INPUT. The scenario and a completed `runMatrix` of it. The run carries what no pure function can
 * know: the catalog, the ground truth, which rows are the persona's own by Postgres' comparison,
 * the column privileges and the rows an `expectedRowsSql` returned, all inside
 * `MatrixRun.cellContexts`, the very objects the runner planned its probes from. The browser has
 * both after every run, so exporting needs no second database. The Supabase SQL comes in as a
 * parameter, as it does for the runner (SEC-004: only `src/lib/engine` and client modules may
 * import it).
 *
 * OUTPUT, in the order the workflow uses them:
 *
 *   rls-isolation.setup.sql   supabase mode only: the shim and the default grants of the chosen
 *                             regime, exactly the scripts `setupDatabase` runs before the schema
 *   rls-isolation.schema.sql  the scenario's schema SQL, as it is
 *   rls-isolation.seed.sql    the scenario's seed SQL, as it is
 *   rls-isolation.test.sql    the proof
 *   rls-isolation.yml         the GitHub Actions workflow
 *
 * The shim cannot be part of the test file, as the brief sketches it: the schema needs the roles
 * and `auth.uid()` to load at all, and the grants must precede the schema (ADR 0002), so they
 * are a file of their own that runs first. Schema and seed are emitted so that the five files work
 * when dropped into a repository; the workflow marks their paths as the placeholders to repoint.
 *
 * Deterministic: no clock, no randomness, the cell order of the result.
 */
import {
  cellId,
  exposedSchemasOf,
  selectReachProbe,
  sortKeys,
  supabaseGrantsOf,
  supabasePrelude,
  type CellPlanContext,
  type CellResult,
  type MatrixRun,
  type SupabaseSetupSql,
} from "@/lib/runner";
import type { Scenario } from "@/lib/scenario";
import { maxParamsOf, planCell, tableNameOf, type CellPlan } from "./cell-plan";
import { commentLine } from "./sql-text";
import { renderTestSql, type SeedCheck } from "./test-sql";
import { volatileKeyAdvice, volatileKeyOf, volatileKeyWarning } from "./volatile-keys";
import { SQL_DIRECTORY, WORKFLOW_PATH, renderWorkflow } from "./workflow";

export const DEFAULT_TOOL_NAME = "RLS Leak Tester";

export const CI_EXPORT_FILE_NAMES = {
  setup: "rls-isolation.setup.sql",
  schema: "rls-isolation.schema.sql",
  seed: "rls-isolation.seed.sql",
  test: "rls-isolation.test.sql",
  workflow: "rls-isolation.yml",
} as const;

export type CiExportFileName = (typeof CI_EXPORT_FILE_NAMES)[keyof typeof CI_EXPORT_FILE_NAMES];

export interface CiExportFile {
  /** The file name to download as. */
  readonly name: CiExportFileName;
  /** Where the workflow expects the file, relative to the repository root. */
  readonly path: string;
  readonly mediaType: "application/sql" | "application/yaml";
  readonly content: string;
}

export interface CiExportInput {
  /** The scenario the run was made from, unchanged since. */
  readonly scenario: Scenario;
  /** `await runMatrix(scenario, ...)`; only these two fields are read. */
  readonly run: Pick<MatrixRun, "result" | "cellContexts">;
  /** `SUPABASE_SETUP_SQL` from `@/lib/engine/supabase-setup-sql`. Not used in postgres mode. */
  readonly supabase: SupabaseSetupSql;
  /** The product name in headers and messages; defaults to `DEFAULT_TOOL_NAME`. */
  readonly toolName?: string | undefined;
  /**
   * What a cell does whose probe failed for a reason that is not authorization. `fail` (the
   * default): CI proves every cell or fails. `warn`: it is listed and does not fail the run, as
   * in the lab, where an inconclusive cell stands beside the verdict.
   */
  readonly inconclusive?: "fail" | "warn" | undefined;
}

export interface CiExport {
  /** In the order the workflow uses them; the setup file only in supabase mode. */
  readonly files: readonly CiExportFile[];
  /** Cells with a `DO` block in the test file. */
  readonly checkedCells: number;
  /** Cells that are a comment in the test file, with the reason. */
  readonly skippedCells: number;
  /**
   * Reasons why the files, as they are, would not do their job in CI, one sentence each, for the
   * person who is about to export. Today: a seeded table whose keys most likely come from a
   * volatile default (`gen_random_uuid()`, `now()`), so no second load reproduces them and the
   * check would stop at its preflight on every run. Empty when nothing is known.
   */
  readonly warnings: readonly string[];
}

/** The run does not belong to the scenario: exporting it would pair keys with the wrong SQL. */
export class CiExportError extends Error {
  override readonly name = "CiExportError";
}

const sqlPath = (name: CiExportFileName): string => `${SQL_DIRECTORY}/${name}`;

function regimeLine(scenario: Scenario): string {
  const regime = supabaseGrantsOf(scenario);
  if (regime === null) {
    return "Mode: postgres. No shim and no automatic grant: the schema creates its roles and grants.";
  }
  const meaning =
    regime === "legacy"
      ? "every table, sequence and function of an exposed schema is granted to anon, authenticated and service_role, so row level security is the only barrier"
      : "new tables get no select, insert, update or delete for the API roles until the schema grants them";
  return `Mode: supabase. Grants regime: ${regime} (${meaning}). Load rls-isolation.setup.sql before the schema.`;
}

function personaLabelOf(scenario: Scenario, personaId: string): string {
  return scenario.personas.find((persona) => persona.id === personaId)?.label ?? personaId;
}

/** A cell the run never probed: skipped, or inconclusive before any probe (`expectedRowsSql`). */
function unprobedPlan(scenario: Scenario, run: CiExportInput["run"], cell: CellResult): CellPlan {
  const role = run.result.personas.find((persona) => persona.id === cell.personaId)?.dbRole;
  const label = `${personaLabelOf(scenario, cell.personaId)} as role ${role ?? "?"}: ${cell.operation.toUpperCase()} on ${cell.schema}.${cell.table}, scope ${cell.scope}`;
  return {
    kind: "skipped",
    id: cell.id,
    operation: cell.operation,
    label,
    reason: `${cell.status} in the run this file was exported from: ${cell.reason ?? "no reason recorded"}`,
  };
}

/** One check per probed table, and the warnings about keys that no second load reproduces. */
function seedChecksOf(
  scenario: Scenario,
  contexts: readonly CellPlanContext[],
): { checks: SeedCheck[]; warnings: string[] } {
  const checks = new Map<string, SeedCheck>();
  const warnings: string[] = [];
  const sql = `${scenario.schemaSql}\n${scenario.seedSql}`;
  for (const context of contexts) {
    const { truth } = context;
    const table = tableNameOf(truth);
    if (!checks.has(table)) {
      const volatile = volatileKeyOf(context, sql);
      if (volatile !== null) {
        warnings.push(volatileKeyWarning(volatile));
      }
      checks.set(table, {
        table,
        keyColumns: truth.primaryKey.length,
        readKeys: selectReachProbe(truth).inlined,
        truthKeys: sortKeys(truth.rows.map((row) => row.key)),
        volatile: volatile === null ? null : volatileKeyAdvice(volatile),
      });
    }
  }
  return { checks: [...checks.values()], warnings };
}

function sqlFile(name: CiExportFileName, header: readonly string[], body: string): CiExportFile {
  const comment = header.map((line) => `-- ${commentLine(line)}`).join("\n");
  const text = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  return {
    name,
    path: sqlPath(name),
    mediaType: "application/sql",
    content: `${comment}\n\n${text}`,
  };
}

/**
 * Generates the CI check for `scenario` from a completed run of it.
 *
 * @throws CiExportError when the run is not a run of this scenario.
 */
export function generateCiExport(input: CiExportInput): CiExport {
  const { scenario, run } = input;
  const toolName = input.toolName ?? DEFAULT_TOOL_NAME;
  if (run.result.scenarioId !== scenario.id || run.result.mode !== scenario.mode) {
    throw new CiExportError(
      `The run belongs to the scenario "${run.result.scenarioId}" (${run.result.mode}), not to "${scenario.id}" (${scenario.mode}). Run the matrix again before exporting.`,
    );
  }

  const contexts = new Map(
    run.cellContexts.map((context) => [cellId(context.expectation), context]),
  );
  const plans = run.result.cells.map((cell) => {
    const context = contexts.get(cell.id);
    return context === undefined
      ? unprobedPlan(scenario, run, cell)
      : planCell(context, personaLabelOf(scenario, cell.personaId));
  });
  const probed = plans.filter((plan) => plan.kind !== "skipped");
  const title = `${scenario.title} [${scenario.id}]`;
  const prelude = supabasePrelude(scenario, input.supabase);
  const seed = seedChecksOf(scenario, run.cellContexts);

  const files: CiExportFile[] = [];
  if (prelude.length > 0) {
    files.push(
      sqlFile(
        CI_EXPORT_FILE_NAMES.setup,
        [
          `${toolName}: what a Supabase project has before the first migration (rls-isolation.setup.sql)`,
          `Scenario: ${title}`,
          regimeLine(scenario),
          "Run it once, as a superuser, on the empty database, BEFORE the schema: the roles and auth.uid()",
          "must exist for the schema to load, and the grants are default privileges for the tables it creates.",
        ],
        prelude.map(({ script }) => script.trim()).join("\n\n"),
      ),
    );
  }
  files.push(
    sqlFile(
      CI_EXPORT_FILE_NAMES.schema,
      [
        `${toolName}: the schema of the scenario ${title} (rls-isolation.schema.sql)`,
        "In your repository, point RLS_SCHEMA_SQL of the workflow at your own schema or migrations instead.",
      ],
      scenario.schemaSql,
    ),
    sqlFile(
      CI_EXPORT_FILE_NAMES.seed,
      [
        `${toolName}: the seed of the scenario ${title} (rls-isolation.seed.sql)`,
        "The test file expects exactly these rows. After changing them, export the check again.",
        "Give every row an explicit primary key: a key from gen_random_uuid() or now() differs on every load.",
      ],
      scenario.seedSql,
    ),
    {
      name: CI_EXPORT_FILE_NAMES.test,
      path: sqlPath(CI_EXPORT_FILE_NAMES.test),
      mediaType: "application/sql",
      content: renderTestSql({
        toolName,
        scenarioTitle: scenario.title,
        scenarioId: scenario.id,
        regime: regimeLine(scenario),
        plans,
        roles: [...new Set(run.cellContexts.map((context) => context.identity.role))],
        exposedSchemas: exposedSchemasOf(scenario),
        tables: run.result.tables.map((table) => [table.schema, table.name] as const),
        seedChecks: seed.checks,
        maxParams: Math.max(1, ...plans.map((plan) => maxParamsOf(plan))),
        inconclusive: input.inconclusive ?? "fail",
      }),
    },
    {
      name: CI_EXPORT_FILE_NAMES.workflow,
      path: WORKFLOW_PATH,
      mediaType: "application/yaml",
      content: renderWorkflow({
        toolName,
        scenarioTitle: title,
        setupPath: prelude.length > 0 ? sqlPath(CI_EXPORT_FILE_NAMES.setup) : null,
        schemaPath: sqlPath(CI_EXPORT_FILE_NAMES.schema),
        seedPath: sqlPath(CI_EXPORT_FILE_NAMES.seed),
        testPath: sqlPath(CI_EXPORT_FILE_NAMES.test),
      }),
    },
  );
  return {
    files,
    checkedCells: probed.length,
    skippedCells: plans.length - probed.length,
    warnings: seed.warnings,
  };
}
