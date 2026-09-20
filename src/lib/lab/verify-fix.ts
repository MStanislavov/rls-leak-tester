/**
 * The verified-fix loop (brief 3.2 and 3.7, rules.yaml AI-002), the part that decides.
 *
 * The model proposes SQL. Nothing here trusts it: `applyProposedFix` puts the SQL into a COPY of
 * the scenario, the lab re-runs the whole matrix on a fresh database, and `compareRuns` reads the
 * two results. "Verified" is a statement about cells the engine measured twice, never about what
 * the model said. Both functions are pure.
 *
 * The re-run can only judge SQL that changes the ACCESS RULES. The proposal runs before the seed,
 * so a trigger, a rule, a column default or a changed function could rewrite the DATA until the
 * leaky policy looks right (every row public, every row the caller's own) and the matrix would
 * pass. The text the model reads is untrusted (a shared scenario can carry instructions), so the
 * prompt's "policy statements only" is enforced here, deterministically: `applyProposedFix`
 * refuses every statement `unexpectedStatements` names, and such a proposal is never re-run,
 * never verified and never applied.
 *
 * `compareRuns` says `verified` only when
 *   - the re-run finished (no setup error, not cancelled, no ceiling, no engine failure),
 *   - every target cell failed before and is `pass` now, and
 *   - no other cell regressed: a cell that passed must still pass (it must still exist, too), a
 *     cell that was not an isolation failure must not have become a `leak` or an `escape`, a cell
 *     that leaked must not leak more rows, and a cell that did not exist before must not fail.
 * Cells that failed before and still fail, and are no targets, are reported beside a verified
 * fix: the fix is verified for its cell, the scenario may still be LEAKING.
 */
import type { CellResult, CellStatus, MatrixResult, Verdict } from "@/lib/runner";
import { parseScenario, splitSqlStatements, type Operation, type Scenario } from "@/lib/scenario";
import type { LabRunOptions, LabRunOutcome } from "./run-lab";
import type { SetupErrorView } from "./setup-error-view";
import { formatIssue } from "./validation";

/** The line that separates the user's schema from the appended SQL, in the copy and when applied. */
export const FIX_COMMENT = "-- Proposed policy fix from Explain, appended after the schema above.";

const SENTINEL = "select 1";

/** The statuses Explain is offered on: failures the engine proved. */
const PROVEN_FAILURES: ReadonlySet<CellStatus> = new Set<CellStatus>([
  "leak",
  "escape",
  "overblock",
]);
const ISOLATION_FAILURES: ReadonlySet<CellStatus> = new Set<CellStatus>(["leak", "escape"]);

export type ApplyFixResult =
  | {
      readonly ok: true;
      /** A copy; the scenario that was passed in is untouched. It passed `parseScenario`. */
      readonly scenario: Scenario;
      /** How many statements the proposal holds. */
      readonly statementCount: number;
    }
  | {
      readonly ok: false;
      /**
       * `empty`: no statement to run. `unexpected`: a statement outside the allow-list.
       * `invalid`: the copy is no valid scenario (too long).
       */
      readonly reason: "empty" | "unexpected" | "invalid";
      readonly message: string;
    };

/** `true` when the script's last statement has no terminator of its own. */
function needsTerminator(sql: string): boolean {
  // The splitter knows strings, comments and dollar quotes; asking it beats looking for ";".
  return splitSqlStatements(`${sql}\n${SENTINEL}`).at(-1)?.text !== SENTINEL;
}

/** Pure: `schemaSql` with the proposal appended, so it runs after the user's schema. */
export function appendFixSql(schemaSql: string, proposedPolicySql: string): string {
  const base = schemaSql.trimEnd();
  const terminated = base === "" || !needsTerminator(base) ? base : `${base}\n;`;
  const separator = terminated === "" ? "" : "\n\n";
  return `${terminated}${separator}${FIX_COMMENT}\n${proposedPolicySql.trim()}\n`;
}

/**
 * What the model was asked for (`src/lib/ai/prompt.ts`), and all a proposal may hold: policy
 * statements, GRANT, REVOKE, and ALTER TABLE only to ENABLE or FORCE row level security. Every
 * other ALTER TABLE (DISABLE ROW LEVEL SECURITY, DISABLE TRIGGER, a column default, DROP COLUMN,
 * RENAME, OWNER TO) changes what the matrix measures instead of who may reach it.
 */
const EXPECTED_HEAD = /^(create\s+policy|drop\s+policy|alter\s+policy|grant|revoke)\b/i;
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[a-z_\u0080-\uffff][\w$\u0080-\uffff]*)`;
const RLS_ACTION = String.raw`(?:enable|force)\s+row\s+level\s+security`;
/** The whole statement, not its head: `ENABLE ROW LEVEL SECURITY, DISABLE TRIGGER ALL` is refused. */
const ALTER_TABLE_RLS = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${IDENT}(?:\s*\.\s*${IDENT})?(?:\s*\*)?\s+${RLS_ACTION}(?:\s*,\s*${RLS_ACTION})*$`,
  "i",
);
const LEADING_COMMENTS = /^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/;
const HEAD_WORDS = 3;

