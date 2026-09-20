/**
 * "Export CI check" in the lab: when the export is possible, and what the dialog shows. The
 * files themselves come from `generateCiExport` (`@/lib/export`), which shares the probe
 * builders with the runner; nothing here renders SQL or YAML.
 *
 * The brief names two files, the proof and the workflow. The generator also emits what the
 * workflow loads before the proof (the Supabase setup in supabase mode, the schema, the seed), so
 * the view keeps the two apart: `proof` is what the dialog previews, `companions` is what makes
 * the workflow run as it is.
 */
import {
  CI_EXPORT_FILE_NAMES,
  CiExportError,
  SQL_DIRECTORY,
  WORKFLOW_PATH,
  generateCiExport,
  type CiExportFile,
  type CiExportInput,
} from "@/lib/export";
import { cellId, type MatrixRun } from "@/lib/runner";
import type { Scenario } from "@/lib/scenario";

/**
 *   no-run   nothing to export from: no run has completed for this scenario
 *   running  a run or an introspection is in flight
 *   stale    the scenario was edited after the run (or no longer validates): run again first
 *   ready    the last run is a run of the current scenario text
 */
export type CiExportReadiness = "no-run" | "running" | "stale" | "ready";

export interface CiExportReadinessInput {
  readonly busy: boolean;
  readonly matrixRun: Pick<MatrixRun, "result"> | null;
  readonly resultIsStale: boolean;
  /** `validation.scenario` of the lab: `null` while the working scenario does not validate. */
  readonly scenario: Scenario | null;
}

export function ciExportReadiness(input: CiExportReadinessInput): CiExportReadiness {
  if (input.busy) {
    return "running";
  }
  if (input.matrixRun === null) {
    return "no-run";
  }
  return input.resultIsStale || input.scenario === null ? "stale" : "ready";
}

export interface CiExportView {
  /** `rls-isolation.test.sql`, then `rls-isolation.yml`. */
  readonly proof: readonly [CiExportFile, CiExportFile];
  /** What the workflow loads before the proof, in its order. */
  readonly companions: readonly CiExportFile[];
  readonly checkedCells: number;
  readonly skippedCells: number;
  /** Probed cells that did not pass in the run: the ones the workflow fails on. */
  readonly failingCells: number;
  /** What the workflow will do with this scenario as it is, and what it does not cover. */
  readonly outcome: string;
  /**
   * Why the files, as they are, would not do their job in CI (`CiExport.warnings`): today, keys
   * that most likely come from a volatile default and so differ on every load. Shown BEFORE the
   * download; the workflow would stop at its preflight on every run.
   */
  readonly warnings: readonly string[];
  readonly sqlDirectory: string;
  readonly workflowPath: string;
}

export type CiExportViewResult =
  | { readonly ok: true; readonly view: CiExportView }
  | { readonly ok: false; readonly message: string };

const cells = (count: number): string => (count === 1 ? "1 cell" : `${count} cells`);

/** The limit of a file with literal keys and a fixed list of cells, said where it is exported. */
export const CI_EXPORT_COVERAGE_NOTE =
  "It covers the tables, personas and seed rows of this run. A table added to an exposed schema later, or a changed seed, makes it fail at its preflight until you run the matrix and export again.";

function outcomeOf(failing: number, checked: number, skipped: number, warnings: number): string {
  const skippedNote =
    skipped === 0
      ? ""
      : ` ${cells(skipped)} could not be probed and ${skipped === 1 ? "is" : "are"} listed as a comment.`;
  if (warnings > 0) {
    return `As it is, the workflow stops at its preflight on every run and proves nothing: see the warning above.${skippedNote} ${CI_EXPORT_COVERAGE_NOTE}`;
  }
  if (failing > 0) {
    return `The workflow checks ${cells(checked)} and fails on ${cells(failing)}, the same that ${failing === 1 ? "does" : "do"} not pass here, until the policies are fixed.${skippedNote} ${CI_EXPORT_COVERAGE_NOTE}`;
  }
  return `The workflow checks ${cells(checked)} and fails as soon as one of them stops matching its expectation.${skippedNote} ${CI_EXPORT_COVERAGE_NOTE}`;
}

/** With the default `inconclusive: "fail"` every probed cell that is not a pass fails the file. */
function failingCellsOf(run: CiExportInput["run"], inconclusive: "fail" | "warn"): number {
  const probed = new Set(run.cellContexts.map((context) => cellId(context.expectation)));
  return run.result.cells.filter(
    (cell) =>
      probed.has(cell.id) &&
      cell.status !== "pass" &&
      cell.status !== "skipped" &&
      (inconclusive === "fail" || cell.status !== "inconclusive"),
  ).length;
}

/** A run that is not a run of `scenario` comes back as a message, not as an exception. */
export function buildCiExportView(input: CiExportInput): CiExportViewResult {
  let generated;
  try {
    generated = generateCiExport(input);
  } catch (error) {
    if (error instanceof CiExportError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
  const test = generated.files.find((file) => file.name === CI_EXPORT_FILE_NAMES.test);
  const workflow = generated.files.find((file) => file.name === CI_EXPORT_FILE_NAMES.workflow);
  if (test === undefined || workflow === undefined) {
    return { ok: false, message: "The export did not produce the test file and the workflow." };
  }
  const failingCells = failingCellsOf(input.run, input.inconclusive ?? "fail");
  return {
    ok: true,
    view: {
      proof: [test, workflow],
      companions: generated.files.filter((file) => file !== test && file !== workflow),
      checkedCells: generated.checkedCells,
      skippedCells: generated.skippedCells,
      failingCells,
      outcome: outcomeOf(
        failingCells,
        generated.checkedCells,
        generated.skippedCells,
        generated.warnings.length,
      ),
      warnings: generated.warnings,
      sqlDirectory: SQL_DIRECTORY,
      workflowPath: WORKFLOW_PATH,
    },
  };
}
