/**
 * The scenario model (brief section 3.4). The scenario JSON is the unit of save, share, fork,
 * template and export. These types are the contract; `schema.ts` holds the matching zod schemas
 * and asserts at compile time that both agree.
 */

/** The only scenario format version this build reads and writes. */
export const SCENARIO_VERSION = 1;

export const MODES = ["supabase", "postgres"] as const;
export type Mode = (typeof MODES)[number];

/** Stable order of operations: every matrix, export and result uses this order. */
export const OPERATIONS = ["select", "insert", "update", "delete"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const SCOPES = ["none", "own", "tenant", "all", "custom"] as const;
export type Scope = (typeof SCOPES)[number];

export const SUPABASE_GRANT_REGIMES = ["legacy", "explicit"] as const;
export type SupabaseGrants = (typeof SUPABASE_GRANT_REGIMES)[number];

/** The three roles Supabase ships. In `supabase` mode a persona must use one of them. */
export const SUPABASE_ROLES = ["anon", "authenticated", "service_role"] as const;
export type SupabaseRole = (typeof SUPABASE_ROLES)[number];

export interface Persona {
  id: string;
  label: string;
  /** `anon`, `authenticated`, `service_role`, or a custom role name in `postgres` mode. */
  dbRole: string;
  /** The JWT claims, a JSON object. `sub` is the user id. */
  claims: Record<string, unknown>;
  /** Dot path into `claims`, for example `tenant_id` or `app_metadata.tenant_id`. */
  tenantClaimPath?: string;
}

export interface TableConfig {
  schema: string;
  name: string;
  ownerColumn?: string;
  tenantColumn?: string;
}

export interface Expectation {
  personaId: string;
  schema: string;
  table: string;
  operation: Operation;
  scope: Scope;
  /**
   * Required if and only if `scope` is `custom`. Run as superuser, returns the primary keys the
   * persona should reach; `:sub` and `:claims` are the parameters.
   */
  expectedRowsSql?: string;
}

export interface ScenarioOptions {
  /** Schemas whose tables are tested. Default `['public']`. */
  exposedSchemas: string[];
  /**
   * Supabase default grants regime (ADR 0002): `legacy` is the blanket grant to `anon`,
   * `authenticated` and `service_role`; `explicit` grants nothing by default. Default `legacy`.
   */
  supabaseGrants: SupabaseGrants;
}

export interface Scenario {
  id: string;
  version: typeof SCENARIO_VERSION;
  title: string;
  description: string;
  mode: Mode;
  schemaSql: string;
  seedSql: string;
  personas: Persona[];
  tables: TableConfig[];
  expectations: Expectation[];
  options?: ScenarioOptions;
}

/** What the setup pipeline needs from a scenario, and nothing more. */
export type ScenarioSetupInput = Pick<Scenario, "mode" | "schemaSql" | "seedSql" | "options">;

/** A table as introspection reports it: the minimum the defaults need. */
export interface TableRef {
  schema: string;
  name: string;
}

/** An effective expectation: explicit from the scenario, or filled in by the defaults. */
export interface ResolvedExpectation extends Expectation {
  source: "explicit" | "default";
}
