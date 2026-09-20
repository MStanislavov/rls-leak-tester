/**
 * Writes CI exports to a directory, one folder per scenario id, for
 * `scripts/verify-export-postgres.sh`: every template variant and the fixtures of the export
 * suites. Beside the files, `expected.txt` lists what the matrix runner (on PGlite) says must
 * fail, one `[status] cell id` per line, sorted; empty when the file must run green. Not a test:
 *
 *   npx tsx tests/export/write-template-exports.ts <directory>
 *
 * Two kinds of folder have an expectation of their own, because the point is what the PREFLIGHT
 * says (`[setup] the table x`, `[setup] the rows of x`) or what a good file says about another
 * database: `cross-*` holds the test file of a good scenario beside the schema and seed of its
 * regressed twin, the CI use case.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CI_EXPORT_FILE_NAMES } from "@/lib/export";
import { cellId } from "@/lib/runner";
import { compareText, type Scenario } from "@/lib/scenario";
import { TEMPLATES, templateVariants } from "@/lib/scenario/templates";
import { tenantScenario } from "../runner/fixtures";
import {
  COLUMN_GRANTS,
  ESCAPES_AND_INSERTS,
  REACH_SHAPES,
  SESSION_STATE,
  SUPABASE_BLIND,
  VOLATILE_KEYS,
  tableAddedLater,
  writeOnlyGrant,
} from "./fixtures";
import { exportOf, fileOf, type Exported } from "./helpers";

const TEST_SQL = CI_EXPORT_FILE_NAMES.test;

/** What the matrix runner says must fail: `[status] cell id`, sorted. */
function failingCells({ matrix }: Exported): string[] {
  const probed = new Set(matrix.cellContexts.map((context) => cellId(context.expectation)));
  return matrix.result.cells
    .filter((cell) => probed.has(cell.id) && cell.status !== "pass" && cell.status !== "skipped")
    .map((cell) => `[${cell.status}] ${cell.id}`)
    .sort(compareText);
}

/** The database files of `database`, the test file of `proof`, and what psql must report. */
function writeFolder(
  folder: string,
  database: Exported,
  proof: Exported,
  expected: readonly string[],
): void {
  mkdirSync(folder, { recursive: true });
  for (const file of database.ciExport.files) {
    const source = file.name === TEST_SQL ? proof.ciExport : database.ciExport;
    writeFileSync(path.join(folder, file.name), fileOf(source, file.name));
  }
  writeFileSync(path.join(folder, "expected.txt"), expected.map((line) => `${line}\n`).join(""));
  console.log(
    `${path.basename(folder)}: ${proof.ciExport.checkedCells} cells, ${expected.length} must fail`,
  );
}

/** `expected`: the lines of the preflight when the runner's cells are not what must come out. */
async function write(directory: string, scenario: Scenario, expected?: string[]): Promise<void> {
  const exported = await exportOf(scenario);
  writeFolder(
    path.join(directory, scenario.id),
    exported,
    exported,
    expected ?? failingCells(exported),
  );
}

/** The good file against the regressed database: by default the runner's cells of the latter. */
async function writeCross(
  directory: string,
  name: string,
  scenarios: { readonly good: Scenario; readonly regressed: Scenario },
  expected?: string[],
): Promise<void> {
  const regressed = await exportOf(scenarios.regressed);
  writeFolder(
    path.join(directory, `cross-${name}`),
    regressed,
    await exportOf(scenarios.good),
    expected ?? failingCells(regressed),
  );
}

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (directory === undefined || directory === "") {
    throw new Error("Usage: npx tsx tests/export/write-template-exports.ts <directory>");
  }
  const scenarios = [
    ...templateVariants().map(({ variant }) => variant.scenario),
    REACH_SHAPES,
    ESCAPES_AND_INSERTS,
    SUPABASE_BLIND,
    tenantScenario("leaky"),
    tenantScenario("fixed"),
    SESSION_STATE,
    COLUMN_GRANTS,
  ];
  for (const scenario of scenarios) {
    await write(directory, scenario);
  }
  for (const { id, fixed, leaky } of TEMPLATES) {
    // The check exported from the fixed variant must find the leaky variant's cells.
    if (fixed.scenario.seedSql === leaky.scenario.seedSql) {
      await writeCross(directory, id, { good: fixed.scenario, regressed: leaky.scenario });
    }
  }
  await write(directory, VOLATILE_KEYS, ["[setup] the rows of public.todos"]);
  await writeCross(directory, "write-only", {
    good: writeOnlyGrant(false),
    regressed: writeOnlyGrant(true),
  });
  await writeCross(
    directory,
    "new-table",
    { good: tableAddedLater(false), regressed: tableAddedLater(true) },
    ["[setup] the table public.invoices"],
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
