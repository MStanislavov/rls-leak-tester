/**
 * One matrix cell: persona x table x operation (brief 3.5). Each function here measures one
 * operation through the probe executor and hands the evidence to the classifier. Nothing in this
 * file decides a status by itself.
 *
 * Every probe and sub-probe gets its own transaction (begin, role, claims, probe, rollback).
 *
 * REACH is measured in up to three steps, because one statement cannot tell the whole truth:
 *
 * 1. The visible shape (`select pk`, `update ... set col = col returning pk`, `delete ...
 *    returning pk`). It reads columns, so it needs SELECT rights and runs under the SELECT
 *    policies as well.
 * 2. When that statement raises for a reason that ONE ROW can cause (`new row violates row-level
 *    security policy`, a foreign key, a trigger), reach is measured again row by row inside
 *    savepoints, so it is still exact. A row that fails with 42501 is blocked; a row that fails
 *    with anything else makes the cell inconclusive. A missing privilege is about the statement,
 *    fails identically for every row, and is not repeated per row (`isStatementDenial`). For UPDATE, a row outside the
 *    expected keys that the no-op could not touch is then tried with the takeover (`pullMoves`):
 *    `using (same tenant) with check (own)` refuses the no-op on a colleague's row and allows
 *    `set user_id = <me>` on it.
 * 3. The blind shape, UPDATE and DELETE only: no WHERE, no RETURNING, no column read, so no SELECT
 *    right is needed and no SELECT policy applies. What it touched is read as the superuser
 *    before and after it. It is skipped when the visible shape already reached every row.
 *    SELECT has a count instead, for a role that may read some columns but not the key.
 *
 * A lost database (timeout, terminated worker, worn-out session) ends the cell at once as
 * inconclusive and is reported upwards, because the next probe needs a rebuilt database.
 */
import type { ResolvedExpectation } from "@/lib/scenario";
import {
  classifyCell,
  classifyInsertCell,
  classifySubProbe,
  diffKeys,
  isBlocked,
  isDataException,
  isRowSecurityViolation,
  isStatementDenial,
  outcomeOfFailure,
  sortKeys,
} from "./classify";
import type { PersonaRun, PersonaSession, ProbeExecutor } from "./executor";
import { keyOfRow, type GroundTruthSnapshot } from "./ground-truth";
import type { CatalogTable } from "./introspect";
import {
  blindUpdateColumns,
  chooseUpdateColumn,
  cloneColumns,
  planEscape,
  planFreshKey,
  planInsertClasses,
  planTenantEscape,
  pullMoves,
  type EscapeInput,
  type EscapePlan,
  type FreshKeyPlan,
  type InsertClassPlan,
  type PersonaFacts,
  type Planned,
  type ScopeMembership,
} from "./plan";
import {
  deleteBlindProbe,
  deleteReachProbe,
  deleteRowProbe,
  escapeBulkProbe,
  escapeTargetedProbe,
  insertCloneProbe,
  pullBlindProbe,
  pullRowProbe,
  rowVersionsProbe,
  rowsWithValueProbe,
  selectCountProbe,
  selectReachProbe,
  sourceCopyProbe,
  sourceGrantProbe,
  updateBlindProbe,
  updateReachProbe,
  updateRowProbe,
  type Probe,
  type ProbeIdentity,
} from "./probes";
import type {
  CellPolicy,
  CellResult,
  ProbeFailure,
  RlsBypass,
  SubProbeKind,
  SubProbeResult,
} from "./result";
import type { SqlEngine, SqlQueryResult } from "./types";

/** Why the reach cells of a table without seeded rows are skipped: nothing can be measured. */
export const EMPTY_TABLE_REMARK =
  "The table has no seeded rows, so there is nothing a probe could reach or miss. Seed rows to prove something.";

/**
 * What the probes of a cell are planned from, without the database. The matrix runner returns one
 * per probed cell (`MatrixRun.cellContexts`), so that the CI export plans the same probes from the
 * same facts instead of deriving them a second time.
 */
