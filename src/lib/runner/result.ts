/**
 * The result of a matrix run (brief 3.5). Plain JSON, no `undefined`, no timestamps, no durations,
 * no random values: the same scenario yields a byte-identical `JSON.stringify(result)`.
 *
 * Order everywhere: tables by schema and name (code-unit order), personas in scenario order,
 * operations select, insert, update, delete, keys in code-unit order of their serialised form,
 * sub-probes in the fixed order of `SUB_PROBE_KINDS`.
 */
import type { Expectation, Mode, Operation, Scope } from "@/lib/scenario";
import type { PolicyCommand } from "./introspect";

export const MATRIX_RESULT_VERSION = 1;

export const CELL_STATUSES = [
  "pass",
  "leak",
  "escape",
  "overblock",
  "inconclusive",
  "skipped",
] as const;
export type CellStatus = (typeof CELL_STATUSES)[number];

export const VERDICTS = ["ISOLATED", "LEAKING", "NOT PROVEN"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** SQLSTATE and message of a failed statement; `sqlState` is `null` when the engine failed. */
export interface ProbeFailure {
  readonly sqlState: string | null;
  readonly message: string;
}

export const SUB_PROBE_KINDS = [
  "escape-targeted",
  "escape-bulk",
  "insert-own",
  "insert-same-tenant",
  "insert-other",
  "insert-in-scope",
  "insert-out-of-scope",
] as const;
export type SubProbeKind = (typeof SUB_PROBE_KINDS)[number];

/** What the statement did: it went through, Postgres refused it (42501), it failed otherwise, or it never ran. */
export type SubProbeOutcome = "allowed" | "blocked" | "inconclusive" | "skipped";

export interface SubProbeResult {
  readonly kind: SubProbeKind;
  /** What isolation demands of this statement. */
  readonly expected: "allowed" | "blocked";
  readonly outcome: SubProbeOutcome;
  /** `pass`, `escape` (allowed but must be blocked), `overblock` (blocked but must be allowed), `inconclusive`, `skipped`. */
  readonly status: Exclude<CellStatus, "leak">;
  /** Why it was skipped, or a remark on the outcome; `null` without one. */
  readonly reason: string | null;
  /** The ground-truth row the probe worked on (moved, or cloned); `null` when skipped before one was chosen. */
  readonly sourceKey: string | null;
  /** Escape probes: the rows that carried the foreign value afterwards. Empty otherwise. */
  readonly movedKeys: readonly string[];
  /**
   * The probe statement alone, literals inlined, without the transaction around it: what the CI
   * export embeds. Empty when the probe never ran.
   */
  readonly statement: string;
  /** The reproducible script, literals inlined; empty when the probe never ran. */
  readonly sql: string;
  readonly error: ProbeFailure | null;
}

/** A policy that applied to the cell's table, command and role. */
export interface CellPolicy {
  readonly name: string;
  readonly command: PolicyCommand;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
  /**
   * `command`: the policy is for this command (or for ALL). `visibility`: a SELECT policy, which
   * Postgres also applies to UPDATE and DELETE statements that read the row (WHERE, RETURNING).
   */
  readonly appliesAs: "command" | "visibility";
}

/**
 * Why row level security does not restrict this role on this table, `null` when it does. A cell
 * with a bypass still reports what the role really reaches; the flag says that no policy was
 * involved (RUN-001: a bypass is never silent).
 */
export type RlsBypass = "superuser" | "bypassrls" | "table-owner" | "rls-disabled";

export interface CellResult {
  /** `personaId|schema.table|operation`, unique within a result. */
  readonly id: string;
  readonly personaId: string;
  readonly schema: string;
  readonly table: string;
  readonly operation: Operation;
  readonly scope: Scope;
  readonly expectationSource: "explicit" | "default";
  readonly status: CellStatus;
  /** The reason of `skipped` / `inconclusive`, or a remark such as "the table is empty"; else `null`. */
  readonly reason: string | null;
  readonly expectedKeys: readonly string[];
  readonly actualKeys: readonly string[];
  /**
   * DELETE cells: the rows that only the WHERE-less DELETE without RETURNING reached (no SELECT
   * policy applies to that shape). They are part of `actualKeys`. Empty otherwise.
   */
  readonly blindKeys: readonly string[];
  /** actual minus expected. */
  readonly leakedKeys: readonly string[];
  /** expected minus actual. */
  readonly missingKeys: readonly string[];
  /**
   * The reach statement alone (`select ...`, `update ... returning ...`), literals inlined: what
   * the CI export embeds. Empty for insert cells and for cells that never ran.
   */
  readonly statement: string;
  /** The reproducible script of the reach probe (and of the per-row fallback when it ran). Empty for insert cells, whose scripts are in `subProbes`. */
  readonly sql: string;
  /** `true` when the bulk statement raised and reach was measured row by row in savepoints. */
  readonly perRowFallback: boolean;
  readonly error: ProbeFailure | null;
  readonly subProbes: readonly SubProbeResult[];
  readonly policies: readonly CellPolicy[];
  readonly rlsBypass: RlsBypass | null;
}

export type StatusCounts = Readonly<Record<CellStatus, number>>;

export interface MatrixPersona {
  readonly id: string;
  readonly label: string;
  readonly dbRole: string;
  readonly roleExists: boolean;
  /** `superuser` or `bypassrls` when the role bypasses RLS on every table. */
  readonly rlsBypass: Extract<RlsBypass, "superuser" | "bypassrls"> | null;
  /** The exact `request.jwt.claims` text every probe of this persona ran with. */
  readonly claimsJson: string;
}

export interface MatrixTable {
  readonly schema: string;
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly ownerColumn: string | null;
  readonly tenantColumn: string | null;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  /** Seeded rows in the ground truth; `null` when the table was skipped. */
  readonly rowCount: number | null;
  /** Why no cell of this table ran (no primary key, unknown configured column); else `null`. */
  readonly skippedReason: string | null;
}

export interface MatrixResult {
  readonly version: typeof MATRIX_RESULT_VERSION;
  readonly scenarioId: string;
  readonly mode: Mode;
  readonly verdict: Verdict;
  /** Cells by status. `leak` and `escape` decide the verdict; the others are reported beside it. */
  readonly counts: StatusCounts;
  readonly totalCells: number;
  /** Exposed schemas of the scenario that do not exist in the database. */
  readonly missingSchemas: readonly string[];
  readonly personas: readonly MatrixPersona[];
  readonly tables: readonly MatrixTable[];
  readonly cells: readonly CellResult[];
  /** Explicit expectations that matched no cell (unknown persona, table not in an exposed schema). */
  readonly orphanExpectations: readonly Expectation[];
}
