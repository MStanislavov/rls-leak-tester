"use client";

/**
 * The result matrix as an ARIA grid (WAI-ARIA grid pattern). Row groups are tables, rows are
 * personas, the four columns are the operations. One cell is in the tab order (roving tabindex);
 * arrows, Home, End, Ctrl+Home, Ctrl+End, Page Up and Page Down move the focus, Enter and Space
 * open the details. A status is an icon AND a word, never a colour alone.
 */
import { Lock, LockOpen, ShieldOff } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { STATUS_CLASSES, STATUS_ICONS } from "@/components/site/status-badge";
import {
  firstCell,
  isGridKey,
  moveInGrid,
  positionOf,
  type MatrixCellView,
  type MatrixTableView,
  type MatrixView,
} from "@/lib/lab";
import { statusMeta } from "@/lib/site/status";
import { cn } from "@/lib/utils";

interface ResultMatrixProps {
  readonly view: MatrixView;
  readonly selectedCellId: string | null;
  readonly highlightedTable: string | null;
  readonly onOpenCell: (cellId: string) => void;
}

/** The DOM id of a cell: what the drawer returns the focus to. */
export function matrixCellDomId(cellId: string): string {
  return `matrix-cell-${cellId}`;
}

export function focusMatrixCell(cellId: string): void {
  document.getElementById(matrixCellDomId(cellId))?.focus();
}

/**
 * A pass is quiet (no tint), so that what is not a pass stands out; a cell outside the status
 * filter is neutral. The icon and the word stay in every case.
 */
function cellTone(cell: MatrixCellView): string {
  if (!cell.matchesFilter) {
    return "border-transparent text-muted-foreground";
  }
  return cell.status === "pass" ? "border-border text-status-pass" : STATUS_CLASSES[cell.status];
}

function CellContent({ cell }: { readonly cell: MatrixCellView }) {
  const Icon = STATUS_ICONS[cell.status];
  const notes = [
    cell.leakedCount > 0 ? `${cell.leakedCount} leaked` : "",
    cell.missingCount > 0 ? `${cell.missingCount} missing` : "",
  ].filter((note) => note !== "");
  return (
    <>
      <span className="flex items-center gap-1.5 font-medium">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {statusMeta(cell.status).label}
      </span>
      <span className="block font-mono text-[0.7rem] leading-4">
        <span className="sr-only">, expected scope </span>
        {cell.scope}
        {cell.expectationSource === "default" ? " (default)" : ""}
        {notes.length > 0 ? `, ${notes.join(", ")}` : ""}
      </span>
    </>
  );
}

