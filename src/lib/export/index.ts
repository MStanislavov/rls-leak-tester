/**
 * The CI export's public surface: `@/lib/export`. Pure (ARCH-001): the scenario, a completed
 * matrix run and the Supabase setup SQL come in as values; five text files come out.
 *
 *   const { files } = generateCiExport({ scenario, run, supabase: SUPABASE_SETUP_SQL });
 */
export {
  CI_EXPORT_FILE_NAMES,
  CiExportError,
  DEFAULT_TOOL_NAME,
  generateCiExport,
} from "./generate";
export type { CiExport, CiExportFile, CiExportFileName, CiExportInput } from "./generate";

export { CORE_PRINCIPLE } from "./test-sql";
export {
  CHECKOUT_ACTION,
  CHECKOUT_VERSION,
  POSTGRES_IMAGE,
  SQL_DIRECTORY,
  WORKFLOW_PATH,
} from "./workflow";