export interface CellPlanContext {
  readonly identity: ProbeIdentity;
  readonly facts: PersonaFacts;
  /** The rows that are the persona's own and its tenant's, decided by Postgres. */
  readonly membership: ScopeMembership;
  readonly expectation: ResolvedExpectation;
  readonly table: CatalogTable;
  readonly truth: GroundTruthSnapshot;
  readonly expectedKeys: readonly string[];
  readonly policies: readonly CellPolicy[];
  readonly rlsBypass: RlsBypass | null;
  /** Columns the role holds UPDATE on (update cells only). */
  readonly updatableColumns: ReadonlySet<string>;
  /** Columns the role holds SELECT on (update cells only). */
  readonly selectableColumns: ReadonlySet<string>;
}

/** Everything a cell needs; assembled by the matrix runner. */
export interface CellContext extends CellPlanContext {
  readonly engine: SqlEngine;
  readonly executor: ProbeExecutor;
}

export interface CellOutcome {
  readonly cell: CellResult;
  /** The database was lost while this cell ran: rebuild it before the next one. */
  readonly databaseLost: boolean;
}

export function cellId(expectation: ResolvedExpectation): string {
  return `${expectation.personaId}|${expectation.schema}.${expectation.table}|${expectation.operation}`;
}

/** The fields every cell has, whatever happened. */
export function cellBase(
  expectation: ResolvedExpectation,
  policies: readonly CellPolicy[],
  rlsBypass: RlsBypass | null,
): Omit<CellResult, "status" | "reason"> {
  return {
    id: cellId(expectation),
    personaId: expectation.personaId,
    schema: expectation.schema,
    table: expectation.table,
    operation: expectation.operation,
    scope: expectation.scope,
    expectationSource: expectation.source,
    expectedKeys: [],
    actualKeys: [],
    blindKeys: [],
    leakedKeys: [],
    missingKeys: [],
    statement: "",
    sql: "",
    perRowFallback: false,
    error: null,
    subProbes: [],
    policies,
    rlsBypass,
  };
}

const keysOf = (result: SqlQueryResult, truth: GroundTruthSnapshot): string[] =>
  sortKeys(result.rows.map((row) => keyOfRow(row, truth.primaryKey.length)));

// ---------------------------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------------------------

interface Reach {
  readonly statement: string;
  readonly actualKeys: string[];
  /** Keys that only the blind shape reached. */
  readonly blindKeys: string[];
  readonly sql: string;
  readonly perRowFallback: boolean;
  readonly error: ProbeFailure | null;
  /** A statement failed for a reason that is not authorization. */
  readonly inconclusive: boolean;
  /** Why the cell is inconclusive when no failed statement says it. */
  readonly remark: string | null;
  readonly databaseLost: boolean;
}

interface ReachProbes {
  readonly bulk: Probe;
  /** The same statement for one row; absent for SELECT, which cannot raise per row. */
  readonly perRow?: (key: string) => Probe;
  /** UPDATE only: the takeover variants for one row, see `pullMoves`. */
  readonly pulls?: (key: string) => readonly Probe[];
}

interface RowByRow {
  readonly keys: string[];
  readonly failure: ProbeFailure | null;
}

/** The takeover of one row: the first variant that goes through wins. */
async function pullRow(
  session: PersonaSession,
  truth: GroundTruthSnapshot,
  pulls: readonly Probe[],
): Promise<RowByRow> {
  let failure: ProbeFailure | null = null;
  for (const pull of pulls) {
    const attempt = await session.attempt(pull);
    if (attempt.ok && attempt.result.rows.length > 0) {
      return { keys: keysOf(attempt.result, truth), failure: null };
    }
    // A claim that does not fit the column's type (22xxx) cannot take a row over: not a finding.
    if (!attempt.ok && !isBlocked(attempt.failure) && !isDataException(attempt.failure)) {
      failure ??= attempt.failure;
    }
  }
  return { keys: [], failure };
}

async function perRowReach(
  context: CellContext,
  probes: ReachProbes & { readonly perRow: (key: string) => Probe },
): Promise<PersonaRun<RowByRow>> {
  const { truth } = context;
  const expected = new Set(context.expectedKeys);
  return context.executor(context.engine, context.identity, async (session) => {
    const keys: string[] = [];
    let failure: ProbeFailure | null = null;
    for (const row of truth.rows) {
      const attempt = await session.attempt(probes.perRow(row.key));
      if (attempt.ok) {
        keys.push(...keysOf(attempt.result, truth));
      } else if (!isBlocked(attempt.failure)) {
        failure ??= attempt.failure;
      } else if (isRowSecurityViolation(attempt.failure) && !expected.has(row.key)) {
        // USING let the persona at the row, WITH CHECK refused the unchanged row.
        const pulled = await pullRow(session, truth, probes.pulls?.(row.key) ?? []);
        keys.push(...pulled.keys);
        failure ??= pulled.failure;
      }
    }
    return { keys: sortKeys(keys), failure };
  });
}

