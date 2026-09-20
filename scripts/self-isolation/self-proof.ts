/**
 * The self-isolation proof (brief 3.9, 5.3): RLS Leak Tester verifies its own `scenarios` table.
 *
 * The fixed variant of the template "own-scenarios-table" is run through the matrix runner on
 * PGlite and exported as a CI check. The proof consists of three of the exported files; the
 * schema is deliberately NOT one of them, because the CI job loads `supabase/migrations` itself:
 *
 *   1. rls-isolation.setup.sql   the Supabase shim and the explicit-grants defaults
 *   2. supabase/migrations/*.sql in file name order (from the repository, not from here)
 *   3. rls-isolation.seed.sql    users, scenarios and the probe harness
 *   4. rls-isolation.test.sql    psql with ON_ERROR_STOP: exit 0 means ISOLATED
 *
 * Used by `generate.ts` (the CLI of the CI job) and by `tests/self-isolation/`.
 */
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import { CI_EXPORT_FILE_NAMES, generateCiExport, type CiExport } from "@/lib/export";
import { runMatrix, type MatrixRun } from "@/lib/runner";
import type { Scenario } from "@/lib/scenario";
import { OWN_SCENARIOS_TABLE } from "@/lib/scenario/templates";
import { readMigrationsSql } from "./sync-template.mjs";

/** The files the CI job needs besides the migrations, in the order it loads them. */
export const SELF_PROOF_FILE_NAMES = [
  CI_EXPORT_FILE_NAMES.setup,
  CI_EXPORT_FILE_NAMES.seed,
  CI_EXPORT_FILE_NAMES.test,
] as const;

export interface SelfProofFile {
  readonly name: (typeof SELF_PROOF_FILE_NAMES)[number];
  readonly content: string;
}

export interface SelfProof {
  readonly scenario: Scenario;
  readonly matrix: MatrixRun;
  readonly ciExport: CiExport;
  readonly files: readonly SelfProofFile[];
}

export class SelfProofError extends Error {
  override readonly name = "SelfProofError";
}

/** The matrix run and its CI export, the same call the lab's export button makes. */
export async function exportScenario(
  scenario: Scenario,
): Promise<Pick<SelfProof, "scenario" | "matrix" | "ciExport">> {
  const matrix = await runMatrix(scenario, {
    createEngine: () => createPgliteEngine(),
    supabase: SUPABASE_SETUP_SQL,
  });
  const ciExport = generateCiExport({ scenario, run: matrix, supabase: SUPABASE_SETUP_SQL });
  return { scenario, matrix, ciExport };
}

function contentOf(ciExport: CiExport, name: string): string {
  const file = ciExport.files.find((candidate) => candidate.name === name);
  if (file === undefined) {
    throw new SelfProofError(`The export has no file ${name}.`);
  }
  return file.content;
}

/**
 * Builds the proof for the fixed variant. Refuses when the template is not the migrations on disk
 * (the CI job would test another schema than the one it loads), when the run on PGlite is not
 * ISOLATED, or when a cell could not be exported: a proof with holes is not written.
 */
export async function buildSelfProof(migrationsSql = readMigrationsSql()): Promise<SelfProof> {
  const { scenario } = OWN_SCENARIOS_TABLE.fixed;
  if (scenario.schemaSql !== migrationsSql) {
    throw new SelfProofError(
      "The template own-scenarios-table is not the SQL of supabase/migrations. Run: node scripts/self-isolation/sync-template.mjs",
    );
  }
  const exported = await exportScenario(scenario);
  const { result } = exported.matrix;
  if (result.verdict !== "ISOLATED" || result.counts.pass !== result.totalCells) {
    throw new SelfProofError(
      `The app's own schema is not proven on PGlite: verdict ${result.verdict}, ${JSON.stringify(result.counts)}.`,
    );
  }
  if (
    exported.ciExport.skippedCells !== 0 ||
    exported.ciExport.checkedCells !== result.totalCells
  ) {
    throw new SelfProofError(
      `The export checks ${exported.ciExport.checkedCells} of ${result.totalCells} cells.`,
    );
  }
  return {
    ...exported,
    files: SELF_PROOF_FILE_NAMES.map((name) => ({
      name,
      content: contentOf(exported.ciExport, name),
    })),
  };
}
