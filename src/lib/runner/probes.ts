/**
 * Probe builders (brief 3.5, 3.8). Pure functions that return the exact SQL of every statement the
 * runner sends, so that a cell can record what ran and the CI export can inline the very same
 * statements into its `DO` blocks. Runner and export cannot drift: both call these.
 *
 * A `Probe` carries two spellings of one statement:
 *
 * - `sql` + `params`: what the runner executes. Every parameter is text (`$1::text`); where a
 *   column type matters the builder adds the cast (`$1::text::integer`), so no adapter ever has
 *   to guess how to serialise a value.
 * - `inlined`: the same statement with the values as literals (`'7'::integer`), for display, for
 *   reproduction in psql and for the export. A text literal and a `::text` parameter go through
 *   the same input function, so both spellings mean the same.
 *
 * Nothing is interpolated by hand: identifiers go through `quoteIdent` / `qualifiedName`, values
 * through `quoteLiteral`, and column types come from the catalog (`format_type`), never from the
 * scenario.
 *
 * Row keys are compared as text everywhere (`"id"::text = $1::text`), the same spelling the
 * ground truth uses, so a key that was read can always be addressed again.
 */
import { z } from "zod";
import { qualifiedName, quoteIdent, quoteLiteral } from "@/lib/scenario";
import { primaryKeySelectList } from "./ground-truth";

export interface Probe {
  /**
   * The statement with `$n` parameters. The builders of this module always write `$n::text`; only
   * `expectedRowsProbe` leaves `:sub` untyped, so that Postgres infers it from the user's query.
   */
  readonly sql: string;
  readonly params: readonly (string | null)[];
  /** The statement with every parameter inlined as a literal. */
  readonly inlined: string;
}

/** The table a probe addresses. `CatalogTable` and `GroundTruthSnapshot` both fit. */
export interface ProbeTable {
  readonly schema: string;
  readonly name: string;
  readonly primaryKey: readonly string[];
}

/** A value for one column, as text, with the column's catalog type for the cast. */
export interface ColumnValue {
  readonly column: string;
  /** `format_type` of the column: `integer`, `uuid`, `character varying(40)`. */
  readonly type: string;
  readonly value: string | null;
}

/** The identity a probe runs under. `claimsJson` is the exact `request.jwt.claims` text. */
export interface ProbeIdentity {
  readonly role: string;
  readonly claimsJson: string;
}

interface ProbeParam {
  readonly value: string | null;
}

type Part = string | ProbeParam;

const param = (value: string | null): ProbeParam => ({ value });

/** Assembles a statement from SQL text and values; the only place where `$n` is numbered. */
function build(parts: readonly Part[]): Probe {
  let sql = "";
  let inlined = "";
  const params: (string | null)[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      sql += part;
      inlined += part;
    } else {
      params.push(part.value);
      sql += `$${params.length}::text`;
      inlined += part.value === null ? "null" : quoteLiteral(part.value);
    }
  }
  return { sql, params, inlined };
}

/** A statement without parameters. */
export function staticProbe(sql: string): Probe {
  return { sql, params: [], inlined: sql };
}

const keySchema = z.array(z.string()).min(1);

/** The serialised key (`["7","b"]`) back to its column values; throws on anything else. */
export function parseKey(key: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(key);
  } catch {
    json = undefined;
  }
  const parsed = keySchema.safeParse(json);
  if (!parsed.success) {
    throw new TypeError(`Not a serialised primary key: ${key}`);
  }
  return parsed.data;
}

function keyMatch(table: ProbeTable, key: string): Part[] {
  const values = parseKey(key);
  if (values.length !== table.primaryKey.length) {
    throw new RangeError(
      `The key ${key} has ${values.length} values, the primary key has ${table.primaryKey.length} columns`,
    );
  }
  const parts: Part[] = [];
  table.primaryKey.forEach((column, index) => {
    parts.push(
      `${index === 0 ? "" : " and "}${quoteIdent(column)}::text = `,
      param(values[index] ?? null),
    );
  });
  return parts;
}