async function measureVisibleReach(context: CellContext, probes: ReachProbes): Promise<Reach> {
  const { truth } = context;
  const { perRow } = probes;
  const bulk = await context.executor(context.engine, context.identity, async (session) =>
    keysOf(await session.run(probes.bulk), truth),
  );
  const measured = {
    statement: probes.bulk.inlined,
    blindKeys: [],
    sql: bulk.sql,
    perRowFallback: false,
    remark: null,
  };
  if (bulk.ok) {
    return {
      ...measured,
      actualKeys: bulk.value,
      error: null,
      inconclusive: false,
      databaseLost: false,
    };
  }
  const failed = {
    ...measured,
    actualKeys: [],
    error: bulk.failure,
    inconclusive: !isBlocked(bulk.failure),
    databaseLost: bulk.databaseLost,
  };
  // No SQLSTATE: the engine or the identity check failed. A missing privilege is about the
  // statement, not about a row. Row by row would fail the same way, every time.
  const aboutTheStatement = bulk.failure.sqlState === null || isStatementDenial(bulk.failure);
  if (perRow === undefined || aboutTheStatement) {
    return failed;
  }
  const rows = await perRowReach(context, { ...probes, perRow });
  const sql = `${bulk.sql}\n\n-- The statement raised ${bulk.failure.sqlState}: reach measured row by row.\n${rows.sql}`;
  if (!rows.ok) {
    return {
      ...failed,
      sql,
      perRowFallback: true,
      error: rows.failure,
      inconclusive: true,
      databaseLost: rows.databaseLost,
    };
  }
  return {
    ...measured,
    actualKeys: rows.value.keys,
    sql,
    perRowFallback: true,
    error: rows.value.failure ?? bulk.failure,
    inconclusive: rows.value.failure !== null,
    databaseLost: false,
  };
}

/** What a blind statement did: the keys it touched, or that it was refused, or that it failed. */
type Blind =
  | { readonly status: "touched"; readonly keys: readonly string[] }
  | { readonly status: "refused" }
  | { readonly status: "failed"; readonly failure: ProbeFailure };

const canGoBlind = (context: CellContext, visible: Reach): boolean =>
  !visible.databaseLost &&
  visible.error?.sqlState !== null &&
  visible.actualKeys.length < context.truth.rows.length;

/** Adds what the blind shape reached to what the visible shape reached. */
function withBlind(visible: Reach, run: PersonaRun<Blind>, note: string): Reach {
  const sql = `${visible.sql}\n\n-- ${note}\n${run.sql}`;
  const blind: Blind = run.ok ? run.value : { status: "failed", failure: run.failure };
  if (blind.status === "touched") {
    const seen = new Set(visible.actualKeys);
    return {
      ...visible,
      sql,
      actualKeys: sortKeys([...visible.actualKeys, ...blind.keys]),
      blindKeys: sortKeys(blind.keys.filter((key) => !seen.has(key))),
    };
  }
  if (blind.status === "refused" || isBlocked(blind.failure)) {
    return { ...visible, sql };
  }
  return {
    ...visible,
    sql,
    error: visible.inconclusive ? visible.error : blind.failure,
    inconclusive: true,
    databaseLost: !run.ok && run.databaseLost,
  };
}

function reachCell(
  context: CellContext,
  reach: Reach,
  subProbes: readonly SubProbeResult[],
): CellResult {
  const diff = diffKeys(context.expectedKeys, reach.actualKeys);
  const status = classifyCell({ ...diff, inconclusive: reach.inconclusive, subProbes });
  let reason: string | null = null;
  if (status === "inconclusive") {
    const failure = reach.inconclusive
      ? reach.error
      : subProbes.find((probe) => probe.status === "inconclusive")?.error;
    reason = reach.remark ?? failure?.message ?? null;
  }
  return {
    ...cellBase(context.expectation, context.policies, context.rlsBypass),
    status,
    reason,
    expectedKeys: sortKeys(context.expectedKeys),
    actualKeys: reach.actualKeys,
    blindKeys: reach.blindKeys,
    ...diff,
    statement: reach.statement,
    sql: reach.sql,
    perRowFallback: reach.perRowFallback,
    error: reach.error,
    subProbes,
  };
}

