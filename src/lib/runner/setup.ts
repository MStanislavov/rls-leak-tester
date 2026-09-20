/**
 * The setup pipeline: turns a fresh, empty database into the scenario's database.
 *
 * Order (ADR 0002, a deliberate deviation from brief 3.5 steps 3 and 4):
 *
 *   supabase mode: 1. the Supabase shim, 2. the default grants for every exposed schema,
 *                  3. the user's schema SQL, 4. the user's seed SQL.
 *   postgres mode: 3 and 4 only. The user's SQL creates its roles and grants.
 *
 * The grants run BEFORE the user's schema because on Supabase they are default privileges that
 * exist before any user object. Applied afterwards they would undo a `REVOKE` in the user's SQL
 * and the product would report a leak that does not exist.
 *
 * `options.supabaseGrants` picks the regime: `legacy` grants everything on present and future
 * objects, so RLS is the only barrier and an RLS-disabled table is readable by `anon`;
 * `explicit` leaves new tables without select, insert, update and delete until the user's SQL
 * grants them (every Supabase project from 2026-10-30).
 *
 * The user's SQL runs statement by statement, so a failure names the statement that caused it
 * (brief 3.3). Every statement commits on its own, as in psql; a script that wants one
 * transaction writes `BEGIN; ... COMMIT;`, which works because the engine has one connection.
 *
 * SESSION STATE. The engine has ONE connection, so whatever the user's SQL leaves in the session
 * would still be there when the probes run. Three things are therefore done around it:
 *
 * - The time zone is pinned to UTC first, so a seed literal without a zone and every timestamptz
 *   that ends up in a key mean the same on every machine (PGlite takes its zone from the host).
 * - After each script the transaction state is checked. A `BEGIN` without `COMMIT` would make the
 *   first probe's ROLLBACK discard the script (in psql the disconnect would): that is a
 *   `SetupError` (SQLSTATE 25001) on the `BEGIN`, not a run against an empty table.
 * - After the seed the session is reset: `RESET SESSION AUTHORIZATION`, `RESET ROLE`,
 *   `RESET ALL`, and UTC again. Every pg_dump file starts with `SET row_security = off` and an
 *   empty `search_path`; a seed may "sign in" through `request.jwt.claim.sub`. Settings stay in
 *   force from the schema script into the seed script, as they do when both are one file.
 *
 * This module is pure (ARCH-001, SEC-004). The shim SQL lives in `src/lib/engine`, which the
 * runner may not value-import, so whoever holds the engine passes it in: `SUPABASE_SETUP_SQL`
 * from `@/lib/engine/supabase-setup-sql`.
 */
import { splitSqlStatements, type ScenarioSetupInput, type SqlStatement } from "@/lib/scenario";
import { EngineError, SqlError, type SqlEngine } from "./types";

export const DEFAULT_EXPOSED_SCHEMAS: readonly string[] = ["public"];

/** The Supabase-specific SQL the pipeline needs, supplied by the engine layer. */
export interface SupabaseSetupSql {
  /** Roles, the `auth` schema and its functions. Run once on a fresh database. */
  readonly shimSql: string;
  /** The default privileges of one exposed schema, for the chosen regime. */
  defaultGrantsSql(schema: string, options: { readonly autoExposeNewTables: boolean }): string;
  /** `create schema if not exists` for an exposed schema other than `public`. */
  createSchemaSql(schema: string): string;
}

export type SetupPhase = "shim" | "grants" | "schema" | "seed";

export interface SetupErrorFields {
  readonly phase: SetupPhase;
  /** Zero-based index among the statements of that phase's script. */
  readonly statementIndex: number;
  readonly statement: string;
  /** One-based line and column of the statement's first token in the script. */
  readonly line: number;
  readonly column: number;
  /** The SQLSTATE, or `null` when the engine failed before Postgres judged the statement. */
  readonly sqlState: string | null;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly hint?: string | undefined;
  /** One-based character offset INTO `statement` that Postgres points at, when it does. */
  readonly position?: number | undefined;
}

/**
 * A statement of the setup failed. `phase` is `schema` or `seed` for the user's SQL; `shim` and
 * `grants` are this product's own SQL and mean a bug here or an unusable exposed schema name.
 */
export class SetupError extends Error implements SetupErrorFields {
  override readonly name = "SetupError";
  readonly phase: SetupPhase;
  readonly statementIndex: number;
  readonly statement: string;
  readonly line: number;
  readonly column: number;
  readonly sqlState: string | null;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly position: number | undefined;

  constructor(fields: SetupErrorFields, options?: { cause?: unknown }) {
    super(fields.message, options);
    this.phase = fields.phase;
    this.statementIndex = fields.statementIndex;
    this.statement = fields.statement;
    this.line = fields.line;
    this.column = fields.column;
    this.sqlState = fields.sqlState;
    this.detail = fields.detail;
    this.hint = fields.hint;
    this.position = fields.position;
  }
}

export interface SetupSummary {
  readonly mode: ScenarioSetupInput["mode"];
  readonly exposedSchemas: readonly string[];
  /** `null` in postgres mode, where no automatic grant is made. */
  readonly supabaseGrants: "legacy" | "explicit" | null;
  readonly schemaStatements: number;
  readonly seedStatements: number;
}

