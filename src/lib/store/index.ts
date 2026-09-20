/**
 * Public surface of the scenario store for CLIENT code: the port, the local adapter, the
 * remote adapter (over the app's own `/api/scenarios` routes) and the chooser. Server code
 * imports `@/lib/store/server`; the browser auth helper is `@/lib/store/auth-client`.
 */
export {
  STORE_ERROR_CODES,
  StoreError,
  VISIBILITIES,
  isStoreError,
  type SaveScenarioInput,
  type ScenarioStore,
  type StoreErrorCode,
  type StoreErrorDetails,
  type StoreErrorIssue,
  type StoreProblem,
  type StoredScenario,
  type StoredScenarioSummary,
  type Visibility,
} from "./types";
export {
  LOCAL_INDEX_KEY,
  LOCAL_STORE_PREFIX,
  LOCAL_STORE_VERSION,
  createLocalScenarioStore,
  localEntryKey,
  type LocalScenarioStore,
  type LocalStorageLike,
  type LocalStoreOptions,
} from "./local";
export { createRemoteScenarioStore, type FetchLike } from "./remote";
export { getScenarioStore, type ScenarioStoreChoice } from "./choose";
export {
  MAX_SLUG_LENGTH,
  MIN_SLUG_LENGTH,
  SCENARIOS_API_PATH,
  SLUG_PATTERN,
  remoteIdSchema,
  scenarioListResponseSchema,
  scenarioResponseSchema,
  slugSchema,
  storeErrorBodySchema,
  storedScenarioSchema,
  storedScenarioSummarySchema,
  visibilitySchema,
  type StoreErrorBody,
} from "./wire";
