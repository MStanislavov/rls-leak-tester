/**
 * Keyboard navigation of the result grid (WAI-ARIA grid pattern): arrows move one cell, Home and
 * End go to the ends of the row, Ctrl+Home and Ctrl+End to the corners of the grid, Page Up and
 * Page Down jump five rows. A hole in the grid (a cell the runner did not produce) is stepped
 * over in the direction of travel; when nothing lies beyond it the focus stays where it is.
 */
export const GRID_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;
export type GridKey = (typeof GRID_KEYS)[number];

export const PAGE_ROWS = 5;

export interface GridPosition {
  readonly row: number;
  readonly col: number;
}

export type GridCells = readonly (readonly (string | null)[])[];

export function isGridKey(key: string): key is GridKey {
  return (GRID_KEYS as readonly string[]).includes(key);
}

export function positionOf(cells: GridCells, cellId: string | null): GridPosition | null {
  if (cellId === null) {
    return null;
  }
  for (const [row, ids] of cells.entries()) {
    const col = ids.indexOf(cellId);
    if (col !== -1) {
      return { row, col };
    }
  }
  return null;
}

export function cellAt(cells: GridCells, position: GridPosition): string | null {
  return cells[position.row]?.[position.col] ?? null;
}

/** The first cell of the grid: where Tab lands when nothing was focused before. */
export function firstCell(cells: GridCells): string | null {
  for (const row of cells) {
    for (const id of row) {
      if (id !== null) {
        return id;
      }
    }
  }
  return null;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function target(
  cells: GridCells,
  from: GridPosition,
  key: GridKey,
  ctrl: boolean,
): { start: GridPosition; step: GridPosition } {
  const lastRow = cells.length - 1;
  const lastCol = (cells[from.row]?.length ?? 1) - 1;
  switch (key) {
    case "ArrowUp":
      return { start: { row: from.row - 1, col: from.col }, step: { row: -1, col: 0 } };
    case "ArrowDown":
      return { start: { row: from.row + 1, col: from.col }, step: { row: 1, col: 0 } };
    case "ArrowLeft":
      return { start: { row: from.row, col: from.col - 1 }, step: { row: 0, col: -1 } };
    case "ArrowRight":
      return { start: { row: from.row, col: from.col + 1 }, step: { row: 0, col: 1 } };
    case "Home":
      return { start: { row: ctrl ? 0 : from.row, col: 0 }, step: { row: 0, col: 1 } };
    case "End":
      return {
        start: {
          row: ctrl ? lastRow : from.row,
          col: ctrl ? (cells[lastRow]?.length ?? 1) - 1 : lastCol,
        },
        step: { row: 0, col: -1 },
      };
    case "PageUp":
      return {
        start: { row: clamp(from.row - PAGE_ROWS, lastRow), col: from.col },
        step: { row: 1, col: 0 },
      };
    case "PageDown":
      return {
        start: { row: clamp(from.row + PAGE_ROWS, lastRow), col: from.col },
        step: { row: -1, col: 0 },
      };
  }
}

/** The cell id the focus moves to; the current one when the move leads nowhere. */
export function moveInGrid(
  cells: GridCells,
  currentId: string,
  key: GridKey,
  ctrl = false,
): string {
  const from = positionOf(cells, currentId);
  if (from === null) {
    return firstCell(cells) ?? currentId;
  }
  const { start, step } = target(cells, from, key, ctrl);
  let position = start;
  while (
    position.row >= 0 &&
    position.row < cells.length &&
    position.col >= 0 &&
    position.col < (cells[position.row]?.length ?? 0)
  ) {
    const id = cellAt(cells, position);
    if (id !== null) {
      return id;
    }
    position = { row: position.row + step.row, col: position.col + step.col };
  }
  return currentId;
}
