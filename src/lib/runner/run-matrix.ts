/**
 * The matrix runner (brief 3.5): persona x table x operation against a FRESH database, every
 * probe under the persona's role in a rolled-back transaction, every status from comparing row
 * sets. Pure: the database comes in as a factory (ARCH-001, SEC-004).
 *
 * Why a factory and not an engine. PGlite cannot cancel a statement; the only timeout is to
 * terminate the worker, and a new worker is an EMPTY database (ADR 0002, ADR 0003). When a probe
 * loses the database the cell becomes `inconclusive`, the old engine is closed, a new one is
 * built through the factory, setup, introspection and ground truth are replayed, and the run
 * goes on with the next cell. The run ceiling belongs to the host: it aborts through `signal`.
 * The same happens BEFORE a session wears out: PGlite survives only a few thousand SQL errors
 * per session (`error-budget.ts`), so the engine is wrapped with a budget and replaced in time.
 *
 * Determinism: cells in the order of `resolveExpectations` (table, persona, operation), keys
 * sorted, no clock and no randomness in `result`. Durations are returned beside it in `timings`.
 *
 * What is NOT caught here: `SetupError` (the user's SQL failed; the UI shows it next to the
 * statement), a lost database during setup, and `MatrixAbortedError`. The engine is closed in
 * every case.
 */
import {
  compareText,
  findOrphanExpectations,
  qualifiedName,
  resolveExpectations,
  resolveTableConfigs,
  type Persona,
  type ResolvedExpectation,
  type Scenario,
  type TableConfig,
} from "@/lib/scenario";
import {
  EMPTY_TABLE_REMARK,
  cellBase,
  cellId,
  deleteCell,
  insertCell,
  selectCell,
  updateCell,
  type CellContext,
  type CellOutcome,
} from "./cells";
import { countStatuses, isDatabaseLost, sortKeys, toProbeFailure, verdictOf } from "./classify";
import { withErrorBudget, type BudgetedEngine, type ErrorBudget } from "./error-budget";
import { executeAsPersona, type ProbeExecutor } from "./executor";
import { expectedRowsProbe } from "./expected-rows";
import {
  groundTruth,
  keyOfRow,
  type GroundTruth,
  type GroundTruthSnapshot,
  type GroundTruthTable,
} from "./ground-truth";
import { findTable, introspect, type Catalog, type CatalogTable } from "./introspect";
import {
  claimsJsonOf,
  expectedKeysForScope,
  personaFacts,
  textMembership,
  type PersonaFacts,
  type Planned,
  type ScopeMembership,
} from "./plan";
import { rowsEqualToProbe, type Probe } from "./probes";
import {
  MATRIX_RESULT_VERSION,
  type CellResult,
  type MatrixPersona,
  type MatrixResult,
  type MatrixTable,
  type ProbeFailure,
} from "./result";
import { findRole, policiesFor, rlsBypassFor, roleWideBypass } from "./roles";
import { exposedSchemasOf, setupDatabase, type SupabaseSetupSql } from "./setup";
import { SqlError, type SqlEngine, type SqlQueryResult } from "./types";

export interface MatrixProgress {
  /** Cells finished so far, this one included. */
  readonly done: number;
  readonly total: number;
  readonly cell: CellResult;
}

export interface RunMatrixOptions {
  /** A FRESH, empty database per call. Called once per run, and again after a lost database. */
  readonly createEngine: () => Promise<SqlEngine>;
  /** `SUPABASE_SETUP_SQL` from `@/lib/engine/supabase-setup-sql`; the runner cannot import it. */
  readonly supabase: SupabaseSetupSql;
  /** Cooperative cancellation, checked before every cell. */
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: MatrixProgress) => void) | undefined;
  /** The clock for `timings`; defaults to `Date.now`. Never reaches `result`. */
  readonly now?: (() => number) | undefined;
  /** Test seam for the bypass guards (RUN-001). Production code leaves it out. */
  readonly executor?: ProbeExecutor | undefined;
  /** SQL errors one database session may raise; defaults to `DEFAULT_ERROR_BUDGET`. */
  readonly errorBudget?: ErrorBudget | undefined;
}

export interface MatrixTimings {
  readonly totalMs: number;
  /** Engine start, setup, introspection and ground truth of the first build. */
  readonly setupMs: number;
  /** How often the database was rebuilt: after a timeout, a terminated worker, a worn-out session. */
  readonly rebuilds: number;
  readonly cells: readonly { readonly id: string; readonly ms: number }[];
}

export interface MatrixRun {
  /** Deterministic: the same scenario gives a byte-identical `JSON.stringify(result)`. */
  readonly result: MatrixResult;
  /** For the static checks and the export; from the last build of the database. */
  readonly catalog: Catalog;
  /** The effective table configs: configured ones, plus the heuristics for the rest. */
  readonly tableConfigs: readonly TableConfig[];
  readonly timings: MatrixTimings;
}

