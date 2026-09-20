/**
 * Pure edits of the working scenario. Every function returns a new scenario and leaves its input
 * alone, so the reducer stays trivial and dirty tracking is a comparison of serialised text.
 */
import {
  MAX_PERSONAS,
  SCENARIO_VERSION,
  qualifiedName,
  quoteIdent,
  resolveOptions,
  type Expectation,
  type Mode,
  type Operation,
  type Persona,
  type Scenario,
  type Scope,
  type SupabaseGrants,
  type TableConfig,
  type TableRef,
} from "@/lib/scenario";
import type { Template, TemplateVariantKind } from "@/lib/scenario/templates";

export type SqlKind = "schema" | "seed";

const BLANK_USER_A = "00000000-0000-4000-8000-00000000000a";
const BLANK_USER_B = "00000000-0000-4000-8000-00000000000b";

/** An empty Supabase scenario with the three personas almost every check needs. */
export function blankScenario(id: string): Scenario {
  return {
    id,
    version: SCENARIO_VERSION,
    title: "Untitled scenario",
    description: "",
    mode: "supabase",
    schemaSql: "",
    seedSql: "",
    personas: [
      { id: "anon", label: "Anonymous visitor", dbRole: "anon", claims: { role: "anon" } },
      { id: "user-a", label: "User A", dbRole: "authenticated", claims: { sub: BLANK_USER_A } },
      { id: "user-b", label: "User B", dbRole: "authenticated", claims: { sub: BLANK_USER_B } },
    ],
    tables: [],
    expectations: [],
    options: { exposedSchemas: ["public"], supabaseGrants: "legacy" },
  };
}

/** A private copy: editing it never touches the template constant. */
export function scenarioFromTemplate(template: Template, variant: TemplateVariantKind): Scenario {
  return structuredClone(template[variant].scenario);
}

export function withSql(scenario: Scenario, kind: SqlKind, text: string): Scenario {
  return kind === "schema" ? { ...scenario, schemaSql: text } : { ...scenario, seedSql: text };
}

export function sqlOf(scenario: Scenario, kind: SqlKind): string {
  return kind === "schema" ? scenario.schemaSql : scenario.seedSql;
}

export function withTitle(scenario: Scenario, title: string): Scenario {
  return { ...scenario, title };
}

export function withMode(scenario: Scenario, mode: Mode): Scenario {
  return { ...scenario, mode };
}

export function withGrants(scenario: Scenario, supabaseGrants: SupabaseGrants): Scenario {
  return { ...scenario, options: { ...resolveOptions(scenario), supabaseGrants } };
}

// ---------------------------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------------------------

function nextPersonaNumber(personas: readonly Persona[]): number {
  const ids = new Set(personas.map((persona) => persona.id));
  let number = personas.length + 1;
  while (ids.has(`user-${number}`)) {
    number += 1;
  }
  return number;
}

/** The role a new persona starts with: a signed-in user, in the vocabulary of the mode. */
function defaultRole(scenario: Scenario): string {
  if (scenario.mode === "supabase") {
    return "authenticated";
  }
  const custom = scenario.personas.findLast(
    (persona) => persona.dbRole !== "anon" && persona.dbRole !== "service_role",
  );
  return custom?.dbRole ?? "app_user";
}

export function canAddPersona(scenario: Scenario): boolean {
  return scenario.personas.length < MAX_PERSONAS;
}

/** Adds a signed-in user. `sub` comes from the caller (`crypto.randomUUID()`), so this stays pure. */
export function addPersona(scenario: Scenario, sub: string): Scenario {
  if (!canAddPersona(scenario)) {
    return scenario;
  }
  const number = nextPersonaNumber(scenario.personas);
  const persona: Persona = {
    id: `user-${number}`,
    label: `User ${number}`,
    dbRole: defaultRole(scenario),
    claims: { sub },
  };
  return { ...scenario, personas: [...scenario.personas, persona] };
}