/** Pure: the first words of every statement that is none of the allowed kinds. */
export function unexpectedStatements(proposedPolicySql: string): string[] {
  return splitSqlStatements(proposedPolicySql)
    .map((statement) => statement.text.replace(LEADING_COMMENTS, ""))
    .filter((text) => !EXPECTED_HEAD.test(text) && !ALTER_TABLE_RLS.test(text))
    .map((text) => text.split(/\s+/).slice(0, HEAD_WORDS).join(" "));
}

/**
 * Pure: a COPY of `scenario` whose schema ends with the proposed SQL (DROP POLICY, CREATE POLICY,
 * ALTER ... statements run after everything the user wrote, and before the seed). A proposal
 * with a statement outside the allow-list is refused: see the file comment.
 */
export function applyProposedFix(scenario: Scenario, proposedPolicySql: string): ApplyFixResult {
  const statementCount = splitSqlStatements(proposedPolicySql).length;
  if (statementCount === 0) {
    return {
      ok: false,
      reason: "empty",
      message: "The model proposed no SQL change, so there is nothing to re-test.",
    };
  }
  const unexpected = unexpectedStatements(proposedPolicySql);
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: "unexpected",
      message: `The proposal holds statements other than CREATE, DROP or ALTER POLICY, GRANT, REVOKE and ALTER TABLE ... ENABLE or FORCE ROW LEVEL SECURITY (${unexpected.join("; ")}). Such SQL can change the data the matrix measures instead of the access rules, so it was not re-run and cannot be verified.`,
    };
  }
  const parsed = parseScenario({
    ...scenario,
    schemaSql: appendFixSql(scenario.schemaSql, proposedPolicySql),
  });
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "invalid",
      message: `With the proposed SQL the scenario is not valid: ${parsed.issues.map(formatIssue).join("; ")}`,
    };
  }
  return { ok: true, scenario: parsed.scenario, statementCount };
}

export interface CellChange {
  readonly id: string;
  readonly personaId: string;
  readonly schema: string;
  readonly table: string;
  readonly operation: Operation;
  /** `null`: the cell did not exist in the run before. */
  readonly before: CellStatus | null;
  /** `null`: the cell no longer exists (its table, its persona or its schema is gone). */
  readonly after: CellStatus | null;
  /** Rows the cell reached beyond its scope, before and after. */
  readonly leakedBefore: number;
  readonly leakedAfter: number;
}

export type FixVerification =
  | {
      readonly kind: "verified";
      /** The target cells: they failed, now they pass. */
      readonly fixed: readonly CellChange[];
      /** Other cells that failed before and pass now. */
      readonly alsoFixed: readonly CellChange[];
      /** Other cells that failed before and still fail: not caused by the fix, not solved by it. */
      readonly remaining: readonly CellChange[];
      readonly verdictBefore: Verdict;
      readonly verdictAfter: Verdict;
    }
  | {
      readonly kind: "did-not-pass";
      /** Target cells that are not `pass` after the re-run. */
      readonly stillFailing: readonly CellChange[];
      /** Other cells the proposal made worse. */
      readonly regressed: readonly CellChange[];
      /** Set when the SQL did not even apply; the cell lists are empty then. */
      readonly setupError: SetupErrorView | null;
      /** `null` with a setup error: there was no run to give a verdict. */
      readonly verdictAfter: Verdict | null;
    }
  | {
      /** The re-run did not finish, so nothing is known. Never shown as a fix. */
      readonly kind: "incomplete";
      readonly reason: "cancelled" | "ceiling" | "engine" | "no-target" | "not-applied";
      readonly message: string;
    };

/** `cell` names the change: the cell of whichever run has it. */
function changeOf(
  cell: CellResult,
  before: CellResult | undefined,
  after: CellResult | undefined,
): CellChange {
  return {
    id: cell.id,
    personaId: cell.personaId,
    schema: cell.schema,
    table: cell.table,
    operation: cell.operation,
    before: before?.status ?? null,
    after: after?.status ?? null,
    leakedBefore: before?.leakedKeys.length ?? 0,
    leakedAfter: after?.leakedKeys.length ?? 0,
  };
}

function isRegression(change: CellChange): boolean {
  const { before, after } = change;
  if (before === "pass") {
    return after !== "pass";
  }
  if (after === null) {
    // A cell that did not pass and is gone: nothing got worse that the target list does not say.
    return false;
  }
  if (before === null) {
    // A cell the proposal created (a new table): it must not fail. Skipped proves nothing new.
    return after !== "pass" && after !== "skipped";
  }
  if (ISOLATION_FAILURES.has(after) && !ISOLATION_FAILURES.has(before)) {
    return true;
  }
  // Counts, not keys: keys from `gen_random_uuid()` differ between two builds of the database.
  return ISOLATION_FAILURES.has(after) && change.leakedAfter > change.leakedBefore;
}