/** The run was cancelled through `signal`. Nothing is returned; the engine is closed. */
export class MatrixAbortedError extends Error {
  override readonly name = "MatrixAbortedError";

  constructor() {
    super("The matrix run was cancelled.");
  }
}

// ---------------------------------------------------------------------------------------------
// The database of a run: built, and rebuilt after a loss
// ---------------------------------------------------------------------------------------------

/** The columns of one table a role may use, from `has_column_privilege`. */
interface ColumnPrivileges {
  readonly update: ReadonlySet<string>;
  readonly select: ReadonlySet<string>;
}

interface Built {
  readonly engine: BudgetedEngine;
  readonly catalog: Catalog;
  readonly tableConfigs: TableConfig[];
  readonly truth: GroundTruth;
  /** Per role and table; filled on demand, valid for this build of the database. */
  readonly columnPrivileges: Map<string, ColumnPrivileges>;
  /** Per persona and table; filled on demand, valid for this build of the database. */
  readonly memberships: Map<string, ScopeMembership>;
}

async function closeQuietly(engine: SqlEngine): Promise<void> {
  // A terminated worker may refuse even `close`; there is nothing left to release then.
  await engine.close().catch(() => undefined);
}

async function build(scenario: Scenario, options: RunMatrixOptions): Promise<Built> {
  const engine = withErrorBudget(await options.createEngine(), options.errorBudget);
  try {
    await setupDatabase(engine, scenario, options.supabase);
    const catalog = await introspect(engine, exposedSchemasOf(scenario));
    const tableConfigs = resolveTableConfigs(
      scenario.tables,
      catalog.tables.map((table) => ({
        schema: table.schema,
        name: table.name,
        columns: table.columns.map((column) => column.name),
      })),
    );
    const truth = await groundTruth(engine, catalog, tableConfigs);
    return {
      engine,
      catalog,
      tableConfigs,
      truth,
      columnPrivileges: new Map(),
      memberships: new Map(),
    };
  } catch (error) {
    await closeQuietly(engine);
    throw error;
  }
}

/** One statement as the superuser, in a transaction that is rolled back. */
async function readAsSuperuser(
  engine: SqlEngine,
  probe: Probe,
  before: readonly Probe[] = [],
): Promise<SqlQueryResult> {
  return engine.transaction(async (tx) => {
    try {
      for (const statement of before) {
        await tx.query(statement.sql, statement.params);
      }
      return await tx.query(probe.sql, probe.params);
    } finally {
      await tx.rollback();
    }
  });
}

const COLUMN_PRIVILEGES_SQL = `select a.attname::text as name,
       has_column_privilege($1::text, a.attrelid, a.attnum, 'UPDATE') as can_update,
       has_column_privilege($1::text, a.attrelid, a.attnum, 'SELECT') as can_select
  from pg_catalog.pg_attribute a
 where a.attrelid = $2::text::regclass and a.attnum > 0 and not a.attisdropped
 order by a.attnum`;

async function columnPrivileges(
  built: Built,
  role: string,
  table: CatalogTable,
): Promise<ColumnPrivileges> {
  const cacheKey = JSON.stringify([role, table.schema, table.name]);
  const cached = built.columnPrivileges.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const { rows } = await built.engine.query(COLUMN_PRIVILEGES_SQL, [
    role,
    // `regclass` input wants the quoted, qualified name.
    qualifiedName(table.schema, table.name),
  ]);
  const namesWhere = (flag: "can_update" | "can_select"): Set<string> =>
    new Set(rows.filter((row) => row[flag] === true).map((row) => String(row.name)));
  const privileges = { update: namesWhere("can_update"), select: namesWhere("can_select") };
  built.columnPrivileges.set(cacheKey, privileges);
  return privileges;
}

/**
 * The rows whose `column` equals `value`, compared by Postgres in the column's type. `null` when
 * Postgres cannot compare (the claim does not fit the type, the type has no `=`): the caller
 * falls back to comparing text.
 */
async function rowsEqualTo(
  built: Built,
  truth: GroundTruthSnapshot,
  table: CatalogTable,
  column: string | null,
  value: string | undefined,
): Promise<ReadonlySet<string> | null> {
  const type = table.columns.find((candidate) => candidate.name === column)?.type;
  if (column === null || value === undefined || type === undefined) {
    return null;
  }
  try {
    const { rows } = await readAsSuperuser(
      built.engine,
      rowsEqualToProbe(truth, { column, type, value }),
    );
    return new Set(rows.map((row) => keyOfRow(row, truth.primaryKey.length)));
  } catch (error) {
    if (error instanceof SqlError) {
      return null;
    }
    throw error;
  }
}

