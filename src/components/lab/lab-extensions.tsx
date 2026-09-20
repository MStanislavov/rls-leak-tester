/**
 * EXTENSION POINTS of the lab workbench. Features that are built beside the lab (Explain, Share,
 * Export CI check) mount here and nowhere else:
 *
 *   LAB_TOOLBAR_EXTENSIONS      rendered in the toolbar, left of the Run button
 *                               (`data-testid="lab-toolbar-extensions"`)
 *   LAB_CELL_DRAWER_EXTENSIONS  rendered in the footer of the cell details drawer
 *                               (`data-testid="cell-drawer-footer"`), with the open cell
 *
 * Add a component to the list; it receives the props below on every render. A component that
 * has nothing to show (its feature is not configured, the cell is not failing) returns `null`.
 * `LabWorkbench` also takes both lists as props, for tests and for pages that want other ones.
 */
import type { ComponentType } from "react";
import type { Finding } from "@/lib/checks";
import type {
  LabRunOptions,
  LabRunOutcome,
  LabValidation,
  RunState,
  ScenarioOrigin,
} from "@/lib/lab";
import type { CellResult, MatrixResult, MatrixRun } from "@/lib/runner";
import type { Catalog } from "@/lib/runner/introspect";
import type { Scenario } from "@/lib/scenario";
import { ExplainCell } from "./explain/explain-cell";
import { ExportCiCheck } from "./export/export-ci-check";
import { ShareScenario } from "./share/share-scenario";

export interface LabSlotProps {
  /** The working scenario as the lab's state has it. */
  readonly scenario: Scenario;
  /**
   * The working scenario including what is in the SQL editors this instant (their changes reach
   * the state debounced). Call it in an event handler, right before using the scenario.
   */
  readonly getScenario: () => Scenario;
  /** `parseScenario` over `scenario`: `validation.scenario` is what may be run, saved, exported. */
  readonly validation: LabValidation;
  readonly origin: ScenarioOrigin;
  readonly dirty: boolean;
  readonly run: RunState;
  /** `true` while a run or an introspection is in flight. */
  readonly busy: boolean;
  readonly result: MatrixResult | null;
  /** The whole last run: catalog, table configs and cell contexts, as the CI export needs them. */
  readonly matrixRun: MatrixRun | null;
  /** `true` when the scenario was edited after `result` was produced. */
  readonly resultIsStale: boolean;
  readonly catalog: Catalog | null;
  readonly findings: readonly Finding[];
  /**
   * Runs `scenario` on a worker of its own without touching the lab's state or its result: the
   * re-run of a verified-fix loop. Resolves with an outcome, never rejects.
   */
  readonly runIsolated: (scenario: Scenario, options?: LabRunOptions) => Promise<LabRunOutcome>;
  /**
   * Replaces the working scenario (a fork, an applied fix). Asks first when there are unsaved
   * changes. The scenario must have passed `parseScenario`.
   */
  readonly loadScenario: (scenario: Scenario, origin?: ScenarioOrigin) => void;
  /**
   * Replaces the text of the schema editor, as an EDIT of the working scenario: the scenario
   * becomes dirty and the result stale, nothing is reloaded and nothing is asked. What "Apply to
   * my scenario" of a verified fix calls, on the user's click.
   */
  readonly applySchemaSql: (schemaSql: string) => void;
  /**
   * What the Run button does: validates the working scenario (a toast says why it cannot run)
   * and starts the lab's own run, whose result lands in `result` and `matrixRun`.
   */
  readonly startRun: () => void;
}

export interface LabCellSlotProps extends LabSlotProps {
  /** The cell whose details are open. */
  readonly cell: CellResult;
}

export type LabToolbarExtension = ComponentType<LabSlotProps>;
export type LabCellDrawerExtension = ComponentType<LabCellSlotProps>;

export const LAB_TOOLBAR_EXTENSIONS: readonly LabToolbarExtension[] = [
  ShareScenario,
  ExportCiCheck,
];

export const LAB_CELL_DRAWER_EXTENSIONS: readonly LabCellDrawerExtension[] = [ExplainCell];
