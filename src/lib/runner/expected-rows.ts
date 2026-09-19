/**
 * Scope `custom` (brief 3.4): `expectedRowsSql` is a query, run as the SUPERUSER, that returns the
 * primary keys the persona should reach. `:sub` and `:claims` are its two inputs.
 *
 * The user's query is wrapped, never edited:
 *
 *   select "id"::text as k0 from (
 *   <the query>
 *   ) as expected_rows("id")
 *
 * The alias list renames the query's first columns to the primary key columns BY POSITION, so
 * `select doc_id from shares where ...` works for a table whose key is `id`, and a composite key
 * takes the first columns in key order. The outer select reads the keys with the same `::text`
 * spelling as the ground truth, so both compare equal.
 *
 * Exactly one statement is accepted. The runner executes it inside a transaction that is rolled
 * back, so a query that writes (a data-modifying CTE) leaves nothing behind.
 */
import { quoteIdent, splitSqlStatements } from "@/lib/scenario";
import { primaryKeySelectList } from "./ground-truth";
import { inlineNamedParameters, rewriteNamedParameters, type NamedParameter } from "./named-params";
import type { Probe, ProbeTable } from "./probes";

/** `expectedRowsSql` cannot be used as it is. The message is shown in the cell. */
export class ExpectedRowsSqlError extends Error {
  override readonly name = "ExpectedRowsSqlError";
}

export type NamedValues = Readonly<Record<NamedParameter, string | null>>;

function wrap(table: ProbeTable, query: string): string {
  const aliases = table.primaryKey.map(quoteIdent).join(", ");
  return `select ${primaryKeySelectList(table.primaryKey)} from (\n${query}\n) as expected_rows(${aliases})`;
}

/**
 * The probe that reads the expected keys. `values.sub` is the persona's `sub` claim (`null`
 * without one), `values.claims` the claims JSON text.
 *
 * @throws ExpectedRowsSqlError for an empty text or more than one statement,
 *   `NamedParameterError` when the text uses `$n`.
 */
export function expectedRowsProbe(
  table: ProbeTable,
  expectedRowsSql: string,
  values: NamedValues,
): Probe {
  const statements = splitSqlStatements(expectedRowsSql);
  const [statement] = statements;
  if (statement === undefined || statements.length !== 1) {
    throw new ExpectedRowsSqlError(
      `expectedRowsSql must be exactly one query; it has ${statements.length} statements.`,
    );
  }
  const { sql, order } = rewriteNamedParameters(statement.text);
  return {
    sql: wrap(table, sql),
    params: order.map((name) => values[name]),
    inlined: wrap(table, inlineNamedParameters(statement.text, values)),
  };
}
