/**
 * The matrix runner's public surface: `@/lib/runner`. The UI, the static checks, the export and
 * the golden tests import from here. Pure (ARCH-001, SEC-004): the database comes in as a port.
 */
export { MatrixAbortedError, runMatrix } from "./run-matrix";
export type { MatrixProgress, MatrixRun, MatrixTimings, RunMatrixOptions } from "./run-matrix";

export { CELL_STATUSES, MATRIX_RESULT_VERSION, SUB_PROBE_KINDS, VERDICTS } from "./result";
export type {
  CellPolicy,
  CellResult,
  CellStatus,
  MatrixPersona,
  MatrixResult,
  MatrixTable,
  ProbeFailure,
  RlsBypass,
  StatusCounts,
  SubProbeKind,
  SubProbeOutcome,
  SubProbeResult,
  Verdict,
} from "./result";

export {
  STATUS_SEVERITY,
  classifyCell,
  classifyInsertCell,
  classifySubProbe,
  countStatuses,
  diffKeys,
  isBlocked,
  isDataException,
  isDatabaseLost,
  isRowSecurityViolation,
  isStatementDenial,
  outcomeOfFailure,
  sortKeys,
  toProbeFailure,
  verdictOf,
} from "./classify";
export type { CellEvidence, KeyDiff } from "./classify";

export {
  CLAIMS_SETTING,
  RESET_ROLE_PROBE,
  WHOAMI_PROBE,
  deleteBlindProbe,
  deleteReachProbe,
  deleteRowProbe,
  escapeBulkProbe,
  escapeTargetedProbe,
  identityProbes,
  insertCloneProbe,
  parseKey,
  pullBlindProbe,
  pullRowProbe,
  renderProbeScript,
  rowVersionsProbe,
  rowsEqualToProbe,
  rowsWithValueProbe,
  selectCountProbe,
  selectReachProbe,
  sourceCopyProbe,
  sourceGrantProbe,
  staticProbe,
  updateBlindProbe,
  updateReachProbe,
  updateRowProbe,
} from "./probes";
export type { ColumnValue, Probe, ProbeIdentity, ProbeTable } from "./probes";

export { ExpectedRowsSqlError, expectedRowsProbe } from "./expected-rows";
export type { NamedValues } from "./expected-rows";
export {
  NAMED_PARAMETERS,
  NamedParameterError,
  inlineNamedParameters,
  rewriteNamedParameters,
} from "./named-params";
export type { NamedParameter, RewrittenSql } from "./named-params";

export {
  BLIND_UPDATE_CANDIDATES,
  blindUpdateColumns,
  chooseUpdateColumn,
  claimsJsonOf,
  cloneColumns,
  effectiveClaims,
  expectedKeysForScope,
  isWritable,
  personaFacts,
  planEscape,
  planFreshKey,
  planInsertClasses,
  planTenantEscape,
  pullMoves,
  textMembership,
} from "./plan";
export type {
  EscapeInput,
  EscapePlan,
  FreshKeyPlan,
  InsertClassKind,
  InsertClassPlan,
  PersonaFacts,
  Planned,
  ScopeMembership,
} from "./plan";

export { DEFAULT_ERROR_BUDGET, withErrorBudget } from "./error-budget";
export type { BudgetedEngine, ErrorBudget } from "./error-budget";

export { findRole, policiesFor, privilegeRolesOf, rlsBypassFor, roleWideBypass } from "./roles";

export {
  IdentityError,
  SuperuserStepError,
  createProbeExecutor,
  executeAsPersona,
} from "./executor";
export type {
  Attempt,
  PersonaRun,
  PersonaSession,
  ProbeExecutor,
  ProbeExecutorOptions,
} from "./executor";

export { EMPTY_TABLE_REMARK, cellId } from "./cells";
