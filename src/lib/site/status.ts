/**
 * The words the UI uses for a cell status and for a verdict. One table for the matrix, the legend
 * and the /docs page, so they cannot drift. A status is never shown by colour alone: the badge
 * component pairs the `label` from here with an icon (brief 3.3).
 */
import type { CellStatus, Verdict } from "@/lib/runner";

/** How a status counts towards the verdict (brief 3.5, "Verdict"). */
export type VerdictEffect = "proves" | "fails" | "none";

export interface StatusMeta {
  readonly status: CellStatus;
  /** The word shown next to the icon. */
  readonly label: string;
  /** One sentence: what the runner observed. */
  readonly meaning: string;
  /** `fails` makes the verdict LEAKING, `proves` counts towards ISOLATED, `none` does neither. */
  readonly verdictEffect: VerdictEffect;
}

const STATUS_TABLE: Record<CellStatus, Omit<StatusMeta, "status">> = {
  pass: {
    label: "Pass",
    meaning: "The persona reached exactly the rows the expectation names, no more and no fewer.",
    verdictEffect: "proves",
  },
  leak: {
    label: "Leak",
    meaning:
      "The persona read or changed at least one row outside the expected set. The leaked keys are listed.",
    verdictEffect: "fails",
  },
  escape: {
    label: "Escape",
    meaning:
      "A write put a row outside the persona's scope: an update moved a row to another tenant or owner, or an out-of-scope insert went through.",
    verdictEffect: "fails",
  },
  overblock: {
    label: "Overblock",
    meaning:
      "Nothing leaked, but rows the persona should reach were blocked. A usability bug, not an isolation failure.",
    verdictEffect: "proves",
  },
  inconclusive: {
    label: "Inconclusive",
    meaning:
      "The probe failed for a reason that is not authorization (a constraint, a timeout, an engine error). It counts neither as a pass nor as a leak.",
    verdictEffect: "none",
  },
  skipped: {
    label: "Skipped",
    meaning: "The probe could not be built or does not apply. The reason is shown with the cell.",
    verdictEffect: "none",
  },
};

/** Display order: the order of `CELL_STATUSES` in the runner. */
const STATUS_ORDER: readonly CellStatus[] = [
  "pass",
  "leak",
  "escape",
  "overblock",
  "inconclusive",
  "skipped",
];

export const STATUS_META: readonly StatusMeta[] = STATUS_ORDER.map((status) => ({
  status,
  ...STATUS_TABLE[status],
}));

export function statusMeta(status: CellStatus): StatusMeta {
  return { status, ...STATUS_TABLE[status] };
}

export interface VerdictMeta {
  readonly verdict: Verdict;
  /** One sentence: the rule that produces this verdict. */
  readonly rule: string;
}

const VERDICT_TABLE: Record<Verdict, string> = {
  ISOLATED:
    "No cell is a leak or an escape, and at least one cell was actually measured (pass or overblock).",
  LEAKING: "At least one cell is a leak or an escape. The counts by kind are shown beside it.",
  "NOT PROVEN":
    "No cell is a leak or an escape, but every cell was skipped or inconclusive, so nothing was measured. Never reported as ISOLATED.",
};

const VERDICT_ORDER: readonly Verdict[] = ["ISOLATED", "LEAKING", "NOT PROVEN"];

export const VERDICT_META: readonly VerdictMeta[] = VERDICT_ORDER.map((verdict) => ({
  verdict,
  rule: VERDICT_TABLE[verdict],
}));

export function verdictMeta(verdict: Verdict): VerdictMeta {
  return { verdict, rule: VERDICT_TABLE[verdict] };
}
