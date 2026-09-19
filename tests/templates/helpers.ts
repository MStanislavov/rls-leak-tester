/**
 * Helpers for the template suites. The matrix runner is a separate slice, so these suites do not
 * use it: they switch role and claims by hand, exactly as a probe must (transaction, role, claims,
 * statement, rollback), and compare row keys.
 */
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import { setupDatabase } from "@/lib/runner/setup";
import {
  SqlError,
  SQLSTATE_INSUFFICIENT_PRIVILEGE,
  type SqlEngine,
  type SqlParam,
  type SqlTransaction,
} from "@/lib/runner/types";
import {
  compareText,
  personaSub,
  personaTenant,
  qualifiedName,
  quoteIdent,
  type Expectation,
  type Persona,
  type Scenario,
} from "@/lib/scenario";

export const BLOCKED = "blocked" as const;

/** A fresh database with the variant's shim, grants, schema and seed. The caller closes it. */
export async function loadScenario(scenario: Scenario): Promise<SqlEngine> {
  const engine = await createPgliteEngine();
  await setupDatabase(engine, scenario, SUPABASE_SETUP_SQL);
  return engine;
}

export function personaOf(scenario: Scenario, id: string): Persona {
  const persona = scenario.personas.find((candidate) => candidate.id === id);
  if (persona === undefined) {
    throw new Error(`no persona '${id}' in ${scenario.id}`);
  }
  return persona;
}

/** Runs `work` under the persona's role and claims, then rolls back, whatever happened. */
export async function asPersona<T>(
  engine: SqlEngine,
  persona: Persona,
  work: (tx: SqlTransaction) => Promise<T>,
): Promise<T> {
  return engine.transaction(async (tx) => {
    try {
      await tx.query("select set_config('role', $1, true)", [persona.dbRole]);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(persona.claims),
      ]);
      return await work(tx);
    } finally {
      await tx.rollback();
    }
  });
}

function textIds(rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  return rows.map((row) => String(row.id)).sort(compareText);
}

/**
 * The `id` values a statement returns for the persona, sorted. SQLSTATE 42501 means the statement
 * was blocked; any other error is a defect of the template and is rethrown.
 */
export async function idsAs(
  engine: SqlEngine,
  persona: Persona,
  sql: string,
  params: readonly SqlParam[] = [],
): Promise<string[] | typeof BLOCKED> {
  return asPersona(engine, persona, async (tx) => {
    try {
      return textIds((await tx.query(sql, params)).rows);
    } catch (error) {
      if (error instanceof SqlError && error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
        return BLOCKED;
      }
      throw error;
    }
  });
}

/** Rows a write touched for the persona, or `blocked` on 42501. Rolled back either way. */
export async function writeAs(
  engine: SqlEngine,
  persona: Persona,
  sql: string,
  params: readonly SqlParam[] = [],
): Promise<number | typeof BLOCKED> {
  return asPersona(engine, persona, async (tx) => {
    try {
      return (await tx.query(sql, params)).affectedRows;
    } catch (error) {
      if (error instanceof SqlError && error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
        return BLOCKED;
      }
      throw error;
    }
  });
}

/** As the superuser: the ground truth. */
export async function idsAsSuperuser(
  engine: SqlEngine,
  sql: string,
  params: readonly SqlParam[] = [],
): Promise<string[]> {
  return textIds((await engine.query(sql, params)).rows);
}

/**
 * Binds the named parameters of an `expectedRowsSql`: `:sub` becomes the persona's user id and
 * `:claims` the claims as jsonb, each as a numbered parameter sent as text. A `::` cast is left
 * alone.
 */
export function bindExpectedRowsSql(
  sql: string,
  persona: Persona,
): { sql: string; params: SqlParam[] } {
  const params: SqlParam[] = [];
  const values: Record<string, SqlParam> = {
    sub: personaSub(persona) ?? null,
    claims: JSON.stringify(persona.claims),
  };
  const numbers = new Map<string, number>();
  const bound = sql.replace(/(?<!:):(sub|claims)\b/g, (_match, name: string) => {
    let number = numbers.get(name);
    if (number === undefined) {
      params.push(values[name] ?? null);
      number = params.length;
      numbers.set(name, number);
    }
    return name === "claims" ? `$${number}::text::jsonb` : `$${number}::text`;
  });
  return { sql: bound, params };
}

/**
 * The keys an expectation stands for, computed as the superuser. Every template table has the
 * single primary key column `id`.
 */
export async function expectedIds(
  engine: SqlEngine,
  scenario: Scenario,
  expectation: Expectation,
): Promise<string[]> {
  const persona = personaOf(scenario, expectation.personaId);
  const table = qualifiedName(expectation.schema, expectation.table);
  const config = scenario.tables.find(
    (candidate) => candidate.schema === expectation.schema && candidate.name === expectation.table,
  );
  switch (expectation.scope) {
    case "none":
      return [];
    case "all":
      return idsAsSuperuser(engine, `select id from ${table}`);
    case "own":
    case "tenant": {
      const column = expectation.scope === "own" ? config?.ownerColumn : config?.tenantColumn;
      const value = expectation.scope === "own" ? personaSub(persona) : personaTenant(persona);
      if (column === undefined || value === undefined) {
        throw new Error(
          `${expectation.scope} scope needs a column and a claim: ${JSON.stringify(expectation)}`,
        );
      }
      return idsAsSuperuser(
        engine,
        `select id from ${table} where ${quoteIdent(column)}::text = $1`,
        [value],
      );
    }
    case "custom": {
      const bound = bindExpectedRowsSql(expectation.expectedRowsSql ?? "", persona);
      return idsAsSuperuser(engine, bound.sql, bound.params);
    }
  }
}