const target = (table: ProbeTable): string => qualifiedName(table.schema, table.name);
const returning = (table: ProbeTable): string =>
  ` returning ${primaryKeySelectList(table.primaryKey)}`;

// ---------------------------------------------------------------------------------------------
// Identity: the statements that put a transaction under the persona (RUN-001).
// ---------------------------------------------------------------------------------------------

export const CLAIMS_SETTING = "request.jwt.claims";

/**
 * Settings a probe must not inherit from the session, all transaction-local like the rest:
 *
 * - `request.jwt.claim.sub|role|email` and `request.jwt.claim`: the legacy per-claim settings.
 *   Supabase's `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()` read them BEFORE
 *   `request.jwt.claims`, so a seed that "signed in" through them would lend its user to every
 *   persona. Current PostgREST does not set them; they are emptied, which those functions skip.
 * - `row_security`: every pg_dump file starts with `SET row_security = off`, under which a
 *   statement that a policy would filter raises 42501 instead of running.
 * - `TimeZone`: the text of a timestamptz ends up in keys and in recorded SQL.
 */
const PINNED_SETTINGS: readonly (readonly [string, string])[] = [
  ["request.jwt.claim.sub", ""],
  ["request.jwt.claim.role", ""],
  ["request.jwt.claim.email", ""],
  ["request.jwt.claim", ""],
  ["row_security", "on"],
  ["TimeZone", "UTC"],
];

const PIN_SETTINGS_CALLS = PINNED_SETTINGS.map(
  ([name, value]) => `set_config(${quoteLiteral(name)}, ${quoteLiteral(value)}, true)`,
).join(", ");

const PIN_SETTINGS_PROBE: Probe = staticProbe(`select ${PIN_SETTINGS_CALLS}`);

/**
 * The role switch, the claims and the pinned settings, all transaction-local. `SET LOCAL ROLE`
 * takes no parameter; `set_config('role', $1, true)` is its parameterised form and raises 22023
 * for a missing role.
 */
export function identityProbes(identity: ProbeIdentity): readonly [Probe, Probe, Probe] {
  return [
    build(["select set_config('role', ", param(identity.role), ", true)"]),
    build([
      `select set_config(${quoteLiteral(CLAIMS_SETTING)}, `,
      param(identity.claimsJson),
      ", true)",
    ]),
    PIN_SETTINGS_PROBE,
  ];
}

/**
 * Who am I? The executor compares `role` with the persona's role before every probe, and refuses
 * to probe unless `row_security` is `on`.
 */
export const WHOAMI_PROBE: Probe = staticProbe(
  "select current_user::text as role, session_user::text as session_role, current_setting('row_security') as row_security",
);

/** Back to the session user (the superuser) inside the probe transaction, for a read-back. */
export const RESET_ROLE_PROBE: Probe = staticProbe("reset role");

// ---------------------------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------------------------

/** SELECT reach: the primary keys the persona can see. */
export function selectReachProbe(table: ProbeTable): Probe {
  return staticProbe(`select ${primaryKeySelectList(table.primaryKey)} from ${target(table)}`);
}

/**
 * SELECT reach without the key: how many rows the persona sees. For a role that may select some
 * columns but not the primary key; `count(*)` needs SELECT on any one column.
 */
export function selectCountProbe(table: ProbeTable): Probe {
  return staticProbe(`select count(*)::text as visible_rows from ${target(table)}`);
}

/** UPDATE reach: a no-op update of `column`; RETURNING tells which rows it touched. */
export function updateReachProbe(table: ProbeTable, column: string): Probe {
  const name = quoteIdent(column);
  return staticProbe(`update ${target(table)} set ${name} = ${name}${returning(table)}`);
}

/** The same no-op update for one row: the per-row fallback when the bulk statement raises. */
export function updateRowProbe(table: ProbeTable, column: string, key: string): Probe {
  const name = quoteIdent(column);
  return build([
    `update ${target(table)} set ${name} = ${name} where `,
    ...keyMatch(table, key),
    returning(table),
  ]);
}

