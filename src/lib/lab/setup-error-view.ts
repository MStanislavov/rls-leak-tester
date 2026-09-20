/**
 * What the lab shows when the user's SQL fails during setup (brief 3.3): the phase, SQLSTATE,
 * message, the statement and the line to mark in the editor. Plain data, rendered as text.
 */
import { splitSqlStatements, type Scenario } from "@/lib/scenario";
import type { SetupError, SetupPhase } from "@/lib/runner/setup";
import type { SqlKind } from "./scenario-edit";

export interface SetupErrorView {
  readonly phase: SetupPhase;
  /** The editor that holds the statement; `null` for the product's own SQL (shim, grants). */
  readonly editor: SqlKind | null;
  readonly sqlState: string | null;
  readonly message: string;
  readonly detail: string | null;
  readonly hint: string | null;
  readonly statement: string;
  /** One-based line of the statement's first token in its script. */
  readonly statementLine: number;
  /** One-based line Postgres points at (`position`), else the statement's first line. */
  readonly errorLine: number;
  /** `true` when the statement never answered and the database was terminated. */
  readonly timedOut: boolean;
}

function editorOf(phase: SetupPhase): SqlKind | null {
  if (phase === "schema" || phase === "seed") {
    return phase;
  }
  return null;
}

function lineOfPosition(statement: string, line: number, position: number | undefined): number {
  if (position === undefined || position < 1) {
    return line;
  }
  const before = statement.slice(0, position - 1);
  return line + (before.split("\n").length - 1);
}

export function toSetupErrorView(error: SetupError): SetupErrorView {
  return {
    phase: error.phase,
    editor: editorOf(error.phase),
    sqlState: error.sqlState,
    message: error.message,
    detail: error.detail ?? null,
    hint: error.hint ?? null,
    statement: error.statement,
    statementLine: error.line,
    errorLine: lineOfPosition(error.statement, error.line, error.position),
    timedOut: false,
  };
}

/**
 * A statement of the user's SQL that never came back: the engine only says "timed out", so the
 * statement is found by its text. Setup runs the schema script and then the seed script, each in
 * order, so the n-th execution of a text is its n-th occurrence (`occurrence` is zero-based).
 * `null` when the text is not the user's (the shim, the grants).
 */
export function locateTimedOutStatement(
  scenario: Pick<Scenario, "schemaSql" | "seedSql">,
  statementText: string,
  occurrence: number,
  timeoutMs: number,
): SetupErrorView | null {
  const candidates = (["schema", "seed"] as const).flatMap((phase) =>
    splitSqlStatements(phase === "schema" ? scenario.schemaSql : scenario.seedSql)
      .filter((statement) => statement.text === statementText)
      .map((statement) => ({ phase, statement })),
  );
  const found = candidates[occurrence] ?? candidates.at(-1);
  if (found === undefined) {
    return null;
  }
  return {
    phase: found.phase,
    editor: found.phase,
    sqlState: null,
    message: `This statement did not finish within ${timeoutMs} ms. The database was terminated; nothing was tested.`,
    detail: null,
    hint: "A statement that sleeps, loops or locks cannot be cancelled inside the browser database, only cut off.",
    statement: found.statement.text,
    statementLine: found.statement.line,
    errorLine: found.statement.line,
    timedOut: true,
  };
}