async function membershipOf(
  built: Built,
  persona: Persona,
  facts: PersonaFacts,
  truth: GroundTruthSnapshot,
  table: CatalogTable,
): Promise<ScopeMembership> {
  const cacheKey = JSON.stringify([persona.id, table.schema, table.name]);
  const cached = built.memberships.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const byText = textMembership(truth, facts);
  const membership = {
    own: (await rowsEqualTo(built, truth, table, truth.ownerColumn, facts.sub)) ?? byText.own,
    tenant:
      (await rowsEqualTo(built, truth, table, truth.tenantColumn, facts.tenant)) ?? byText.tenant,
  };
  built.memberships.set(cacheKey, membership);
  return membership;
}

// ---------------------------------------------------------------------------------------------
// One cell
// ---------------------------------------------------------------------------------------------

interface CellInput {
  readonly scenario: Scenario;
  readonly persona: Persona;
  readonly expectation: ResolvedExpectation;
  readonly executor: ProbeExecutor;
}

const OPERATION_CELLS = {
  select: selectCell,
  insert: insertCell,
  update: updateCell,
  delete: deleteCell,
} as const;

type ExpectedKeys =
  Planned<{ keys: string[] }> | { status: "failed"; failure: ProbeFailure; databaseLost: boolean };

async function expectedKeys(
  built: Built,
  input: CellInput,
  truth: GroundTruthSnapshot,
  membership: ScopeMembership,
  claimsJson: string,
): Promise<ExpectedKeys> {
  const { expectation, persona } = input;
  const facts = personaFacts(persona);
  if (expectation.scope !== "custom") {
    return expectedKeysForScope(expectation.scope, truth, facts, membership);
  }
  try {
    const probe = expectedRowsProbe(truth, expectation.expectedRowsSql ?? "", {
      sub: facts.sub ?? null,
      claims: claimsJson,
    });
    const { rows } = await readAsSuperuser(built.engine, probe);
    return {
      status: "ok",
      keys: sortKeys(rows.map((row) => keyOfRow(row, truth.primaryKey.length))),
    };
  } catch (error) {
    const failure = toProbeFailure(error);
    return {
      status: "failed",
      failure: { ...failure, message: `expectedRowsSql failed: ${failure.message}` },
      databaseLost: isDatabaseLost(error),
    };
  }
}

function truthOf(built: Built, expectation: ResolvedExpectation): GroundTruthTable | undefined {
  return built.truth.tables.find(
    (table) => table.schema === expectation.schema && table.name === expectation.table,
  );
}

async function runCell(built: Built, input: CellInput): Promise<CellOutcome> {
  const { expectation, persona, scenario } = input;
  const table = findTable(built.catalog, expectation.schema, expectation.table);
  const truth = truthOf(built, expectation);
  const policies =
    table === undefined
      ? []
      : policiesFor(built.catalog, persona.dbRole, table, expectation.operation);
  const rlsBypass = table === undefined ? null : rlsBypassFor(built.catalog, persona.dbRole, table);
  const base = cellBase(expectation, policies, rlsBypass);
  const skip = (reason: string): CellOutcome => ({
    cell: { ...base, status: "skipped", reason },
    databaseLost: false,
  });

  if (table === undefined || truth === undefined) {
    return skip("The table does not exist in the database any more.");
  }
  if (truth.status === "skipped") {
    return skip(truth.reason);
  }
  if (findRole(built.catalog, persona.dbRole) === undefined) {
    return skip(`The role "${persona.dbRole}" does not exist in the database.`);
  }
  // Nothing to reach and nothing to miss: a "pass" here would be evidence of nothing, and with
  // it a pasted schema without seed data would come out ISOLATED.
  if (truth.rows.length === 0 && expectation.operation !== "insert") {
    return skip(EMPTY_TABLE_REMARK);
  }

  const claimsJson = claimsJsonOf(persona, scenario.mode);
  const facts = personaFacts(persona);
  const membership = await membershipOf(built, persona, facts, truth, table);
  const expected = await expectedKeys(built, input, truth, membership, claimsJson);
  if (expected.status === "skipped") {
    return skip(expected.reason);
  }
  if (expected.status === "failed") {
    return {
      cell: {
        ...base,
        status: "inconclusive",
        reason: expected.failure.message,
        error: expected.failure,
      },
      databaseLost: expected.databaseLost,
    };
  }

  const privileges =
    expectation.operation === "update"
      ? await columnPrivileges(built, persona.dbRole, table)
      : { update: new Set<string>(), select: new Set<string>() };
  const context: CellContext = {
    engine: built.engine,
    executor: input.executor,
    identity: { role: persona.dbRole, claimsJson },
    facts,
    membership,
    expectation,
    table,
    truth,
    expectedKeys: expected.keys,
    policies,
    rlsBypass,
    updatableColumns: privileges.update,
    selectableColumns: privileges.select,
  };
  return OPERATION_CELLS[expectation.operation](context);
}