/** DELETE reach, inside the rolled-back transaction. */
export function deleteReachProbe(table: ProbeTable): Probe {
  return staticProbe(`delete from ${target(table)}${returning(table)}`);
}

/**
 * DELETE reach, second shape: no WHERE, no RETURNING. Such a statement needs no SELECT right, so
 * Postgres does not apply the SELECT policies to it: with `for select using (own)` and
 * `for delete using (true)` the RETURNING shape deletes the own rows and this one deletes ALL of
 * them. What it reached is read as the superuser before and after it.
 */
export function deleteBlindProbe(table: ProbeTable): Probe {
  return staticProbe(`delete from ${target(table)}`);
}

// ---------------------------------------------------------------------------------------------
// The source row: a superuser's copy of one seeded row that the persona may read.
//
// The blind UPDATE and the insert clone need the values of a seeded row. Writing them into the
// statement as literals has two defects: a cast such as `'done'::private.status` needs USAGE on
// the type's schema (a 42501 that is not about the table), and a value like `created_at` of a
// `default now()` column differs in every run, which breaks the byte-identical result. So the
// superuser copies the row into a temporary table inside the probe transaction, grants the
// persona's role SELECT on it, and the persona's statement reads the values from there. The text
// of every statement is the same in every run, and no type is named.
// ---------------------------------------------------------------------------------------------

const SOURCE_NAME = "rls_leak_tester_source";
const SOURCE = `pg_temp.${quoteIdent(SOURCE_NAME)}`;

/** As the superuser: copy the seeded row `key` into the temporary source table. */
export function sourceCopyProbe(table: ProbeTable, key: string): Probe {
  return build([
    `create temporary table ${quoteIdent(SOURCE_NAME)} on commit drop as select * from ${target(table)} where `,
    ...keyMatch(table, key),
  ]);
}

/** As the superuser: let the persona's role read the source row. */
export function sourceGrantProbe(role: string): Probe {
  return staticProbe(`grant select on ${SOURCE} to ${quoteIdent(role)}`);
}

/**
 * UPDATE reach, second shape: no WHERE, no RETURNING, and the new value does not read the table,
 * so the statement needs no SELECT right and Postgres applies no SELECT policy to it. With
 * `for update using (true)` and no SELECT policy the no-op shape reaches nothing and this one
 * overwrites every row. Which rows it touched is read as the superuser (`rowVersionsProbe`).
 */
export function updateBlindProbe(table: ProbeTable, column: string): Probe {
  const name = quoteIdent(column);
  return staticProbe(`update ${target(table)} set ${name} = (select ${name} from ${SOURCE})`);
}

/**
 * As the superuser: every key with the physical version of its row. An UPDATE writes a new row
 * version, so a key whose version differs before and after a statement was touched by it, even
 * when every value stayed the same. Never part of a result, and never an identity: rows are
 * identified by their primary key.
 */
export function rowVersionsProbe(table: ProbeTable): Probe {
  return staticProbe(
    `select ${primaryKeySelectList(table.primaryKey)}, tableoid::text || ':' || ctid::text as row_version from ${target(table)}`,
  );
}

export function deleteRowProbe(table: ProbeTable, key: string): Probe {
  return build([`delete from ${target(table)} where `, ...keyMatch(table, key), returning(table)]);
}

// ---------------------------------------------------------------------------------------------
// Scope escape (ADR 0002 claim 6: two shapes, because a targeted UPDATE can look blocked while
// the WHERE-less one moves the rows).
// ---------------------------------------------------------------------------------------------

function assignments(moves: readonly ColumnValue[]): Part[] {
  const parts: Part[] = [];
  moves.forEach((move, index) => {
    parts.push(
      `${index === 0 ? "" : ", "}${quoteIdent(move.column)} = `,
      param(move.value),
      `::${move.type}`,
    );
  });
  return parts;
}