// ---------------------------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------------------------

/**
 * The key could not be selected (42501). That is a real block only when the role can read
 * nothing: with a column-level grant that leaves the key out, `select email from t` still reads
 * every row. `count(*)` needs SELECT on any one column, so it tells how many rows are visible:
 * none and all identify the rows; anything between cannot be told without the key.
 */
async function countVisibleRows(context: CellContext, visible: Reach): Promise<Reach> {
  const { truth } = context;
  const run = await context.executor(context.engine, context.identity, async (session) => {
    const { rows } = await session.run(selectCountProbe(truth));
    return Number(rows[0]?.visible_rows);
  });
  const sql = `${visible.sql}\n\n-- The key is not selectable. Can the role read the rows through another column?\n${run.sql}`;
  if (!run.ok) {
    return isBlocked(run.failure)
      ? { ...visible, sql }
      : { ...visible, sql, error: run.failure, inconclusive: true, databaseLost: run.databaseLost };
  }
  if (run.value === 0) {
    return { ...visible, sql };
  }
  if (run.value === truth.rows.length) {
    return { ...visible, sql, actualKeys: truth.rows.map((row) => row.key) };
  }
  return {
    ...visible,
    sql,
    inconclusive: true,
    remark: `The role can read ${run.value} of ${truth.rows.length} rows, but it holds no SELECT privilege on the primary key, so which rows they are cannot be told. Grant SELECT on the key columns to measure this cell.`,
  };
}

export async function selectCell(context: CellContext): Promise<CellOutcome> {
  const visible = await measureVisibleReach(context, { bulk: selectReachProbe(context.truth) });
  const keyDenied = visible.error !== null && isBlocked(visible.error) && !visible.databaseLost;
  const reach = keyDenied ? await countVisibleRows(context, visible) : visible;
  return { cell: reachCell(context, reach, []), databaseLost: reach.databaseLost };
}

// ---------------------------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------------------------

export async function deleteCell(context: CellContext): Promise<CellOutcome> {
  const { truth } = context;
  const visible = await measureVisibleReach(context, {
    bulk: deleteReachProbe(truth),
    perRow: (key) => deleteRowProbe(truth, key),
  });
  if (!canGoBlind(context, visible)) {
    return { cell: reachCell(context, visible, []), databaseLost: visible.databaseLost };
  }
  const run = await context.executor(
    context.engine,
    context.identity,
    async (session): Promise<Blind> => {
      const before = keysOf(await session.asSuperuser(selectReachProbe(truth)), truth);
      await session.run(deleteBlindProbe(truth));
      const after = new Set(keysOf(await session.asSuperuser(selectReachProbe(truth)), truth));
      return { status: "touched", keys: before.filter((key) => !after.has(key)) };
    },
  );
  const reach = withBlind(
    visible,
    run,
    "The same without WHERE and RETURNING: no SELECT policy applies to it.",
  );
  return { cell: reachCell(context, reach, []), databaseLost: reach.databaseLost };
}

// ---------------------------------------------------------------------------------------------
// Sub-probes
// ---------------------------------------------------------------------------------------------

interface SubProbeSpec {
  readonly kind: SubProbeKind;
  readonly expected: SubProbeResult["expected"];
  readonly sourceKey: string | null;
}

function skippedSubProbe(spec: SubProbeSpec, reason: string): SubProbeResult {
  return {
    ...spec,
    outcome: "skipped",
    status: "skipped",
    reason,
    movedKeys: [],
    statement: "",
    sql: "",
    error: null,
  };
}

/** `measured` tells what a statement that did not raise has done. */
interface Measured {
  readonly allowed: boolean;
  readonly movedKeys: readonly string[];
  /** Why a statement that did not raise still counts as blocked. */
  readonly remark: string | null;
}

interface RanSubProbe {
  readonly result: SubProbeResult;
  readonly databaseLost: boolean;
}

