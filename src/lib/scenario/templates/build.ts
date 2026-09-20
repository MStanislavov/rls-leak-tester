/**
 * Builders shared by the templates. They exist so that a template file reads as a table of
 * decisions (who may do what) and cannot forget a cell: `buildExpectations` refuses a table that
 * does not name every persona, so no template ever relies on the default scopes.
 */
import {
  OPERATIONS,
  SCENARIO_VERSION,
  type Expectation,
  type Operation,
  type Persona,
  type Scenario,
  type Scope,
  type SupabaseGrants,
  type TableConfig,
} from "../types";
import type {
  ExpectedFailure,
  ExpectedStaticCheck,
  Template,
  TemplateVariant,
  TemplateVariantKind,
} from "./types";

/** A scope, or the SQL of a `custom` scope. */
export type ScopeSpec = Exclude<Scope, "custom"> | { readonly customSql: string };

export type CellScopes = Readonly<Record<Operation, ScopeSpec>>;

export interface TableExpectations {
  readonly schema: string;
  readonly table: string;
  /** One entry per persona id. A missing or an unknown persona is an error. */
  readonly byPersona: Readonly<Record<string, CellScopes>>;
}

/** The same scope for select, insert, update and delete. */
export function everyOperation(scope: ScopeSpec): CellScopes {
  return { select: scope, insert: scope, update: scope, delete: scope };
}

/** May read `scope`, may write nothing. */
export function readOnly(scope: ScopeSpec): CellScopes {
  return { select: scope, insert: "none", update: "none", delete: "none" };
}

function toExpectation(
  personaId: string,
  table: TableExpectations,
  operation: Operation,
  spec: ScopeSpec,
): Expectation {
  const cell = { personaId, schema: table.schema, table: table.table, operation };
  return typeof spec === "string"
    ? { ...cell, scope: spec }
    : { ...cell, scope: "custom", expectedRowsSql: spec.customSql };
}

/**
 * One explicit expectation per table x persona x operation, in matrix order: tables as given,
 * personas in scenario order, operations in `OPERATIONS` order.
 */
export function buildExpectations(
  personas: readonly Pick<Persona, "id">[],
  tables: readonly TableExpectations[],
): Expectation[] {
  const personaIds = new Set(personas.map((persona) => persona.id));
  const expectations: Expectation[] = [];
  for (const table of tables) {
    const unknown = Object.keys(table.byPersona).find((id) => !personaIds.has(id));
    if (unknown !== undefined) {
      throw new RangeError(`${table.schema}.${table.table}: unknown persona '${unknown}'`);
    }
    for (const persona of personas) {
      const cells = table.byPersona[persona.id];
      if (cells === undefined) {
        throw new RangeError(
          `${table.schema}.${table.table}: no expectations for persona '${persona.id}'`,
        );
      }
      for (const operation of OPERATIONS) {
        expectations.push(toExpectation(persona.id, table, operation, cells[operation]));
      }
    }
  }
  return expectations;
}

/** Everything the two variants of a template share, plus the one thing that differs. */
export interface TemplateParts {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly leak: string;
  readonly fix: string;
  readonly schemaSql: Readonly<Record<TemplateVariantKind, string>>;
  readonly seedSql: string;
  /**
   * The Supabase grants regime both variants run under. Default `legacy`: RLS is the only
   * barrier. `explicit` is for a schema that writes its own grants.
   */
  readonly supabaseGrants?: SupabaseGrants;
  readonly personas: readonly Persona[];
  readonly tables: readonly TableConfig[];
  readonly expectations: readonly Expectation[];
  /** What the runner must report for the leaky variant. The fixed variant expects nothing. */
  readonly expectedFailures: readonly ExpectedFailure[];
  readonly expectedStaticChecks: readonly ExpectedStaticCheck[];
}

function scenarioOf(parts: TemplateParts, kind: TemplateVariantKind): Scenario {
  const note = kind === "leaky" ? `Leaky variant: ${parts.leak}` : `Fixed variant: ${parts.fix}`;
  return {
    id: `${parts.id}-${kind}`,
    version: SCENARIO_VERSION,
    title: `${parts.title} (${kind})`,
    description: `${parts.description} ${note}`,
    mode: "supabase",
    schemaSql: parts.schemaSql[kind],
    seedSql: parts.seedSql,
    // Fresh copies: a caller that edits one variant must not change the other.
    personas: structuredClone([...parts.personas]),
    tables: structuredClone([...parts.tables]),
    expectations: structuredClone([...parts.expectations]),
    options: { exposedSchemas: ["public"], supabaseGrants: parts.supabaseGrants ?? "legacy" },
  };
}

function variantOf(parts: TemplateParts, kind: TemplateVariantKind): TemplateVariant {
  const leaky = kind === "leaky";
  return {
    kind,
    scenario: scenarioOf(parts, kind),
    expectedVerdict: leaky ? "LEAKING" : "ISOLATED",
    expectedFailures: leaky ? [...parts.expectedFailures] : [],
    expectedStaticChecks: leaky ? [...parts.expectedStaticChecks] : [],
  };
}

export function defineTemplate(parts: TemplateParts): Template {
  return {
    id: parts.id,
    title: parts.title,
    description: parts.description,
    leak: parts.leak,
    fix: parts.fix,
    leaky: variantOf(parts, "leaky"),
    fixed: variantOf(parts, "fixed"),
  };
}
