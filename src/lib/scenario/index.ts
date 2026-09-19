/**
 * The scenario model. Everything other modules need comes from here: `@/lib/scenario`.
 * Templates live in `./templates` and are imported from there, so that a page which only needs
 * the types does not load them.
 */
export {
  MODES,
  OPERATIONS,
  SCENARIO_VERSION,
  SCOPES,
  SUPABASE_GRANT_REGIMES,
  SUPABASE_ROLES,
} from "./types";
export type {
  Expectation,
  Mode,
  Operation,
  Persona,
  ResolvedExpectation,
  Scenario,
  ScenarioOptions,
  ScenarioSetupInput,
  Scope,
  SupabaseGrants,
  SupabaseRole,
  TableConfig,
  TableRef,
} from "./types";

export {
  MAX_CLAIM_PATH_LENGTH,
  MAX_CLAIMS_DEPTH,
  MAX_CLAIMS_JSON_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_EXPECTATIONS,
  MAX_EXPECTED_ROWS_SQL_LENGTH,
  MAX_EXPOSED_SCHEMAS,
  MAX_ID_LENGTH,
  MAX_IDENTIFIER_BYTES,
  MAX_LABEL_LENGTH,
  MAX_PERSONAS,
  MAX_SCENARIO_JSON_LENGTH,
  MAX_SQL_LENGTH,
  MAX_TABLES,
  MAX_TITLE_LENGTH,
} from "./limits";

export {
  DEFAULT_EXPOSED_SCHEMAS,
  DEFAULT_SUPABASE_GRANTS,
  SCENARIO_MIGRATIONS,
  expectationSchema,
  formatIssuePath,
  migrateScenario,
  modeSchema,
  operationSchema,
  parseScenario,
  parseScenarioJson,
  personaSchema,
  resolveOptions,
  scenarioOptionsSchema,
  scenarioSchema,
  scopeSchema,
  tableConfigSchema,
} from "./schema";
export type { ParseScenarioResult, ScenarioIssue, ScenarioMigration } from "./schema";

export { defaultScope, findOrphanExpectations, resolveExpectations } from "./defaults";
export type { DefaultScope } from "./defaults";

export {
  OWNER_COLUMN_NAMES,
  TENANT_COLUMN_NAMES,
  compareText,
  resolveTableConfigs,
  suggestTableConfig,
} from "./heuristics";
export type { IntrospectedTableColumns, TableConfigSuggestion } from "./heuristics";

export { getClaimPath, isUuid, personaSub, personaTenant } from "./claims";

export { offsetToPosition, splitSqlStatements } from "./sql-split";
export type { SqlPosition, SqlStatement } from "./sql-split";

export { qualifiedName, quoteIdent, quoteLiteral } from "./ident";

export { canonicalScenario, serializeScenario, stableStringify } from "./serialize";

export {
  ID_PATTERN,
  createScenarioId,
  isValidId,
  newScenarioId,
  randomIdSuffix,
  slugify,
} from "./ids";
export type { FillRandom } from "./ids";