async function runSubProbe(
  context: CellContext,
  spec: SubProbeSpec,
  probe: Probe,
  work: (session: PersonaSession, probe: Probe) => Promise<Measured>,
): Promise<RanSubProbe> {
  const run = await context.executor(context.engine, context.identity, (session) =>
    work(session, probe),
  );
  if (!run.ok) {
    return {
      result: failedSubProbe(spec, run.failure, probe.inlined, run.sql),
      databaseLost: run.databaseLost,
    };
  }
  const outcome = run.value.allowed ? "allowed" : "blocked";
  return {
    result: {
      ...spec,
      outcome,
      status: classifySubProbe(spec.expected, outcome),
      reason: run.value.remark,
      movedKeys: run.value.movedKeys,
      statement: probe.inlined,
      sql: run.sql,
      error: null,
    },
    databaseLost: false,
  };
}

// ---------------------------------------------------------------------------------------------
// UPDATE: reach (visible, row by row with takeover, blind) plus the scope-escape shapes
// ---------------------------------------------------------------------------------------------

/** The seeded rows that carry the foreign value already: the bulk escape did not move those. */
export function rowsCarrying(truth: GroundTruthSnapshot, move: EscapePlan["move"]): string[] {
  return truth.rows
    .filter((row) => (move.column === truth.tenantColumn ? row.tenant : row.owner) === move.value)
    .map((row) => row.key);
}

/** One escape plan runs as two sub-probes (ADR 0002 claim 6), or is skipped as two. */
async function escapePair(context: CellContext, plan: Planned<EscapePlan>): Promise<RanSubProbe[]> {
  const { truth } = context;
  if (plan.status === "skipped") {
    return (["escape-targeted", "escape-bulk"] as const).map((kind) => ({
      result: skippedSubProbe({ kind, expected: "blocked", sourceKey: null }, plan.reason),
      databaseLost: false,
    }));
  }
  const { sourceKey, move } = plan;
  const before = new Set(rowsCarrying(truth, move));

  const targeted = await runSubProbe(
    context,
    { kind: "escape-targeted", expected: "blocked", sourceKey },
    escapeTargetedProbe(truth, move, sourceKey),
    async (session, probe) => {
      const moved = keysOf(await session.run(probe), truth);
      return {
        allowed: moved.length > 0,
        movedKeys: moved,
        remark: moved.length > 0 ? null : "The statement raised no error and updated no row.",
      };
    },
  );
  if (targeted.databaseLost) {
    return [targeted];
  }
  const bulk = await runSubProbe(
    context,
    { kind: "escape-bulk", expected: "blocked", sourceKey },
    escapeBulkProbe(truth, move),
    async (session, probe) => {
      await session.run(probe);
      const after = await session.asSuperuser(rowsWithValueProbe(truth, move.column, move.value));
      const moved = keysOf(after, truth).filter((key) => !before.has(key));
      return {
        allowed: moved.length > 0,
        movedKeys: moved,
        remark: moved.length > 0 ? null : "The statement raised no error and moved no row.",
      };
    },
  );
  return [targeted, bulk];
}

/**
 * The escape plans of an UPDATE cell, in the order they run: the move of the column that defines
 * the scope, then (scope `own` only) the move of the tenant column. `reachableKeys` are the rows
 * the reach probe really reached.
 */
export function planEscapes(
  context: CellPlanContext,
  reachableKeys: readonly string[],
): Planned<EscapePlan>[] {
  const input: EscapeInput = {
    scope: context.expectation.scope,
    table: context.table,
    truth: context.truth,
    expectedKeys: context.expectedKeys,
    reachableKeys,
  };
  const tenantMove = planTenantEscape(input, context.facts, context.membership.tenant);
  return tenantMove === null ? [planEscape(input)] : [planEscape(input), tenantMove];
}

async function escapeSubProbes(context: CellContext, reach: Reach): Promise<RanSubProbe[]> {
  const ran: RanSubProbe[] = [];
  for (const plan of planEscapes(context, reach.actualKeys)) {
    if (!ran.some((probe) => probe.databaseLost)) {
      ran.push(...(await escapePair(context, plan)));
    }
  }
  return ran;
}

/** Rows whose physical version differs, or that are gone: what a blind UPDATE touched. */
function touchedKeys(
  truth: GroundTruthSnapshot,
  before: SqlQueryResult,
  after: SqlQueryResult | null,
): string[] {
  const versions = new Map(
    (after?.rows ?? []).map((row) => [keyOfRow(row, truth.primaryKey.length), row.row_version]),
  );
  return before.rows
    .filter((row) => versions.get(keyOfRow(row, truth.primaryKey.length)) !== row.row_version)
    .map((row) => keyOfRow(row, truth.primaryKey.length));
}