/** `runCell` never lets an error out: whatever goes wrong is this cell's inconclusive result. */
async function runCellSafely(built: Built, input: CellInput): Promise<CellOutcome> {
  try {
    return await runCell(built, input);
  } catch (error) {
    const failure = toProbeFailure(error);
    return {
      cell: {
        ...cellBase(input.expectation, [], null),
        status: "inconclusive",
        reason: failure.message,
        error: failure,
      },
      databaseLost: isDatabaseLost(error),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------------------------

function matrixPersonas(scenario: Scenario, catalog: Catalog): MatrixPersona[] {
  return scenario.personas.map((persona) => {
    const role = findRole(catalog, persona.dbRole);
    return {
      id: persona.id,
      label: persona.label,
      dbRole: persona.dbRole,
      roleExists: role !== undefined,
      rlsBypass: role === undefined ? null : roleWideBypass(role),
      claimsJson: claimsJsonOf(persona, scenario.mode),
    };
  });
}

function matrixTables(built: Built): MatrixTable[] {
  return built.catalog.tables
    .map((table): MatrixTable => {
      const truth = built.truth.tables.find(
        (entry) => entry.schema === table.schema && entry.name === table.name,
      );
      const snapshot = truth?.status === "ok" ? truth : undefined;
      const config = built.tableConfigs.find(
        (entry) => entry.schema === table.schema && entry.name === table.name,
      );
      return {
        schema: table.schema,
        name: table.name,
        primaryKey: table.primaryKey,
        ownerColumn: config?.ownerColumn ?? null,
        tenantColumn: config?.tenantColumn ?? null,
        rlsEnabled: table.rlsEnabled,
        rlsForced: table.rlsForced,
        rowCount: snapshot?.rows.length ?? null,
        skippedReason: truth?.status === "skipped" ? truth.reason : null,
      };
    })
    .sort((a, b) => compareText(a.schema, b.schema) || compareText(a.name, b.name));
}

function toResult(scenario: Scenario, built: Built, cells: readonly CellResult[]): MatrixResult {
  const counts = countStatuses(cells);
  return {
    version: MATRIX_RESULT_VERSION,
    scenarioId: scenario.id,
    mode: scenario.mode,
    verdict: verdictOf(counts),
    counts,
    totalCells: cells.length,
    missingSchemas: built.catalog.missingSchemas,
    personas: matrixPersonas(scenario, built.catalog),
    tables: matrixTables(built),
    cells,
    orphanExpectations: findOrphanExpectations(scenario, built.catalog.tables),
  };
}

/**
 * Runs the whole matrix for `scenario`, which must have passed `parseScenario`.
 *
 * @throws SetupError when the scenario's SQL fails, `EngineError` when the database is lost
 *   during setup, `MatrixAbortedError` when `signal` aborts.
 */
export async function runMatrix(scenario: Scenario, options: RunMatrixOptions): Promise<MatrixRun> {
  const now = options.now ?? Date.now;
  const executor = options.executor ?? executeAsPersona;
  const startedAt = now();
  let built = await build(scenario, options);
  const setupMs = now() - startedAt;
  try {
    const personas = new Map(scenario.personas.map((persona) => [persona.id, persona]));
    const expectations = resolveExpectations(scenario, built.tableConfigs);
    const cells: CellResult[] = [];
    const cellTimings: { id: string; ms: number }[] = [];
    let rebuilds = 0;

    for (const expectation of expectations) {
      if (options.signal?.aborted === true) {
        throw new MatrixAbortedError();
      }
      const persona = personas.get(expectation.personaId);
      if (persona === undefined) {
        continue;
      }
      const cellStartedAt = now();
      const outcome = await runCellSafely(built, { scenario, persona, expectation, executor });
      cells.push(outcome.cell);
      cellTimings.push({ id: cellId(expectation), ms: now() - cellStartedAt });
      options.onProgress?.({ done: cells.length, total: expectations.length, cell: outcome.cell });
      if (outcome.databaseLost || built.engine.exhausted()) {
        await closeQuietly(built.engine);
        built = await build(scenario, options);
        rebuilds += 1;
      }
    }

    return {
      result: toResult(scenario, built, cells),
      catalog: built.catalog,
      tableConfigs: built.tableConfigs,
      timings: { totalMs: now() - startedAt, setupMs, rebuilds, cells: cellTimings },
    };
  } finally {
    await closeQuietly(built.engine);
  }
}
