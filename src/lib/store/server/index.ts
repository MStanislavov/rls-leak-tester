/**
 * Server surface of the scenario store. Framework-free; the Next.js wiring (cookies, the
 * per-request Supabase client) is `@/lib/store/server/next`. Never import this from client code.
 */
export {
  AUTH_CALLBACK_PATH,
  AUTH_ERROR_CODES,
  AUTH_ERROR_PARAM,
  AUTH_SIGNOUT_PATH,
  DEFAULT_AFTER_SIGN_IN,
  DEFAULT_AFTER_SIGN_OUT,
  authErrorSchema,
  handleAuthCallback,
  handleSignOut,
  safeRedirectUrl,
  type AuthErrorCode,
  type AuthRouteDeps,
} from "./auth";
export {
  parseCreateScenarioBody,
  parseUpdateScenarioBody,
  readJsonBody,
  type CreateScenarioInput,
  type UpdateScenarioInput,
} from "./body";
export {
  handleCreateScenario,
  handleDeleteScenario,
  handleGetScenario,
  handleGetScenarioBySlug,
  handleListScenarios,
  handleUpdateScenario,
  parseScenarioIdParams,
  parseScenarioSlugParams,
  type ParamResult,
  type ScenarioAction,
  type ScenarioApiDeps,
  type ScenarioLogEvent,
} from "./handlers";
export {
  NOT_CONFIGURED_MESSAGE,
  isCrossSiteRequest,
  statusOfStoreError,
  storeErrorResponse,
} from "./http";
export {
  LIST_MAX_ROWS,
  SCENARIO_BODY_MAX_BYTES,
  SCENARIO_PAYLOAD_DB_MAX_BYTES,
  SLUG_MAX_ATTEMPTS,
  SLUG_SUFFIX_LENGTH,
  UNAVAILABLE_RETRY_AFTER_SECONDS,
} from "./policy";
export {
  createSupabaseScenarioRepository,
  type ScenarioRepository,
  type ScenarioRow,
  type ScenarioSummaryRow,
} from "./repository";
export {
  create,
  getById,
  getBySlug,
  listMine,
  newSlug,
  remove,
  update,
  type ScenarioServiceDeps,
} from "./service";
export { requireUserId, resolveUserId } from "./session";