/**
 * Pure: reads the run before the fix and the outcome of the re-run with it. `targetCellIds` are
 * the cells the explanation was asked for; they must have failed in `before`.
 */
export function compareRuns(
  before: MatrixResult,
  after: LabRunOutcome,
  targetCellIds: readonly string[],
): FixVerification {
  const beforeCells = new Map(before.cells.map((cell) => [cell.id, cell]));
  const targets = new Set(targetCellIds);
  const provenTargets = [...targets].filter((id) =>
    PROVEN_FAILURES.has(beforeCells.get(id)?.status ?? "pass"),
  );
  if (provenTargets.length === 0 || provenTargets.length !== targets.size) {
    return {
      kind: "incomplete",
      reason: "no-target",
      message: "The cell to fix did not fail in the run the explanation was made for.",
    };
  }

  switch (after.kind) {
    case "cancelled":
      return {
        kind: "incomplete",
        reason: "cancelled",
        message: "The re-run was cancelled, so the proposal was not tested.",
      };
    case "failed":
      return { kind: "incomplete", reason: after.reason, message: after.message };
    case "setup-error":
      return {
        kind: "did-not-pass",
        stillFailing: [],
        regressed: [],
        setupError: after.error,
        verdictAfter: null,
      };
    case "done":
      break;
  }

  const afterResult = after.run.result;
  const afterCells = new Map(afterResult.cells.map((cell) => [cell.id, cell]));
  const changes = [
    ...before.cells.map((cell) => changeOf(cell, cell, afterCells.get(cell.id))),
    ...afterResult.cells
      .filter((cell) => !beforeCells.has(cell.id))
      .map((cell) => changeOf(cell, undefined, cell)),
  ];

  const targetChanges = changes.filter((change) => targets.has(change.id));
  const others = changes.filter((change) => !targets.has(change.id));
  const stillFailing = targetChanges.filter((change) => change.after !== "pass");
  const regressed = others.filter(isRegression);

  if (stillFailing.length > 0 || regressed.length > 0) {
    return {
      kind: "did-not-pass",
      stillFailing,
      regressed,
      setupError: null,
      verdictAfter: afterResult.verdict,
    };
  }
  const failedBefore = others.filter(
    (change) => change.before !== null && PROVEN_FAILURES.has(change.before),
  );
  return {
    kind: "verified",
    fixed: targetChanges,
    alsoFixed: failedBefore.filter((change) => change.after === "pass"),
    remaining: failedBefore.filter((change) => change.after !== "pass"),
    verdictBefore: before.verdict,
    verdictAfter: afterResult.verdict,
  };
}

export interface VerifyFixInput {
  /** The scenario that produced `before`. It is not modified. */
  readonly scenario: Scenario;
  readonly before: MatrixResult;
  readonly targetCellIds: readonly string[];
  readonly proposedPolicySql: string;
  /** A full matrix run on a fresh database that never rejects: the lab's `runIsolated`. */
  readonly run: (scenario: Scenario, options?: LabRunOptions) => Promise<LabRunOutcome>;
  readonly options?: LabRunOptions | undefined;
}

export interface VerifyFixResult {
  readonly outcome: FixVerification;
  /** The schema of the copy that was re-run; `null` when the proposal could not be applied. */
  readonly schemaSql: string | null;
}

/** The whole loop: copy with the proposal, full re-run, comparison. Never rejects. */
export async function verifyProposedFix(input: VerifyFixInput): Promise<VerifyFixResult> {
  const patched = applyProposedFix(input.scenario, input.proposedPolicySql);
  if (!patched.ok) {
    return {
      outcome: { kind: "incomplete", reason: "not-applied", message: patched.message },
      schemaSql: null,
    };
  }
  const after = await input.run(patched.scenario, input.options);
  return {
    outcome: compareRuns(input.before, after, input.targetCellIds),
    schemaSql: patched.scenario.schemaSql,
  };
}

/** Pure: `UPDATE public.projects as alice`, the way the drawer titles a cell. */
export function cellChangeTitle(change: CellChange): string {
  return `${change.operation.toUpperCase()} ${change.schema}.${change.table} as ${change.personaId}`;
}

/** Pure: `escape, still escape`, `pass, now leak (2 rows)`, `pass, now gone`. */
export function cellChangeText(change: CellChange): string {
  const before = change.before === null ? "new cell" : `was ${change.before}`;
  if (change.after === null) {
    return `${before}, the cell no longer exists`;
  }
  const rows =
    ISOLATION_FAILURES.has(change.after) && change.leakedAfter > 0
      ? ` (${change.leakedAfter} ${change.leakedAfter === 1 ? "row" : "rows"} beyond the scope)`
      : "";
  const verb = change.before === change.after ? "still" : "now";
  return `${before}, ${verb} ${change.after}${rows}`;
}
