import type { CellStatus } from "@/lib/runner";
import { OPERATIONS } from "@/lib/scenario";
import { StatusBadge, VerdictBadge } from "./status-badge";

interface IllustrationRow {
  readonly persona: string;
  readonly role: string;
  /** One status per operation, in the order of `OPERATIONS`. */
  readonly cells: readonly [CellStatus, CellStatus, CellStatus, CellStatus];
}

/** Made up to show all six statuses at once. Not the output of a run, and the caption says so. */
const ROWS: readonly IllustrationRow[] = [
  { persona: "visitor", role: "anon", cells: ["pass", "pass", "pass", "pass"] },
  { persona: "alice", role: "authenticated", cells: ["pass", "pass", "escape", "pass"] },
  { persona: "bob", role: "authenticated", cells: ["leak", "pass", "escape", "overblock"] },
  { persona: "backend", role: "service_role", cells: ["pass", "skipped", "pass", "inconclusive"] },
];

/** A static picture of a result matrix, built from a plain table: icon and word in every cell. */
export function MatrixIllustration() {
  return (
    <figure className="rounded-xl border bg-card text-card-foreground shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <p className="font-mono text-sm">
          <span className="text-muted-foreground">table</span> public.projects
        </p>
        <VerdictBadge verdict="LEAKING" />
      </div>
      <div
        role="region"
        aria-label="Example result matrix"
        tabIndex={0}
        className="overflow-x-auto px-2 py-2"
      >
        <table className="w-full border-separate border-spacing-1.5 text-left text-sm">
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-xs font-medium text-muted-foreground">
                Persona
              </th>
              {OPERATIONS.map((operation) => (
                <th
                  key={operation}
                  scope="col"
                  className="px-1 py-1 font-mono text-xs font-medium text-muted-foreground uppercase"
                >
                  {operation}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.persona}>
                <th scope="row" className="px-2 py-1 font-normal whitespace-nowrap">
                  <span className="font-medium">{row.persona}</span>{" "}
                  <span className="font-mono text-xs text-muted-foreground">{row.role}</span>
                </th>
                {row.cells.map((status, index) => (
                  <td key={OPERATIONS[index]}>
                    <StatusBadge status={status} size="sm" className="w-full justify-start" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="border-t px-4 py-3 text-xs text-muted-foreground">
        Illustration, not a live result. 1 leak and 2 escapes make the verdict LEAKING; the
        overblock, the inconclusive and the skipped cell are reported beside it and do not change
        it.
      </figcaption>
    </figure>
  );
}
