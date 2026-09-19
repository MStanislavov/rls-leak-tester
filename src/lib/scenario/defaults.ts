/**
 * Default expectations (brief section 3.4) and the effective expectation of every matrix cell.
 */
import { compareText } from "./heuristics";
import {
  OPERATIONS,
  type Expectation,
  type Operation,
  type Persona,
  type ResolvedExpectation,
  type Scenario,
  type Scope,
  type TableConfig,
  type TableRef,
} from "./types";

export type DefaultScope = (
  persona: Pick<Persona, "dbRole">,
  tableConfig: Pick<TableConfig, "ownerColumn" | "tenantColumn"> | undefined,
  operation: Operation,
) => Exclude<Scope, "custom">;

/**
 * The scope a cell gets when the user has not set one. Decided by the role NAME, in both modes:
 *
 * - `anon`: `none`.
 * - `service_role`: `all`.
 * - `authenticated`: `own` if the table has an owner column, else `tenant` if it has a tenant
 *   column, else `none`.
 * - any other role (a custom role in `postgres` mode): the same rule as `authenticated`. A custom
 *   application role stands for a signed-in user, and the rule is the least privilege that is
 *   still useful; it never defaults to `all`. A role that is meant to see everything (an admin
 *   or a BYPASSRLS role) needs explicit expectations.
 *
 * The brief's defaults do not differ by operation. `operation` is part of the signature
 * (`DefaultScope`) so that callers pass the whole cell and a later version can refine the rule
 * without touching them; the implementation does not read it today.
 */
export const defaultScope: DefaultScope = (persona, tableConfig) => {
  if (persona.dbRole === "anon") {
    return "none";
  }
  if (persona.dbRole === "service_role") {
    return "all";
  }
  if (tableConfig?.ownerColumn !== undefined) {
    return "own";
  }
  if (tableConfig?.tenantColumn !== undefined) {
    return "tenant";
  }
  return "none";
};

function tableKey(table: TableRef): string {
  return JSON.stringify([table.schema, table.name]);
}

function cellKey(personaId: string, table: TableRef, operation: Operation): string {
  return JSON.stringify([personaId, table.schema, table.name, operation]);
}

/** Tables sorted by schema, then name, in code-unit order; duplicates dropped (first one wins). */
function sortedUniqueTables(tables: readonly TableConfig[]): TableConfig[] {
  const unique = new Map<string, TableConfig>();
  for (const table of tables) {
    if (!unique.has(tableKey(table))) {
      unique.set(tableKey(table), table);
    }
  }
  return [...unique.values()].sort(
    (a, b) => compareText(a.schema, b.schema) || compareText(a.name, b.name),
  );
}

/**
 * One effective expectation per table x persona x operation, in a stable order: tables by schema
 * and name (code-unit order, so the order in which introspection reports them does not matter),
 * then personas in the order of the scenario, then select, insert, update, delete.
 *
 * `tables` are the effective table configs of the run (see `resolveTableConfigs`): they decide
 * which cells exist and which columns the defaults look at. An explicit expectation wins over
 * the default and is marked `source: 'explicit'`; an expectation for a table that is not in
 * `tables` is not returned here, `findOrphanExpectations` lists those.
 */
export function resolveExpectations(
  scenario: Pick<Scenario, "personas" | "expectations">,
  tables: readonly TableConfig[],
): ResolvedExpectation[] {
  const explicit = new Map<string, Expectation>();
  for (const expectation of scenario.expectations) {
    const key = cellKey(
      expectation.personaId,
      { schema: expectation.schema, name: expectation.table },
      expectation.operation,
    );
    if (!explicit.has(key)) {
      explicit.set(key, expectation);
    }
  }

  const resolved: ResolvedExpectation[] = [];
  for (const table of sortedUniqueTables(tables)) {
    for (const persona of scenario.personas) {
      for (const operation of OPERATIONS) {
        const found = explicit.get(cellKey(persona.id, table, operation));
        resolved.push(
          found === undefined
            ? {
                personaId: persona.id,
                schema: table.schema,
                table: table.name,
                operation,
                scope: defaultScope(persona, table, operation),
                source: "default",
              }
            : { ...found, source: "explicit" },
        );
      }
    }
  }
  return resolved;
}

/**
 * Explicit expectations that match no cell of the run: the table is not among `tables` (dropped,
 * renamed, outside the exposed schemas) or the persona does not exist. In the scenario's order.
 */
export function findOrphanExpectations(
  scenario: Pick<Scenario, "personas" | "expectations">,
  tables: readonly TableRef[],
): Expectation[] {
  const tableKeys = new Set(tables.map(tableKey));
  const personaIds = new Set(scenario.personas.map((persona) => persona.id));
  return scenario.expectations.filter(
    (expectation) =>
      !personaIds.has(expectation.personaId) ||
      !tableKeys.has(tableKey({ schema: expectation.schema, name: expectation.table })),
  );
}
