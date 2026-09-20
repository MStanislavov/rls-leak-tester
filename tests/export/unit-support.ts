/**
 * Hand-built inputs for the unit tests of the export: a table, its ground truth and the plan
 * context of a cell, without a database. Only test files import this module.
 */
import type { CellPlanContext, CellResult, MatrixResult, MatrixTable } from "@/lib/runner";
import type { GroundTruthSnapshot } from "@/lib/runner/ground-truth";
import type { CatalogColumn, CatalogTable } from "@/lib/runner/introspect";
import type { Operation, Scenario, Scope } from "@/lib/scenario";

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";

export function column(
  name: string,
  type: string,
  extra: Partial<CatalogColumn> = {},
): CatalogColumn {
  return {
    name,
    position: 1,
    type,
    notNull: true,
    default: null,
    generated: null,
    generationExpression: null,
    identity: null,
    ...extra,
  };
}

export const NOTES: CatalogTable = {
  schema: "public",
  name: "notes",
  owner: "postgres",
  rlsEnabled: true,
  rlsForced: false,
  partitioned: false,
  columns: [
    column("id", "integer"),
    column("user_id", "uuid"),
    column("tenant_id", "integer"),
    column("body", "text", { notNull: false }),
  ],
  primaryKey: ["id"],
};

export const NOTES_TRUTH: GroundTruthSnapshot = {
  status: "ok",
  schema: "public",
  name: "notes",
  primaryKey: ["id"],
  ownerColumn: "user_id",
  tenantColumn: "tenant_id",
  rows: [
    { key: '["1"]', owner: ALICE, tenant: "1" },
    { key: '["2"]', owner: BOB, tenant: "1" },
    { key: '["3"]', owner: BOB, tenant: "2" },
  ],
};

export function contextOf(
  operation: Operation,
  scope: Scope,
  overrides: Partial<CellPlanContext> = {},
): CellPlanContext {
  const all = new Set(NOTES.columns.map((entry) => entry.name));
  return {
    identity: { role: "app_user", claimsJson: `{"sub":"${ALICE}","tenant_id":1}` },
    facts: { sub: ALICE, tenant: "1", tenantClaimConfigured: true },
    membership: { own: new Set(['["1"]']), tenant: new Set(['["1"]', '["2"]']) },
    expectation: {
      personaId: "alice",
      schema: "public",
      table: "notes",
      operation,
      scope,
      source: "explicit",
    },
    table: NOTES,
    truth: NOTES_TRUTH,
    expectedKeys: scope === "own" ? ['["1"]'] : ['["2"]', '["1"]'],
    policies: [],
    rlsBypass: null,
    updatableColumns: all,
    selectableColumns: all,
    ...overrides,
  };
}

export const SCENARIO: Scenario = {
  id: "unit-scenario",
  version: 1,
  title: "Unit scenario",
  description: "",
  mode: "postgres",
  schemaSql: "create table notes (id int primary key);",
  seedSql: "insert into notes values (1)",
  personas: [{ id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } }],
  tables: [],
  expectations: [],
};

export function cellResult(id: string, overrides: Partial<CellResult> = {}): CellResult {
  const [personaId = "", table = "", operation = "select"] = id.split("|");
  return {
    id,
    personaId,
    schema: "public",
    table: table.replace("public.", ""),
    operation: operation as Operation,
    scope: "own",
    expectationSource: "default",
    status: "pass",
    reason: null,
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
    policies: [],
    rlsBypass: null,
    ...overrides,
  };
}

/** A table of `MatrixResult.tables`; the export reads only `schema` and `name`. */
export const MATRIX_TABLE: MatrixTable = {
  schema: "public",
  name: "notes",
  primaryKey: ["id"],
  ownerColumn: "user_id",
  tenantColumn: "tenant_id",
  rlsEnabled: true,
  rlsForced: false,
  rowCount: 3,
  skippedReason: null,
};

export function resultOf(scenario: Scenario, cells: readonly CellResult[]): MatrixResult {
  return {
    version: 1,
    scenarioId: scenario.id,
    mode: scenario.mode,
    verdict: "ISOLATED",
    counts: { pass: cells.length, leak: 0, escape: 0, overblock: 0, inconclusive: 0, skipped: 0 },
    totalCells: cells.length,
    missingSchemas: [],
    personas: scenario.personas.map((persona) => ({
      id: persona.id,
      label: persona.label,
      dbRole: persona.dbRole,
      roleExists: true,
      rlsBypass: null,
      claimsJson: JSON.stringify(persona.claims),
    })),
    tables: [],
    cells,
    orphanExpectations: [],
  };
}