/**
 * The blind UPDATE. Candidates, each in a savepoint: `set col = <the source row's value>` for up
 * to `BLIND_UPDATE_CANDIDATES` columns (the next one only after a constraint error), then the
 * takeover variants. The first statement that goes through is the measurement. With none, a
 * 42501 among the answers means refused; only constraint errors means nothing was measured.
 */
/** The statements of the blind UPDATE: the source row, the constants, then the takeovers. */
export interface BlindUpdatePlan {
  /** The seeded row whose values the constants are read from. */
  readonly sourceKey: string;
  readonly constants: readonly Probe[];
  readonly pulls: readonly Probe[];
}

/**
 * `null`: the role holds UPDATE on no writable column, or the table has no row to read from.
 *
 * `alsoUngranted` (the CI export): columns the role holds no UPDATE on are planned as well, after
 * the granted ones, so the exported check measures a grant that a later migration adds. Then
 * `null` means: no writable column at all, or no row.
 */
export function planBlindUpdate(
  context: Pick<CellPlanContext, "table" | "truth" | "facts" | "updatableColumns">,
  alsoUngranted = false,
): BlindUpdatePlan | null {
  const { truth, table } = context;
  const scopeColumns = new Set([truth.ownerColumn, truth.tenantColumn]);
  const constants = blindUpdateColumns(
    table,
    context.updatableColumns,
    scopeColumns,
    alsoUngranted,
  ).map((column) => updateBlindProbe(truth, column));
  const pulls = pullMoves(table, truth, context.facts).map((moves) => pullBlindProbe(truth, moves));
  const source = truth.rows[0];
  return constants.length === 0 || source === undefined
    ? null
    : { sourceKey: source.key, constants, pulls };
}

async function blindUpdate(context: CellContext, visible: Reach): Promise<Reach> {
  const { truth } = context;
  const plan = planBlindUpdate(context);
  if (plan === null || !canGoBlind(context, visible)) {
    return visible;
  }
  const { constants, pulls } = plan;
  const versions = rowVersionsProbe(truth);
  const run = await context.executor(
    context.engine,
    context.identity,
    async (session): Promise<Blind> => {
      const before = await session.asSuperuser(
        sourceCopyProbe(truth, plan.sourceKey),
        sourceGrantProbe(context.identity.role),
        versions,
      );
      let refused = false;
      let failure: ProbeFailure | null = null;
      for (const candidate of [...constants, ...pulls]) {
        // A constant that WITH CHECK refused: another constant would fare the same.
        if (refused && constants.includes(candidate)) {
          continue;
        }
        const attempt = await session.attempt(candidate, versions);
        if (attempt.ok) {
          return { status: "touched", keys: touchedKeys(truth, before, attempt.readBack) };
        }
        if (isBlocked(attempt.failure)) {
          refused = true;
        } else if (!isDataException(attempt.failure) || constants.includes(candidate)) {
          failure ??= attempt.failure;
        }
      }
      return refused || failure === null ? { status: "refused" } : { status: "failed", failure };
    },
  );
  return withBlind(
    visible,
    run,
    "Without WHERE and RETURNING, and with a value that does not read the table: no SELECT policy applies to it.",
  );
}

/** The column of the no-op UPDATE (`set col = col`); `null` when no column can be written. */
export function updateReachColumn(
  context: Pick<CellPlanContext, "table" | "truth" | "updatableColumns" | "selectableColumns">,
): string | null {
  const { truth, table } = context;
  const scopeColumns = new Set([truth.ownerColumn, truth.tenantColumn]);
  const readable = new Set(
    [...context.updatableColumns].filter((column) => context.selectableColumns.has(column)),
  );
  // `set col = col` reads the column: it needs SELECT too. Without such a column any granted
  // one is named, so that the 42501 is observed; the blind shape then measures the rows.
  return chooseUpdateColumn(
    table,
    readable.size > 0 ? readable : context.updatableColumns,
    scopeColumns,
  );
}

/** Why an UPDATE cell is skipped when `updateReachColumn` finds no column. */
export const NO_WRITABLE_COLUMN_REMARK =
  "Every column of the table is generated, so no UPDATE can be written.";

