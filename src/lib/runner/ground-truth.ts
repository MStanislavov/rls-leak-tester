/**
 * The ground-truth snapshot (brief 3.5 steps 6 and 7): for every table of the catalog, every
 * primary key with its owner and tenant values, read as the SUPERUSER. It is what "expected" and
 * "leaked" are computed against, so it must never be read after a role switch.
 *
 * Keys. A row is identified by its primary key, serialised as the JSON array of the key columns'
 * `::text` values in key order: `["7"]`, `["3","b0e1..."]`. Text, because `int8`, `numeric`, dates
 * and uuids would otherwise depend on the JavaScript parser; an array, because a separator could
 * occur inside a value. Probes MUST build their keys with the same two helpers exported here
 * (`primaryKeySelectList`, `keyOfRow`), or actual and expected keys will not compare equal.
 *
 * A table without a primary key cannot be tracked row by row and is `skipped` with that reason.
 * There is no fallback to `ctid` (brief 3.5 step 6): it is a physical location that changes when a
 * row is updated, so it cannot identify the same row before and after a probe.
 *
 * Determinism: tables in catalog order, rows sorted by serialised key in code-unit order.
 *
 * Identifiers come from the catalog and from the scenario's table config, which is user input:
 * every one goes through `quoteIdent` / `qualifiedName`, and a configured column that the catalog
 * does not know is refused before any SQL is built.
 */
import { qualifiedName, quoteIdent, type TableConfig } from "@/lib/scenario";
import type { Catalog, CatalogTable } from "./introspect";
import type { SqlExecutor, SqlRow } from "./types";

export const NO_PRIMARY_KEY_REASON =
  "The table has no primary key, so its rows cannot be tracked one by one.";

export interface GroundTruthRow {
  /** The serialised primary key, see `serializeKey`. */
  readonly key: string;
  /** The owner column's value as text; `null` when it is NULL or no owner column is configured. */
  readonly owner: string | null;
  /** The tenant column's value as text; `null` when it is NULL or none is configured. */
  readonly tenant: string | null;
}

export interface GroundTruthSnapshot {
  readonly status: "ok";
  readonly schema: string;
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly ownerColumn: string | null;
  readonly tenantColumn: string | null;
  readonly rows: readonly GroundTruthRow[];
}

export interface GroundTruthSkipped {
  readonly status: "skipped";
  readonly schema: string;
  readonly name: string;
  readonly reason: string;
}

export type GroundTruthTable = GroundTruthSnapshot | GroundTruthSkipped;

export interface GroundTruth {
  /** One entry per catalog table, in catalog order. */
  readonly tables: readonly GroundTruthTable[];
}

/** The one serialisation of a primary key. `values` are the key columns' `::text` values in key order. */
export function serializeKey(values: readonly string[]): string {
  return JSON.stringify(values);
}

const keyAlias = (index: number): string => `k${index}`;

/**
 * The select list that reads a primary key for `keyOfRow`: `"id"::text as k0, "b"::text as k1`.
 * Use it after `SELECT` and after `RETURNING` alike.
 */
export function primaryKeySelectList(primaryKey: readonly string[]): string {
  return primaryKey
    .map((column, index) => `${quoteIdent(column)}::text as ${keyAlias(index)}`)
    .join(", ");
}

/** Builds the serialised key from a row selected with `primaryKeySelectList`. */
export function keyOfRow(row: SqlRow, keyLength: number): string {
  const values: string[] = [];
  for (let index = 0; index < keyLength; index += 1) {
    const value = row[keyAlias(index)];
    if (typeof value !== "string") {
      throw new TypeError(
        `Primary key column ${index} is ${value === null || value === undefined ? "missing" : typeof value}; select it with primaryKeySelectList`,
      );
    }
    values.push(value);
  }
  return serializeKey(values);
}

function compareKeys(a: GroundTruthRow, b: GroundTruthRow): number {
  if (a.key === b.key) {
    return 0;
  }
  return a.key < b.key ? -1 : 1;
}

function configFor(table: CatalogTable, configs: readonly TableConfig[]): TableConfig | undefined {
  return configs.find((config) => config.schema === table.schema && config.name === table.name);
}

/** A configured column the catalog does not know is refused: it never reaches the SQL text. */
function unknownColumn(table: CatalogTable, column: string | undefined): boolean {
  return column !== undefined && !table.columns.some((candidate) => candidate.name === column);
}

function textOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

async function snapshotTable(
  engine: SqlExecutor,
  table: CatalogTable,
  config: TableConfig | undefined,
): Promise<GroundTruthTable> {
  const { schema, name } = table;
  if (table.primaryKey.length === 0) {
    return { status: "skipped", schema, name, reason: NO_PRIMARY_KEY_REASON };
  }
  const ownerColumn = config?.ownerColumn;
  const tenantColumn = config?.tenantColumn;
  for (const [role, column] of [
    ["owner", ownerColumn],
    ["tenant", tenantColumn],
  ] as const) {
    if (column !== undefined && unknownColumn(table, column)) {
      return {
        status: "skipped",
        schema,
        name,
        reason: `The configured ${role} column "${column}" does not exist in this table.`,
      };
    }
  }

  const select = [
    primaryKeySelectList(table.primaryKey),
    ownerColumn === undefined
      ? "null::text as owner_value"
      : `${quoteIdent(ownerColumn)}::text as owner_value`,
    tenantColumn === undefined
      ? "null::text as tenant_value"
      : `${quoteIdent(tenantColumn)}::text as tenant_value`,
  ].join(", ");
  const { rows } = await engine.query(`select ${select} from ${qualifiedName(schema, name)}`);

  return {
    status: "ok",
    schema,
    name,
    primaryKey: table.primaryKey,
    ownerColumn: ownerColumn ?? null,
    tenantColumn: tenantColumn ?? null,
    rows: rows
      .map((row): GroundTruthRow => ({
        key: keyOfRow(row, table.primaryKey.length),
        owner: textOrNull(row, "owner_value"),
        tenant: textOrNull(row, "tenant_value"),
      }))
      .sort(compareKeys),
  };
}

/**
 * Takes the snapshot. Call it on the engine (or a `tx` handle) as the superuser, after
 * `setupDatabase` and `introspect`, before any probe.
 */
export async function groundTruth(
  engine: SqlExecutor,
  catalog: Catalog,
  tableConfigs: readonly TableConfig[],
): Promise<GroundTruth> {
  const tables: GroundTruthTable[] = [];
  for (const table of catalog.tables) {
    tables.push(await snapshotTable(engine, table, configFor(table, tableConfigs)));
  }
  return { tables };
}
