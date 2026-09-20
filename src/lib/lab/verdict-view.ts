/**
 * The verdict banner's content. The verdict and the counts come from the runner (P1); this only
 * words them. `verdictAnnouncement` is what the polite live region reads out.
 */
import { CELL_STATUSES, type CellStatus, type MatrixResult, type Verdict } from "@/lib/runner";
import type { RunState } from "./state";
import { verdictMeta } from "@/lib/site/status";

export interface VerdictCount {
  readonly status: CellStatus;
  readonly count: number;
  readonly label: string;
}

export interface VerdictView {
  readonly verdict: Verdict;
  readonly description: string;
  /** `leak` and `escape`: the kinds that decide LEAKING. Zero counts included. */
  readonly deciding: readonly VerdictCount[];
  /** Everything else that occurred, reported beside the verdict. */
  readonly beside: readonly VerdictCount[];
  readonly totalCells: number;
  /** The result alone. What the live region says also depends on the run: `verdictAnnouncement`. */
  readonly announcement: string;
}

function plural(count: number, word: string): string {
  if (count === 1) {
    return `1 ${word}`;
  }
  return `${count} ${word.endsWith("s") ? `${word}es` : `${word}s`}`;
}

const NOUNS: Readonly<Record<CellStatus, string>> = {
  pass: "pass",
  leak: "leak",
  escape: "escape",
  overblock: "overblock",
  inconclusive: "inconclusive cell",
  skipped: "skipped cell",
};

/** "3 escapes", "1 leak", "12 passes", "2 skipped cells". */
export function countPhrase(status: CellStatus, count: number): string {
  return plural(count, NOUNS[status]);
}

export function buildVerdictView(result: MatrixResult): VerdictView {
  const toCount = (status: CellStatus): VerdictCount => ({
    status,
    count: result.counts[status],
    label: countPhrase(status, result.counts[status]),
  });
  const deciding = (["leak", "escape"] as const).map(toCount);
  const beside = CELL_STATUSES.filter(
    (status) => status !== "leak" && status !== "escape" && result.counts[status] > 0,
  ).map(toCount);
  const failing = deciding.filter((entry) => entry.count > 0).map((entry) => entry.label);
  const parts = [
    `Verdict: ${result.verdict}.`,
    failing.length > 0 ? `${failing.join(", ")}.` : "",
    beside.length > 0 ? `${beside.map((entry) => entry.label).join(", ")}.` : "",
    `${plural(result.totalCells, "cell")} in total.`,
  ];
  return {
    verdict: result.verdict,
    description: verdictMeta(result.verdict).rule,
    deciding,
    beside,
    totalCells: result.totalCells,
    announcement: parts.filter((part) => part !== "").join(" "),
  };
}

/** One line for the run in progress or the run that did not produce a result. */
export function runStatusText(run: RunState): string {
  switch (run.status) {
    case "idle":
      return "Not run yet.";
    case "setting-up":
      return run.purpose === "introspect"
        ? "Introspecting: starting Postgres in this tab, running schema and seed."
        : "Setting up: starting Postgres in this tab, running schema and seed.";
    case "running":
      return `Running probes: ${run.done} of ${run.total} cells.`;
    case "done":
      return "Run finished.";
    case "cancelled":
      return "Run cancelled. Nothing was proven.";
    case "failed":
      return run.reason === "setup"
        ? "The run stopped during setup: a statement of the scenario's SQL failed."
        : run.message;
  }
}

/**
 * The one sentence of the verdict banner's live region. A screen reader hears nothing else of the
 * banner, so whatever qualifies the verdict on screen has to be in here: a result that is left
 * over from the run before a cancelled one, and a result the scenario has moved away from.
 */
export function verdictAnnouncement(
  run: RunState,
  result: MatrixResult | null,
  stale: boolean,
): string {
  if (run.status === "running") {
    // Progress is not announced cell by cell: a live region that changes 60 times is noise.
    return "Running probes.";
  }
  if (run.status === "setting-up" || run.status === "failed" || result === null) {
    return runStatusText(run);
  }
  const parts = [
    run.status === "cancelled" ? "Run cancelled. The result is from the run before it." : "",
    buildVerdictView(result).announcement,
    stale ? "The scenario changed after this run; run again." : "",
  ];
  return parts.filter((part) => part !== "").join(" ");
}
