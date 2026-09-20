/**
 * What the details drawer shows for one cell. Keys arrive as the runner serialises them (a JSON
 * array of the key columns' text); long lists are capped with a count so that a table of ten
 * thousand leaked rows cannot freeze the drawer. Everything here ends up in text nodes.
 */
import {
  isTimeoutFailure,
  parseKey,
  type CellResult,
  type CellStatus,
  type SubProbeResult,
} from "@/lib/runner";
import { statusMeta } from "@/lib/site/status";
import { SUB_PROBE_LABELS } from "./status-meta";

export const KEY_LIST_CAP = 200;

export interface KeyListView {
  readonly total: number;
  readonly shown: readonly string[];
  /** Keys beyond the cap: counted, not rendered. */
  readonly hidden: number;
  /** Every key, one per line, for the copy button (also beyond the cap). */
  readonly copyText: string;
}

/** `["7"]` reads as `7`, `["7","b"]` as `7, b`; anything unexpected is shown as it is. */
export function formatKey(key: string): string {
  try {
    return parseKey(key).join(", ");
  } catch {
    // Not a serialised key: show the raw text.
    return key;
  }
}

export function buildKeyList(keys: readonly string[], cap: number = KEY_LIST_CAP): KeyListView {
  const formatted = keys.map(formatKey);
  return {
    total: keys.length,
    shown: formatted.slice(0, cap),
    hidden: Math.max(0, keys.length - cap),
    copyText: formatted.join("\n"),
  };
}

export interface SubProbeView {
  /** Unique within the cell, although two sub-probes may share a kind. */
  readonly id: string;
  readonly title: string;
  /** What tells two sub-probes of one kind apart: the expectation and the source row. */
  readonly distinction: string;
  readonly probe: SubProbeResult;
  /** This sub-probe ran into the statement timeout: its badge says "Timed out". */
  readonly timedOut: boolean;
  readonly movedKeys: KeyListView;
}

export function buildSubProbeViews(cell: Pick<CellResult, "subProbes">): SubProbeView[] {
  return cell.subProbes.map((probe, index) => {
    const source = probe.sourceKey === null ? "no source row" : `row ${formatKey(probe.sourceKey)}`;
    return {
      id: `${index}-${probe.kind}`,
      title: SUB_PROBE_LABELS[probe.kind],
      distinction: `must be ${probe.expected}, ${source}`,
      probe,
      timedOut: probe.error !== null && isTimeoutFailure(probe.error),
      movedKeys: buildKeyList(probe.movedKeys),
    };
  });
}

export interface CellKeyLists {
  readonly expected: KeyListView;
  readonly actual: KeyListView;
  readonly leaked: KeyListView;
  readonly missing: KeyListView;
  readonly blind: KeyListView;
}

export function buildCellKeyLists(cell: CellResult): CellKeyLists {
  return {
    expected: buildKeyList(cell.expectedKeys),
    actual: buildKeyList(cell.actualKeys),
    leaked: buildKeyList(cell.leakedKeys),
    missing: buildKeyList(cell.missingKeys),
    blind: buildKeyList(cell.blindKeys),
  };
}

/** Every script of the cell, in order: the reach probe, then each sub-probe. For "copy all". */
export function cellTranscript(cell: CellResult): string {
  const parts = [cell.sql, ...cell.subProbes.map((probe) => probe.sql)];
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}

/** The word a timed-out cell carries instead of "Inconclusive". The status stays `inconclusive`. */
export const TIMED_OUT_LABEL = "Timed out";

const TIMED_OUT_MEANINGS = {
  reach:
    "The statement did not come back within the statement timeout, so the database was terminated and rebuilt. Nothing was measured: the rows listed as missing were never looked for. It counts neither as a pass nor as a leak.",
  "sub-probe":
    "A sub-probe did not come back within the statement timeout, so the database was terminated and rebuilt. What ran before it was measured; the cell as a whole counts neither as a pass nor as a leak.",
} as const;

/**
 * Which statement of an inconclusive cell ran into the timeout: the reach probe, a sub-probe, or
 * none (`null`). A cell with another status was measured, whatever a sub-probe did afterwards.
 */
export function cellTimeout(
  cell: Pick<CellResult, "status" | "error" | "subProbes">,
): keyof typeof TIMED_OUT_MEANINGS | null {
  if (cell.status !== "inconclusive") return null;
  if (cell.error !== null && isTimeoutFailure(cell.error)) return "reach";
  const timedOut = cell.subProbes.some(
    (probe) => probe.error !== null && isTimeoutFailure(probe.error),
  );
  return timedOut ? "sub-probe" : null;
}

export interface CellStatusView {
  readonly status: CellStatus;
  readonly timedOut: boolean;
  /** The word next to the icon, in the grid, in the drawer and for a screen reader. */
  readonly label: string;
  readonly meaning: string;
}

/** A timed-out probe gets its own words: "Inconclusive, 1 missing" would claim a measurement. */
export function cellStatusView(
  cell: Pick<CellResult, "status" | "error" | "subProbes">,
): CellStatusView {
  const timeout = cellTimeout(cell);
  const meta = statusMeta(cell.status);
  return timeout === null
    ? { status: cell.status, timedOut: false, label: meta.label, meaning: meta.meaning }
    : {
        status: cell.status,
        timedOut: true,
        label: TIMED_OUT_LABEL,
        meaning: TIMED_OUT_MEANINGS[timeout],
      };
}
