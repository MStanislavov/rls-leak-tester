"use client";

/** The chips over the matrix: one per status that occurs, each a toggle of the status filter. */
import { STATUS_CLASSES, STATUS_ICONS } from "@/components/site/status-badge";
import { Button } from "@/components/ui/button";
import { statusChips } from "@/lib/lab";
import type { CellStatus } from "@/lib/runner";
import { statusMeta } from "@/lib/site/status";
import { cn } from "@/lib/utils";

export function StatusFilter({
  counts,
  active,
  onToggle,
  onClear,
}: {
  readonly counts: Readonly<Record<CellStatus, number>>;
  /** The statuses the matrix is filtered to; empty shows every cell. */
  readonly active: readonly CellStatus[];
  readonly onToggle: (status: CellStatus) => void;
  readonly onClear: () => void;
}) {
  return (
    <fieldset
      aria-label="Filter cells by status"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {statusChips(counts).map(({ status, count }) => {
        const Icon = STATUS_ICONS[status];
        const pressed = active.includes(status);
        return (
          <button
            key={status}
            type="button"
            aria-pressed={pressed}
            data-testid="status-chip"
            data-status={status}
            data-count={count}
            onClick={() => onToggle(status)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium",
              STATUS_CLASSES[status],
              pressed && "ring-2 ring-ring",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {statusMeta(status).label}
            <span className="font-mono">{count}</span>
          </button>
        );
      })}
      {active.length === 0 ? null : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="status-chip-clear"
          onClick={onClear}
        >
          Show all
        </Button>
      )}
    </fieldset>
  );
}
