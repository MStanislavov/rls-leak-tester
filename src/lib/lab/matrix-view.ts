/**
 * The result matrix as the grid shows it. Row groups are tables, rows are personas, the four
 * columns are the operations: with 3 to 6 personas that is a grid of 4 columns that fits a
 * 1024 px window and still reads on a phone, where persona x operation columns (up to 24) would
 * not. Order is the runner's: tables by schema and name, personas in scenario order, operations
 * select, insert, update, delete.
 */
import type { Finding } from "@/lib/checks";
import { CELL_STATUSES, type CellResult, type CellStatus, type MatrixResult } from "@/lib/runner";
import { OPERATIONS, type Operation } from "@/lib/scenario";

/** The key of a table everywhere in the lab: the same spelling the runner's cell ids use. */
export function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

export interface MatrixCellView {
  readonly id: string;
  readonly operation: Operation;
  readonly status: CellStatus;
  readonly scope: CellResult["scope"];
  readonly expectationSource: CellResult["expectationSource"];
  readonly leakedCount: number;
  readonly missingCount: number;
  /** `false` when a status filter is active and this cell is not part of it (shown dimmed). */
  readonly matchesFilter: boolean;
}

export interface MatrixRowView {
  readonly personaId: string;
  readonly personaLabel: string;
  readonly dbRole: string;
  readonly rlsBypass: string | null;
  /** One entry per operation, in `OPERATIONS` order; `null` where the runner produced no cell. */
  readonly cells: readonly (MatrixCellView | null)[];
}

export interface MatrixTableView {
  readonly key: string;
  readonly schema: string;
  readonly name: string;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly rowCount: number | null;
  readonly skippedReason: string | null;
  readonly ownerColumn: string | null;
  readonly tenantColumn: string | null;
  readonly findingCount: number;
  readonly rows: readonly MatrixRowView[];
}

export interface MatrixView {
  readonly operations: readonly Operation[];
  readonly tables: readonly MatrixTableView[];
  /** Cell ids of the visible rows, row by row: what arrow-key navigation walks over. */
  readonly cellIds: readonly (readonly (string | null)[])[];
  /** Counts over ALL cells, whatever the filter: the chips show them. */
  readonly counts: Readonly<Record<CellStatus, number>>;
  readonly totalCells: number;
  readonly visibleRows: number;
}

/** The table a finding is about: its own table, or the table of its policy. Views and functions have none. */
export function findingTableKey(finding: Pick<Finding, "object">): string | null {
  const { object } = finding;
  if (object.kind === "table") {
    return tableKey(object.schema, object.name);
  }
  if (object.kind === "policy" && object.table !== undefined) {
    return tableKey(object.schema, object.table);
  }
  return null;
}

function toCellView(cell: CellResult, filter: readonly CellStatus[]): MatrixCellView {
  return {
    id: cell.id,
    operation: cell.operation,
    status: cell.status,
    scope: cell.scope,
    expectationSource: cell.expectationSource,
    leakedCount: cell.leakedKeys.length,
    missingCount: cell.missingKeys.length,
    matchesFilter: filter.length === 0 || filter.includes(cell.status),
  };
}

export function buildMatrixView(
  result: MatrixResult,
  filter: readonly CellStatus[] = [],
  findings: readonly Finding[] = [],
): MatrixView {
  const byPosition = new Map<string, CellResult>();
  for (const cell of result.cells) {
    byPosition.set(JSON.stringify([cell.schema, cell.table, cell.personaId, cell.operation]), cell);
  }
  const findingCounts = new Map<string, number>();
  for (const finding of findings) {
    const key = findingTableKey(finding);
    if (key !== null) {
      findingCounts.set(key, (findingCounts.get(key) ?? 0) + 1);
    }
  }

  const tables: MatrixTableView[] = [];
  const cellIds: (string | null)[][] = [];
  for (const table of result.tables) {
    const rows: MatrixRowView[] = [];
    for (const persona of result.personas) {
      const cells = OPERATIONS.map((operation) => {
        const cell = byPosition.get(
          JSON.stringify([table.schema, table.name, persona.id, operation]),
        );
        return cell === undefined ? null : toCellView(cell, filter);
      });
      const hasCells = cells.some((cell) => cell !== null);
      const visible = cells.some((cell) => cell?.matchesFilter === true);
      if (!hasCells || !visible) {
        continue;
      }
      rows.push({
        personaId: persona.id,
        personaLabel: persona.label,
        dbRole: persona.dbRole,
        rlsBypass: persona.rlsBypass,
        cells,
      });
      cellIds.push(cells.map((cell) => cell?.id ?? null));
    }
    if (rows.length === 0) {
      continue;
    }
    const key = tableKey(table.schema, table.name);
    tables.push({
      key,
      schema: table.schema,
      name: table.name,
      rlsEnabled: table.rlsEnabled,
      rlsForced: table.rlsForced,
      rowCount: table.rowCount,
      skippedReason: table.skippedReason,
      ownerColumn: table.ownerColumn,
      tenantColumn: table.tenantColumn,
      findingCount: findingCounts.get(key) ?? 0,
      rows,
    });
  }

  return {
    operations: OPERATIONS,
    tables,
    cellIds,
    counts: result.counts,
    totalCells: result.totalCells,
    visibleRows: cellIds.length,
  };
}

/** The statuses worth a chip: those that occur, in the fixed order of `CELL_STATUSES`. */
export function statusChips(
  counts: Readonly<Record<CellStatus, number>>,
): readonly { readonly status: CellStatus; readonly count: number }[] {
  return CELL_STATUSES.filter((status) => counts[status] > 0).map((status) => ({
    status,
    count: counts[status],
  }));
}
