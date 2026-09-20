/**
 * The Tables and Expectations panels. Before anything was introspected they show what the
 * scenario configures; afterwards every table of the catalog, with the owner and tenant column
 * the heuristics suggest and the user may override, and one expectation per persona x table x
 * operation, where a cell the user has not set is marked as a default.
 */
import type { Catalog } from "@/lib/runner/introspect";
import {
  compareText,
  defaultScope,
  findOrphanExpectations,
  resolveExpectations,
  resolveTableConfigs,
  type Expectation,
  type Operation,
  type Scenario,
  type Scope,
  type TableConfig,
} from "@/lib/scenario";
import { OPERATIONS } from "@/lib/scenario";
import { tableKey } from "./matrix-view";
import type { CellRef } from "./scenario-edit";

export type TableConfigSource = "configured" | "suggested" | "none";

export interface LabTableView {
  readonly key: string;
  readonly schema: string;
  readonly name: string;
  /** `true` when the catalog knows the table, so its columns can be offered. */
  readonly introspected: boolean;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  /** What a run would use right now. */
  readonly effective: TableConfig;
  readonly source: TableConfigSource;
  /** Configured columns the catalog does not have: the runner would skip the table. */
  readonly unknownColumns: readonly string[];
}

export interface ExpectationCellView {
  readonly cell: CellRef;
  readonly scope: Scope;
  readonly source: "explicit" | "default";
  /** What the cell would be without an explicit expectation. */
  readonly defaultScope: Exclude<Scope, "custom">;
  readonly expectedRowsSql: string | null;
}

export interface ExpectationRowView {
  readonly personaId: string;
  readonly personaLabel: string;
  readonly dbRole: string;
  readonly cells: readonly ExpectationCellView[];
}

export interface ExpectationTableView {
  readonly table: LabTableView;
  readonly rows: readonly ExpectationRowView[];
}

export interface TablesView {
  readonly tables: readonly LabTableView[];
  readonly expectations: readonly ExpectationTableView[];
  /** Explicit expectations that match no listed table or no persona. */
  readonly orphans: readonly Expectation[];
  readonly introspected: boolean;
}

function sourceOf(scenario: Scenario, table: TableConfig): TableConfigSource {
  const configured = scenario.tables.some(
    (entry) => entry.schema === table.schema && entry.name === table.name,
  );
  if (configured) {
    return "configured";
  }
  return table.ownerColumn !== undefined || table.tenantColumn !== undefined ? "suggested" : "none";
}

function unknownColumnsOf(config: TableConfig, columns: readonly string[]): string[] {
  return [config.ownerColumn, config.tenantColumn].filter(
    (column): column is string => column !== undefined && !columns.includes(column),
  );
}

function tablesOf(scenario: Scenario, catalog: Catalog | null): LabTableView[] {
  if (catalog === null) {
    return [...scenario.tables]
      .sort((a, b) => compareText(a.schema, b.schema) || compareText(a.name, b.name))
      .map((config) => ({
        key: tableKey(config.schema, config.name),
        schema: config.schema,
        name: config.name,
        introspected: false,
        columns: [],
        primaryKey: [],
        effective: config,
        source: "configured" as const,
        unknownColumns: [],
      }));
  }
  const configs = resolveTableConfigs(
    scenario.tables,
    catalog.tables.map((table) => ({
      schema: table.schema,
      name: table.name,
      columns: table.columns.map((column) => column.name),
    })),
  );
  return configs.map((config) => {
    const table = catalog.tables.find(
      (entry) => entry.schema === config.schema && entry.name === config.name,
    );
    const columns = table?.columns.map((column) => column.name) ?? [];
    return {
      key: tableKey(config.schema, config.name),
      schema: config.schema,
      name: config.name,
      introspected: true,
      columns,
      primaryKey: table?.primaryKey ?? [],
      effective: config,
      source: sourceOf(scenario, config),
      unknownColumns: unknownColumnsOf(config, columns),
    };
  });
}

export function buildTablesView(scenario: Scenario, catalog: Catalog | null): TablesView {
  const tables = tablesOf(scenario, catalog);
  const resolved = resolveExpectations(
    scenario,
    tables.map((table) => table.effective),
  );
  const byCell = new Map(
    resolved.map((expectation) => [
      JSON.stringify([
        expectation.schema,
        expectation.table,
        expectation.personaId,
        expectation.operation,
      ]),
      expectation,
    ]),
  );

  const expectations = tables.map((table): ExpectationTableView => {
    const rows = scenario.personas.map((persona): ExpectationRowView => {
      const cells = OPERATIONS.map((operation: Operation): ExpectationCellView => {
        const found = byCell.get(JSON.stringify([table.schema, table.name, persona.id, operation]));
        const fallback = defaultScope(persona, table.effective, operation);
        return {
          cell: { personaId: persona.id, schema: table.schema, table: table.name, operation },
          scope: found?.scope ?? fallback,
          source: found?.source ?? "default",
          defaultScope: fallback,
          expectedRowsSql: found?.expectedRowsSql ?? null,
        };
      });
      return { personaId: persona.id, personaLabel: persona.label, dbRole: persona.dbRole, cells };
    });
    return { table, rows };
  });

  return {
    tables,
    expectations,
    orphans: findOrphanExpectations(scenario, tables),
    introspected: catalog !== null,
  };
}
