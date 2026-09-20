/**
 * Helpers of the export suites: a PGlite prepared the way the exported workflow prepares
 * Postgres (setup file, schema and seed through ONE `psql` with three `--file` options: one
 * session, statement by statement), and the test file run through `exec` in a session of its
 * own, the way `psql -f` sends it.
 */
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import {
  CI_EXPORT_FILE_NAMES,
  generateCiExport,
  type CiExport,
  type CiExportFileName,
  type CiExportInput,
} from "@/lib/export";
import type { MatrixRun } from "@/lib/runner";
import { SqlError, type SqlEngine } from "@/lib/runner/types";
import { splitSqlStatements, type Scenario } from "@/lib/scenario";
import { dumpDatabase, run } from "../runner/helpers";

export interface Exported {
  readonly scenario: Scenario;
  readonly matrix: MatrixRun;
  readonly ciExport: CiExport;
}

export async function exportOf(
  scenario: Scenario,
  options: Partial<Pick<CiExportInput, "inconclusive" | "toolName">> = {},
): Promise<Exported> {
  const matrix = await run(scenario);
  const ciExport = generateCiExport({
    scenario,
    run: matrix,
    supabase: SUPABASE_SETUP_SQL,
    ...options,
  });
  return { scenario, matrix, ciExport };
}

export function fileOf(ciExport: CiExport, name: CiExportFileName): string {
  const file = ciExport.files.find((candidate) => candidate.name === name);
  if (file === undefined) {
    throw new Error(`The export has no file ${name}`);
  }
  return file.content;
}

/** `psql --file a --file b`: one session; statement by statement, each committed on its own. */
async function psqlFiles(engine: SqlEngine, contents: readonly string[]): Promise<void> {
  // A new connection has no session state and, with PGTZ=UTC, the zone of the workflow.
  await engine.exec("discard all");
  await engine.exec("set time zone 'UTC'");
  for (const content of contents) {
    for (const statement of splitSqlStatements(content)) {
      await engine.exec(statement.text);
    }
  }
}

/**
 * A fresh database after the workflow's loading step, in a new session as the step "Prove
 * isolation" finds it. The caller closes it.
 */
export async function prepareLikeWorkflow(ciExport: CiExport): Promise<SqlEngine> {
  const engine = await createPgliteEngine();
  const order = [
    CI_EXPORT_FILE_NAMES.setup,
    CI_EXPORT_FILE_NAMES.schema,
    CI_EXPORT_FILE_NAMES.seed,
  ];
  const contents = order.flatMap((name) => {
    const file = ciExport.files.find((candidate) => candidate.name === name);
    return file === undefined ? [] : [file.content];
  });
  await psqlFiles(engine, contents);
  await engine.exec("discard all");
  return engine;
}

export type TestFileOutcome =
  { readonly passed: true } | { readonly passed: false; readonly error: SqlError };

/** The step "Prove isolation": the whole file in one `exec`. */
export async function runTestFile(engine: SqlEngine, content: string): Promise<TestFileOutcome> {
  try {
    await engine.exec(content);
    return { passed: true };
  } catch (error) {
    if (error instanceof SqlError) {
      return { passed: false, error };
    }
    throw error;
  }
}

/** The lines of the final exception: `[status] cell id (label): ...`. */
export function failedCells(error: SqlError): { status: string; id: string; line: string }[] {
  return error.message
    .split("\n")
    .slice(1)
    .map((line) => {
      const match = /^\[(\w+)\] (\S+) \(/.exec(line);
      return { status: match?.[1] ?? "", id: match?.[2] ?? "", line };
    });
}

/**
 * `dumpDatabase` plus everything the test file could leave behind: functions, temp objects, settings.
 *
 * The rows are dumped in UTC, and the session's zone is put back afterwards: a timestamptz renders
 * in the session's zone, and the test file pins UTC for its session (psql's ends with the file,
 * PGlite's does not), so the same instant would read differently before and after.
 */
export async function dumpEverything(engine: SqlEngine): Promise<string> {
  const leftovers = await engine.query(
    `select (select count(*) from pg_proc)::text as functions,
            (select count(*) from pg_class)::text as relations,
            current_user::text as role,
            current_setting('row_security') as row_security`,
  );
  const zone = await engine.query("select current_setting('TimeZone') as zone");
  await engine.exec("set time zone 'UTC'");
  try {
    return `${await dumpDatabase(engine)}\n${JSON.stringify(leftovers.rows)}`;
  } finally {
    await engine.query("select set_config('TimeZone', $1, false)", [String(zone.rows[0]?.zone)]);
  }
}
