/** The lab's pure state and view logic: `@/lib/lab`. Components live in `src/components/lab`. */
export { PROBE_TIMEOUT_MS, RUN_CEILING_MS } from "./thresholds";

export {
  BLANK_TEMPLATE_ID,
  DEFAULT_VARIANT,
  defaultLabEntry,
  labEntryQuery,
  parseLabSearchParams,
} from "./search-params";
export type { LabEntry } from "./search-params";

export {
  addPersona,
  blankScenario,
  canAddPersona,
  findExpectation,
  removePersona,
  resetTableConfig,
  scenarioFromTemplate,
  setExpectation,
  setTableColumn,
  sqlOf,
  starterExpectedRowsSql,
  updatePersona,
  withGrants,
  withMode,
  withSql,
  withTitle,
} from "./scenario-edit";
export type {
  CellRef,
  PersonaPatch,
  ScopeChoice,
  SqlKind,
  TableColumnField,
} from "./scenario-edit";

export { formatClaims, parseClaimsText } from "./claims-text";
export type { ClaimsTextResult } from "./claims-text";

export {
  LAB_TABS,
  claimsTextOf,
  hasClaimsErrors,
  initialLabState,
  isBusy,
  isCatalogStale,
  isDirty,
  isResultStale,
  labReducer,
} from "./state";
export type {
  ClaimsDraft,
  LabAction,
  LabState,
  LabTab,
  RunPurpose,
  RunState,
  ScenarioOrigin,
} from "./state";

export { introspectLab, runLab } from "./run-lab";
export type {
  LabEngineHandle,
  LabFailureReason,
  LabIntrospectOutcome,
  LabRunOptions,
  LabRunOutcome,
  LabRunPorts,
  LabTimers,
} from "./run-lab";

export { locateTimedOutStatement, toSetupErrorView } from "./setup-error-view";
export type { SetupErrorView } from "./setup-error-view";

export { buildMatrixView, findingTableKey, statusChips, tableKey } from "./matrix-view";
export type { MatrixCellView, MatrixRowView, MatrixTableView, MatrixView } from "./matrix-view";

export {
  GRID_KEYS,
  PAGE_ROWS,
  cellAt,
  firstCell,
  isGridKey,
  moveInGrid,
  positionOf,
} from "./grid-nav";
export type { GridCells, GridKey, GridPosition } from "./grid-nav";

export { buildVerdictView, countPhrase, runStatusText, verdictAnnouncement } from "./verdict-view";
export type { VerdictCount, VerdictView } from "./verdict-view";

export {
  KEY_LIST_CAP,
  buildCellKeyLists,
  buildKeyList,
  buildSubProbeViews,
  cellTranscript,
  formatKey,
} from "./cell-view";
export type { CellKeyLists, KeyListView, SubProbeView } from "./cell-view";

export { buildTablesView } from "./tables-view";
export type {
  ExpectationCellView,
  ExpectationRowView,
  ExpectationTableView,
  LabTableView,
  TableConfigSource,
  TablesView,
} from "./tables-view";

export { formatIssue, issuesUnder, personaIssues, validateLabScenario } from "./validation";
export type { LabValidation } from "./validation";

export {
  SCENARIO_FILE_SUFFIX,
  SCENARIO_FILE_TYPE,
  parseScenarioFile,
  renamedScenario,
  scenarioFileName,
  scenarioFileText,
} from "./scenario-file";

export { SUB_PROBE_LABELS, SUB_PROBE_OUTCOME_LABELS } from "./status-meta";
