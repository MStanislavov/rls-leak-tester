/**
 * The outcome classifier (brief 3.5). Pure set arithmetic and one table of SQLSTATEs; no SQL runs
 * here and nothing here can be talked into a verdict (P1).
 *
 *   leaked  = actual minus expected        missing = expected minus actual
 *
 *   leak          leaked is not empty: the persona reads or writes rows it must not reach
 *   escape        a scope-escape update or an out-of-scope insert went through
 *   inconclusive  a statement failed for a reason that is not authorization
 *   overblock     only missing is not empty: a usability bug, not an isolation failure
 *   pass          none of the above
 *
 * Precedence when several apply, most serious first: leak, escape, inconclusive, overblock, pass.
 * A proven leak stays a leak even if another part of the cell was inconclusive; an inconclusive
 * part hides an overblock, because a cell that could not be measured completely must never read
 * as "only a usability problem".
 *
 * SQLSTATE 42501 (a policy violation and a missing privilege alike) means BLOCKED. Every other
 * error, the constraint errors 23505, 23503, 23502 and 23514 included, is inconclusive: shown,
 * and never counted as a pass or as a leak.
 *
 * One exception, because "blocked" is a claim about the probed ROWS: a 42501 that is about
 * something else says nothing about them and is inconclusive. Measured on PostgreSQL 18.3:
 *
 *   permission denied for schema private        a cast in the probe named a type the role cannot look up
 *   permission denied for type / sequence ...   the same kind of thing: an object beside the table
 *   query would be affected by row-level        `row_security = off` was left in the session; the
 *     security policy for table "t"             statement never ran
 *
 * What stays blocked: `permission denied for table|view|...` (table and column privileges, which
 * Postgres reports alike), `permission denied for function` (a policy calls a function the role
 * may not execute, so the role really is locked out), `new row violates row-level security
 * policy`, and a 42501 with any other text, such as one a trigger raises to refuse the write.
 */
import { compareText } from "@/lib/scenario";
import {
  CELL_STATUSES,
  type CellStatus,
  type ProbeFailure,
  type StatusCounts,
  type SubProbeOutcome,
  type SubProbeResult,
  type Verdict,
} from "./result";
import { EngineError, SQLSTATE_INSUFFICIENT_PRIVILEGE, SqlError } from "./types";

/** Unique keys in code-unit order: the one order of keys in a result. */
export function sortKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort(compareText);
}

export interface KeyDiff {
  readonly leakedKeys: string[];
  readonly missingKeys: string[];
}

export function diffKeys(expected: readonly string[], actual: readonly string[]): KeyDiff {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    leakedKeys: sortKeys(actual.filter((key) => !expectedSet.has(key))),
    missingKeys: sortKeys(expected.filter((key) => !actualSet.has(key))),
  };
}

/** What a thrown error becomes in a result. An engine failure has no SQLSTATE. */
export function toProbeFailure(error: unknown): ProbeFailure {
  if (error instanceof SqlError) {
    return { sqlState: error.code, message: error.message };
  }
  return { sqlState: null, message: error instanceof Error ? error.message : String(error) };
}

/**
 * 42501 texts that are not about the probed rows, see the header. Postgres messages, lc_messages C.
 * The three patterns are exported because the CI export embeds them in its SQL (`\b` becomes `\y`
 * there), so that it reads a 42501 exactly as this module does.
 */
export const NOT_ABOUT_THE_ROWS =
  /^(permission denied for (schema|type|sequence|language|database|tablespace|foreign-data wrapper|foreign server|large object|parameter)\b|query would be affected by row-level security policy)/;

/** A 42501 that one row caused, see `isRowSecurityViolation`. */
export const ROW_SECURITY_VIOLATION = /violates row-level security policy/;

/** A 42501 about the statement as a whole, see `isStatementDenial`. */
export const STATEMENT_DENIAL =
  /^(permission denied for |query would be affected by row-level security policy)/;

/** `true` when the failure means "Postgres refused this for lack of authorization". */
export function isBlocked(failure: ProbeFailure): boolean {
  return (
    failure.sqlState === SQLSTATE_INSUFFICIENT_PRIVILEGE &&
    !NOT_ABOUT_THE_ROWS.test(failure.message)
  );
}

/**
 * A 42501 that one ROW caused (`new row violates row-level security policy ...`): other rows may
 * fare differently, so reach is measured row by row. Every other 42501 (a missing privilege) is
 * about the statement and would fail identically for every row.
 */