function TableHeading({
  table,
  columns,
}: {
  readonly table: MatrixTableView;
  readonly columns: number;
}) {
  const RlsIcon = table.rlsEnabled ? Lock : LockOpen;
  return (
    <tr>
      <th
        scope="colgroup"
        colSpan={columns}
        className="border-t bg-muted px-3 py-1.5 text-left text-xs font-normal"
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm font-semibold">{table.key}</span>
          <span className="inline-flex items-center gap-1">
            <RlsIcon aria-hidden="true" className="size-3.5" />
            {table.rlsEnabled ? (table.rlsForced ? "RLS forced" : "RLS enabled") : "RLS disabled"}
          </span>
          <span>
            {table.rowCount === null ? "rows not tracked" : `${table.rowCount} seeded rows`}
          </span>
          {table.ownerColumn === null ? null : (
            <span>
              owner <span className="font-mono">{table.ownerColumn}</span>
            </span>
          )}
          {table.tenantColumn === null ? null : (
            <span>
              tenant <span className="font-mono">{table.tenantColumn}</span>
            </span>
          )}
          {table.findingCount > 0 ? (
            <span>
              {table.findingCount} static finding{table.findingCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
        {table.skippedReason === null ? null : (
          <span className="mt-1 block">{table.skippedReason}</span>
        )}
      </th>
    </tr>
  );
}

export function ResultMatrix({
  view,
  selectedCellId,
  highlightedTable,
  onOpenCell,
}: ResultMatrixProps) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // The one cell in the tab order: the last focused one while it is visible, else the first.
  const tabStop =
    positionOf(view.cellIds, focusedId) === null ? firstCell(view.cellIds) : focusedId;
  const columns = view.operations.length + 1;

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>): void => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const cellId = target?.closest<HTMLElement>("[data-cell-id]")?.dataset.cellId;
    if (cellId === undefined) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenCell(cellId);
      return;
    }
    if (!isGridKey(event.key)) {
      return;
    }
    event.preventDefault();
    const next = moveInGrid(view.cellIds, cellId, event.key, event.ctrlKey || event.metaKey);
    setFocusedId(next);
    focusMatrixCell(next);
  };

  if (view.tables.length === 0) {
    return (
      <p data-testid="matrix-empty" className="rounded-lg border bg-card p-4 text-sm">
        {view.totalCells === 0
          ? "The run produced no cells: no table with personas was found in the exposed schemas."
          : "No cell has the selected status. Clear the filter to see the whole matrix."}
      </p>
    );
  }

  return (
    // `relative`: the cells hold `sr-only` text, which is absolutely positioned. Without a positioned
    // scroll container that text escapes the clipping and widens the whole page on a phone.
    <div className="relative overflow-x-auto rounded-lg border bg-card">
      <table
        role="grid"
        aria-label="Result matrix: one row per persona and table, one column per operation"
        aria-rowcount={view.visibleRows + view.tables.length + 1}
        aria-colcount={columns}
        data-testid="matrix"
        onKeyDown={onKeyDown}
        className="w-full min-w-[33rem] border-collapse text-sm"
      >
        <thead>
          <tr>
            <th scope="col" className="w-[26%] px-3 py-2 text-left text-xs font-medium">
              Table and persona
            </th>
            {view.operations.map((operation) => (
              <th
                key={operation}
                scope="col"
                className="w-[18%] px-2 py-2 text-left font-mono text-xs font-semibold uppercase"
              >
                {operation}
              </th>
            ))}
          </tr>
        </thead>
        {view.tables.map((table) => (
          <tbody
            key={table.key}
            data-testid="matrix-table-group"
            data-table={table.key}
            data-highlighted={highlightedTable === table.key}
            className={cn(
              highlightedTable === table.key && "outline-2 -outline-offset-2 outline-primary",
            )}
          >
            <TableHeading table={table} columns={columns} />
            {table.rows.map((row) => (
              <tr key={row.personaId} className="border-t">
                <th scope="row" className="px-3 py-1.5 text-left align-top font-normal">
                  <span className="block font-medium">{row.personaLabel}</span>
                  <span className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
                    {row.dbRole}
                    {row.rlsBypass === null ? null : (
                      <span className="inline-flex items-center gap-1 font-sans">
                        <ShieldOff aria-hidden="true" className="size-3" />
                        bypasses RLS ({row.rlsBypass})
                      </span>
                    )}
                  </span>
                </th>
                {row.cells.map((cell, index) =>
                  cell === null ? (
                    <td
                      key={view.operations[index]}
                      role="gridcell"
                      className="px-2 py-1.5 align-top text-xs text-muted-foreground"
                    >
                      No cell
                    </td>
                  ) : (
                    <td
                      key={cell.id}
                      role="gridcell"
                      id={matrixCellDomId(cell.id)}
                      tabIndex={cell.id === tabStop ? 0 : -1}
                      aria-selected={cell.id === selectedCellId}
                      aria-haspopup="dialog"
                      data-testid="matrix-cell"
                      data-cell-id={cell.id}
                      data-status={cell.status}
                      data-persona={row.personaId}
                      data-schema={table.schema}
                      data-table={table.name}
                      data-operation={cell.operation}
                      data-dimmed={!cell.matchesFilter}
                      onClick={() => {
                        setFocusedId(cell.id);
                        onOpenCell(cell.id);
                      }}
                      onFocus={() => setFocusedId(cell.id)}
                      className="cursor-pointer p-1 align-top outline-none focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-ring"
                    >
                      <div
                        className={cn(
                          "rounded-md border px-2 py-1",
                          cellTone(cell),
                          cell.id === selectedCellId && "ring-2 ring-ring",
                        )}
                      >
                        <CellContent cell={cell} />
                      </div>
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
