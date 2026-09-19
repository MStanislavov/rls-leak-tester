/**
 * The Supabase SQL the setup pipeline needs, in the shape `setupDatabase` takes it. The pipeline
 * is pure and may not value-import `src/lib/engine` (SEC-004), so the module that holds the
 * engine passes this constant in:
 *
 *   await setupDatabase(engine, scenario, SUPABASE_SETUP_SQL);
 */
import type { SupabaseSetupSql } from "@/lib/runner/setup";
import { quoteIdent, SUPABASE_SHIM_SQL, supabaseDefaultGrantsSql } from "./supabase-shim";

export const SUPABASE_SETUP_SQL: SupabaseSetupSql = {
  shimSql: SUPABASE_SHIM_SQL,
  defaultGrantsSql: (schema, options) => supabaseDefaultGrantsSql(schema, options),
  createSchemaSql: (schema) => `create schema if not exists ${quoteIdent(schema)};`,
};