export function isRowSecurityViolation(failure: ProbeFailure): boolean {
  return (
    failure.sqlState === SQLSTATE_INSUFFICIENT_PRIVILEGE &&
    ROW_SECURITY_VIOLATION.test(failure.message)
  );
}

/**
 * A 42501 about the statement as a whole: a missing privilege (Postgres checks privileges before
 * it looks at a row) or `row_security = off`. It fails identically for every row, so measuring row
 * by row would only repeat the error. A 42501 with any other text (a policy violation, a
 * trigger's own refusal) can depend on the row.
 */
export function isStatementDenial(failure: ProbeFailure): boolean {
  return (
    failure.sqlState === SQLSTATE_INSUFFICIENT_PRIVILEGE && STATEMENT_DENIAL.test(failure.message)
  );
}

/** SQLSTATE class 22 (data exception): the value does not fit the column's type. */
export function isDataException(failure: ProbeFailure): boolean {
  return failure.sqlState?.startsWith("22") === true;
}

/** `true` when the database is gone (timeout, terminated worker) and setup must be replayed. */
export function isDatabaseLost(error: unknown): boolean {
  return error instanceof EngineError && error.databaseLost;
}

export function outcomeOfFailure(
  failure: ProbeFailure,
): Extract<SubProbeOutcome, "blocked" | "inconclusive"> {
  return isBlocked(failure) ? "blocked" : "inconclusive";
}

/** A sub-probe's status from what isolation demands and what happened. */
export function classifySubProbe(
  expected: SubProbeResult["expected"],
  outcome: SubProbeOutcome,
): SubProbeResult["status"] {
  if (outcome === "skipped" || outcome === "inconclusive") {
    return outcome;
  }
  if (outcome === expected) {
    return "pass";
  }
  return outcome === "allowed" ? "escape" : "overblock";
}

export interface CellEvidence {
  readonly leakedKeys: readonly string[];
  readonly missingKeys: readonly string[];
  /** A statement of the reach probe failed with something other than 42501. */
  readonly inconclusive: boolean;
  readonly subProbes: readonly Pick<SubProbeResult, "status">[];
}

/** The status of a cell whose reach probe ran. Skipped sub-probes never change it. */
export function classifyCell(evidence: CellEvidence): Exclude<CellStatus, "skipped"> {
  const has = (status: SubProbeResult["status"]): boolean =>
    evidence.subProbes.some((probe) => probe.status === status);
  if (evidence.leakedKeys.length > 0) {
    return "leak";
  }
  if (has("escape")) {
    return "escape";
  }
  if (evidence.inconclusive || has("inconclusive")) {
    return "inconclusive";
  }
  if (evidence.missingKeys.length > 0 || has("overblock")) {
    return "overblock";
  }
  return "pass";
}

/**
 * The status of an insert cell, which has sub-probes only (one per scope class). With every class
 * skipped nothing was measured, so the cell is skipped too.
 */
export function classifyInsertCell(
  subProbes: readonly Pick<SubProbeResult, "status">[],
): CellStatus {
  if (subProbes.every((probe) => probe.status === "skipped")) {
    return "skipped";
  }
  return classifyCell({ leakedKeys: [], missingKeys: [], inconclusive: false, subProbes });
}

export function countStatuses(cells: readonly { readonly status: CellStatus }[]): StatusCounts {
  const counts: Record<CellStatus, number> = {
    pass: 0,
    leak: 0,
    escape: 0,
    overblock: 0,
    inconclusive: 0,
    skipped: 0,
  };
  for (const cell of cells) {
    counts[cell.status] += 1;
  }
  return counts;
}

/**
 * ISOLATED needs evidence: at least one cell that was really measured. With no cells, or with
 * every cell skipped or inconclusive, nothing was proven. Overblocks do not change the verdict.
 */
export function verdictOf(counts: StatusCounts): Verdict {
  if (counts.leak > 0 || counts.escape > 0) {
    return "LEAKING";
  }
  const measured = counts.pass + counts.overblock;
  return measured > 0 ? "ISOLATED" : "NOT PROVEN";
}

/** Guards the precedence list above against a status that was added without a decision. */
export const STATUS_SEVERITY: readonly CellStatus[] = [
  "leak",
  "escape",
  "inconclusive",
  "overblock",
  "pass",
  "skipped",
] satisfies readonly (typeof CELL_STATUSES)[number][];