/** Shape 1: move one row, addressed by its key, with RETURNING. */
export function escapeTargetedProbe(table: ProbeTable, move: ColumnValue, key: string): Probe {
  return pullRowProbe(table, [move], key);
}

/** Shape 2: no WHERE, no RETURNING, so no SELECT policy is applied to the new row. */
export function escapeBulkProbe(table: ProbeTable, move: ColumnValue): Probe {
  return pullBlindProbe(table, [move]);
}

/**
 * The takeover ("pull"): the scope escape in the other direction. When USING is wider than WITH
 * CHECK (`using (same tenant) with check (own)`) a no-op update of a foreign row is refused, but
 * the same row can be updated as long as the NEW row passes WITH CHECK: the persona makes the
 * row its own. `moves` set the owner and tenant columns to the persona's own values.
 */
export function pullRowProbe(table: ProbeTable, moves: readonly ColumnValue[], key: string): Probe {
  return build([
    `update ${target(table)} set `,
    ...assignments(moves),
    " where ",
    ...keyMatch(table, key),
    returning(table),
  ]);
}

/** The takeover without WHERE and RETURNING; touched rows are read back with `rowVersionsProbe`. */
export function pullBlindProbe(table: ProbeTable, moves: readonly ColumnValue[]): Probe {
  return build([`update ${target(table)} set `, ...assignments(moves)]);
}

/** Read-back for shape 2, as the superuser: which rows carry the foreign value now? */
export function rowsWithValueProbe(table: ProbeTable, column: string, value: string): Probe {
  return build([
    `select ${primaryKeySelectList(table.primaryKey)} from ${target(table)} where ${quoteIdent(column)}::text = `,
    param(value),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------------------------

/**
 * Inserts a clone of the source row (`sourceCopyProbe`). `columns` are taken from it as they are;
 * `freshKey` replaces one key column with a literal, a key column that is in neither takes its
 * default. No RETURNING: it would put the new row under the SELECT policies as well and report an
 * insert as blocked that a client can perform.
 */
export function insertCloneProbe(
  table: ProbeTable,
  columns: readonly string[],
  freshKey: ColumnValue | null,
): Probe {
  if (columns.length === 0) {
    return staticProbe(`insert into ${target(table)} default values`);
  }
  const parts: Part[] = [
    `insert into ${target(table)} (${columns.map((column) => quoteIdent(column)).join(", ")}) select `,
  ];
  columns.forEach((column, index) => {
    if (index > 0) {
      parts.push(", ");
    }
    if (freshKey !== null && column === freshKey.column) {
      parts.push(param(freshKey.value), `::${freshKey.type}`);
    } else {
      parts.push(quoteIdent(column));
    }
  });
  parts.push(` from ${SOURCE}`);
  return build(parts);
}

// ---------------------------------------------------------------------------------------------
// Scope membership
// ---------------------------------------------------------------------------------------------

/**
 * As the superuser: the rows whose `column` equals a claim, compared by POSTGRES in the column's
 * type. Text comparison in JavaScript is wrong for it: `AAAA...` and `aaaa...` are one uuid, `1`
 * and `1.0` one numeric.
 */
export function rowsEqualToProbe(table: ProbeTable, column: ColumnValue): Probe {
  return build([
    `select ${primaryKeySelectList(table.primaryKey)} from ${target(table)} where ${quoteIdent(column.column)} = `,
    param(column.value),
    `::${column.type}`,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------

/**
 * The reproducible script of one probe transaction, literals inlined: paste it into psql (as the
 * superuser that owns the session) and it does what the runner did, then rolls back.
 */
export function renderProbeScript(identity: ProbeIdentity, statements: readonly Probe[]): string {
  const lines = ["begin", ...identityProbes(identity).map((probe) => probe.inlined)];
  for (const statement of statements) {
    lines.push(statement.inlined);
  }
  lines.push("rollback");
  return lines.map((line) => `${line};`).join("\n");
}