export async function updateCell(context: CellContext): Promise<CellOutcome> {
  const { truth, table } = context;
  const column = updateReachColumn(context);
  if (column === null) {
    return {
      cell: {
        ...cellBase(context.expectation, context.policies, context.rlsBypass),
        status: "skipped",
        reason: NO_WRITABLE_COLUMN_REMARK,
      },
      databaseLost: false,
    };
  }
  const pulls = pullMoves(table, truth, context.facts);
  const visible = await measureVisibleReach(context, {
    bulk: updateReachProbe(truth, column),
    perRow: (key) => updateRowProbe(truth, column, key),
    pulls: (key) => pulls.map((moves) => pullRowProbe(truth, moves, key)),
  });
  const reach = await blindUpdate(context, visible);
  if (reach.databaseLost) {
    return { cell: reachCell(context, reach, []), databaseLost: true };
  }
  const escapes = await escapeSubProbes(context, reach);
  return {
    cell: reachCell(
      context,
      reach,
      escapes.map((escape) => escape.result),
    ),
    databaseLost: escapes.some((escape) => escape.databaseLost),
  };
}

// ---------------------------------------------------------------------------------------------
// INSERT: one clone per scope class and side
// ---------------------------------------------------------------------------------------------

function failedSubProbe(
  spec: SubProbeSpec,
  failure: ProbeFailure,
  statement: string,
  sql: string,
): SubProbeResult {
  const outcome = outcomeOfFailure(failure);
  return {
    ...spec,
    outcome,
    status: classifySubProbe(spec.expected, outcome),
    reason: null,
    movedKeys: [],
    statement,
    sql,
    error: failure,
  };
}

/** The insert of a clone of the source row under `freshKey`; the same statement for every class. */
export function insertProbeOf(
  context: Pick<CellPlanContext, "table" | "truth">,
  freshKey: FreshKeyPlan,
): Probe {
  const columns = cloneColumns(context.table, freshKey).map((column) => column.name);
  return insertCloneProbe(context.truth, columns, freshKey.value);
}

function insertSubProbe(
  context: CellContext,
  plan: InsertClassPlan,
  freshKey: FreshKeyPlan,
): Promise<RanSubProbe> {
  const insert = insertProbeOf(context, freshKey);
  return runSubProbe(context, plan, insert, async (session, probe) => {
    // The superuser lays the seeded row out for the persona; the persona inserts its clone.
    await session.asSuperuser(
      sourceCopyProbe(context.truth, plan.sourceKey),
      sourceGrantProbe(context.identity.role),
    );
    const { affectedRows } = await session.run(probe);
    return {
      allowed: affectedRows > 0,
      movedKeys: [],
      remark:
        affectedRows > 0
          ? null
          : "The statement raised no error and inserted no row (a trigger or a rule discarded it).",
    };
  });
}

/** Why an INSERT cell is skipped when the ground truth holds no row to clone. */
export const NO_ROW_TO_CLONE_REMARK = "The table has no seeded row to clone.";

export async function insertCell(context: CellContext): Promise<CellOutcome> {
  const base = cellBase(context.expectation, context.policies, context.rlsBypass);
  const plans = planInsertClasses(
    context.expectation.scope,
    context.truth,
    context.facts,
    context.membership,
    context.expectedKeys,
  );
  if (plans.length === 0) {
    return {
      cell: { ...base, status: "skipped", reason: NO_ROW_TO_CLONE_REMARK },
      databaseLost: false,
    };
  }
  const freshKey = planFreshKey(context.table, context.truth);
  const subProbes: SubProbeResult[] = [];
  let databaseLost = false;
  for (const plan of plans) {
    if (freshKey.status === "skipped") {
      subProbes.push(skippedSubProbe(plan, freshKey.reason));
    } else if (!databaseLost) {
      const ran = await insertSubProbe(context, plan, freshKey);
      subProbes.push(ran.result);
      databaseLost = ran.databaseLost;
    }
  }
  const status = classifyInsertCell(subProbes);
  const first = (wanted: SubProbeResult["status"]): SubProbeResult | undefined =>
    subProbes.find((probe) => probe.status === wanted);
  let reason: string | null = null;
  if (status === "skipped") {
    reason = first("skipped")?.reason ?? null;
  } else if (status === "inconclusive") {
    reason = first("inconclusive")?.error?.message ?? null;
  }
  return {
    cell: { ...base, status, reason, error: first("inconclusive")?.error ?? null, subProbes },
    databaseLost,
  };
}