function toSetupError(phase: SetupPhase, statement: SqlStatement, error: unknown): SetupError {
  const location = {
    phase,
    statementIndex: statement.index,
    statement: statement.text,
    line: statement.line,
    column: statement.column,
  };
  if (error instanceof SqlError) {
    return new SetupError(
      {
        ...location,
        sqlState: error.code,
        message: error.message,
        detail: error.detail,
        hint: error.hint,
        position: error.position,
      },
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SetupError({ ...location, sqlState: null, message }, { cause: error });
}

async function runScript(engine: SqlEngine, phase: SetupPhase, script: string): Promise<number> {
  const statements = splitSqlStatements(script);
  for (const statement of statements) {
    try {
      await engine.exec(statement.text);
    } catch (error) {
      // A lost database is not the statement's fault: the caller replays the setup (ADR 0003).
      if (error instanceof EngineError && error.databaseLost) {
        throw error;
      }
      throw toSetupError(phase, statement, error);
    }
  }
  return statements.length;
}

const OPEN_TRANSACTION_CHECK = "savepoint rls_leak_tester_open_transaction_check";
const SQLSTATE_NO_ACTIVE_TRANSACTION = "25P01";
const SQLSTATE_ACTIVE_TRANSACTION = "25001";
const OPENS_TRANSACTION = /^\s*(begin|start\s+transaction)\b/i;

/**
 * `true` when the session is inside a transaction block. SAVEPOINT is the one statement that
 * tells: outside a block it raises 25P01, inside one it succeeds (the caller rolls back anyway).
 */
async function transactionIsOpen(engine: SqlEngine): Promise<boolean> {
  try {
    await engine.exec(OPEN_TRANSACTION_CHECK);
    return true;
  } catch (error) {
    if (error instanceof SqlError && error.code === SQLSTATE_NO_ACTIVE_TRANSACTION) {
      return false;
    }
    throw error;
  }
}

async function refuseOpenTransaction(
  engine: SqlEngine,
  phase: SetupPhase,
  script: string,
): Promise<void> {
  if (!(await transactionIsOpen(engine))) {
    return;
  }
  await engine.exec("rollback");
  const statements = splitSqlStatements(script);
  const culprit =
    statements.findLast((statement) => OPENS_TRANSACTION.test(statement.text)) ?? statements.at(-1);
  throw new SetupError({
    phase,
    statementIndex: culprit?.index ?? 0,
    statement: culprit?.text ?? "",
    line: culprit?.line ?? 1,
    column: culprit?.column ?? 1,
    sqlState: SQLSTATE_ACTIVE_TRANSACTION,
    message: `The ${phase} SQL leaves a transaction open: a BEGIN has no COMMIT. Nothing it did would be kept (psql would discard it on disconnect, and here the first probe's ROLLBACK would). Add COMMIT, or remove the BEGIN.`,
  });
}

/** Ours, not the user's: a failure here is a bug of this product, so it is not a SetupError. */
export const PIN_TIME_ZONE = "set time zone 'UTC'";
/** The session as the probes need it; the CI export starts its test file with the same statements. */
export const RESET_SESSION: readonly string[] = [
  "reset session authorization",
  "reset role",
  "reset all",
  PIN_TIME_ZONE,
];

/** The exposed schemas of a scenario: the default, without duplicates, in the given order. */
export function exposedSchemasOf(scenario: Pick<ScenarioSetupInput, "options">): string[] {
  const configured = scenario.options?.exposedSchemas ?? [];
  return [...new Set(configured.length > 0 ? configured : DEFAULT_EXPOSED_SCHEMAS)];
}

/** The grants regime of a scenario; `null` in postgres mode, where no automatic grant is made. */
export function supabaseGrantsOf(
  scenario: Pick<ScenarioSetupInput, "mode" | "options">,
): SetupSummary["supabaseGrants"] {
  return scenario.mode === "supabase" ? (scenario.options?.supabaseGrants ?? "legacy") : null;
}

/**
 * The scripts that run before the user's schema, in order: the shim, then the default grants of
 * every exposed schema. Empty in postgres mode. `setupDatabase` runs exactly these, and the CI
 * export writes exactly these into its setup file.
 */
export function supabasePrelude(
  scenario: Pick<ScenarioSetupInput, "mode" | "options">,
  supabase: SupabaseSetupSql,
): { readonly phase: Extract<SetupPhase, "shim" | "grants">; readonly script: string }[] {
  const regime = supabaseGrantsOf(scenario);
  if (regime === null) {
    return [];
  }
  const autoExposeNewTables = regime === "legacy";
  return [
    { phase: "shim", script: supabase.shimSql },
    ...exposedSchemasOf(scenario).map((schema) => ({
      phase: "grants" as const,
      script: `${supabase.createSchemaSql(schema)}\n${supabase.defaultGrantsSql(schema, { autoExposeNewTables })}`,
    })),
  ];
}

/**
 * Prepares `engine`, which must be a FRESH, empty database (never reuse state between runs).
 * After `EngineTimeoutError` the engine is empty again: call this again before the next probe.
 *
 * @throws SetupError for a failing statement; `EngineTimeoutError` / `EngineTerminatedError`
 *   unchanged when the database was lost on the way.
 */
export async function setupDatabase(
  engine: SqlEngine,
  scenario: ScenarioSetupInput,
  supabase: SupabaseSetupSql,
): Promise<SetupSummary> {
  const exposedSchemas = exposedSchemasOf(scenario);
  const supabaseGrants = supabaseGrantsOf(scenario);
  await engine.exec(PIN_TIME_ZONE);

  for (const { phase, script } of supabasePrelude(scenario, supabase)) {
    await runScript(engine, phase, script);
  }

  const schemaStatements = await runScript(engine, "schema", scenario.schemaSql);
  await refuseOpenTransaction(engine, "schema", scenario.schemaSql);
  const seedStatements = await runScript(engine, "seed", scenario.seedSql);
  await refuseOpenTransaction(engine, "seed", scenario.seedSql);
  for (const statement of RESET_SESSION) {
    await engine.exec(statement);
  }

  return {
    mode: scenario.mode,
    exposedSchemas,
    supabaseGrants,
    schemaStatements,
    seedStatements,
  };
}