/** Removes the persona and every expectation that names it. */
export function removePersona(scenario: Scenario, personaId: string): Scenario {
  return {
    ...scenario,
    personas: scenario.personas.filter((persona) => persona.id !== personaId),
    expectations: scenario.expectations.filter(
      (expectation) => expectation.personaId !== personaId,
    ),
  };
}

export type PersonaPatch = Partial<
  Pick<Persona, "label" | "dbRole" | "claims" | "tenantClaimPath">
>;

export function updatePersona(
  scenario: Scenario,
  personaId: string,
  patch: PersonaPatch,
): Scenario {
  return {
    ...scenario,
    personas: scenario.personas.map((persona) => {
      if (persona.id !== personaId) {
        return persona;
      }
      const next: Persona = { ...persona, ...patch };
      if (next.tenantClaimPath === undefined || next.tenantClaimPath.trim() === "") {
        delete next.tenantClaimPath;
      }
      return next;
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Table configs
// ---------------------------------------------------------------------------------------------

function sameTable(a: TableRef, b: TableRef): boolean {
  return a.schema === b.schema && a.name === b.name;
}

export type TableColumnField = "ownerColumn" | "tenantColumn";

/**
 * Overrides one column of a table's config. `effective` is what the run would use right now (the
 * configured entry, or the heuristic's suggestion): the override starts from it, because a
 * configured table is never second-guessed and would otherwise lose its other column.
 */
export function setTableColumn(
  scenario: Scenario,
  effective: TableConfig,
  field: TableColumnField,
  column: string | undefined,
): Scenario {
  const next: TableConfig = { schema: effective.schema, name: effective.name };
  const owner = field === "ownerColumn" ? column : effective.ownerColumn;
  const tenant = field === "tenantColumn" ? column : effective.tenantColumn;
  if (owner !== undefined && owner !== "") {
    next.ownerColumn = owner;
  }
  if (tenant !== undefined && tenant !== "") {
    next.tenantColumn = tenant;
  }
  return {
    ...scenario,
    tables: [...scenario.tables.filter((table) => !sameTable(table, effective)), next],
  };
}

/** Drops the override, so the heuristic decides again. */
export function resetTableConfig(scenario: Scenario, table: TableRef): Scenario {
  return { ...scenario, tables: scenario.tables.filter((entry) => !sameTable(entry, table)) };
}

// ---------------------------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------------------------

export interface CellRef {
  readonly personaId: string;
  readonly schema: string;
  readonly table: string;
  readonly operation: Operation;
}

function sameCell(expectation: Expectation, cell: CellRef): boolean {
  return (
    expectation.personaId === cell.personaId &&
    expectation.schema === cell.schema &&
    expectation.table === cell.table &&
    expectation.operation === cell.operation
  );
}

export function findExpectation(scenario: Scenario, cell: CellRef): Expectation | undefined {
  return scenario.expectations.find((expectation) => sameCell(expectation, cell));
}

/** A valid starting point for a custom scope: it expects no row until the user edits it. */
export function starterExpectedRowsSql(table: TableRef, primaryKey: readonly string[]): string {
  const columns = primaryKey.length > 0 ? primaryKey.map(quoteIdent).join(", ") : "id";
  return `select ${columns} from ${qualifiedName(table.schema, table.name)} where false`;
}

export type ScopeChoice = Scope | "default";

/**
 * Sets one cell. `default` removes the explicit expectation so the defaults apply again.
 * `custom` keeps the SQL the cell already had, else takes `expectedRowsSql`.
 */
export function setExpectation(
  scenario: Scenario,
  cell: CellRef,
  choice: ScopeChoice,
  expectedRowsSql?: string,
): Scenario {
  const existing = findExpectation(scenario, cell);
  const others = scenario.expectations.filter((expectation) => !sameCell(expectation, cell));
  if (choice === "default") {
    return { ...scenario, expectations: others };
  }
  const next: Expectation = {
    personaId: cell.personaId,
    schema: cell.schema,
    table: cell.table,
    operation: cell.operation,
    scope: choice,
  };
  if (choice === "custom") {
    next.expectedRowsSql = expectedRowsSql ?? existing?.expectedRowsSql ?? "";
  }
  return { ...scenario, expectations: [...others, next] };
}
