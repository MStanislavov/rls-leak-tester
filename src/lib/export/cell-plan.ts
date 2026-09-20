/**
 * One exported cell, as data: the statements of the shared probe builders and the keys the SQL
 * runtime compares. Pure; planned from the same `CellPlanContext` the matrix runner probed with,
 * through the same planners (`updateReachColumn`, `planBlindUpdate`, `planEscapes`,
 * `planInsertClasses`, `planFreshKey`, `insertProbeOf`), so the export cannot pick another column,
 * another source row or another foreign value than the runner did.
 *
 * Two spellings of a statement are used, both from one builder call (`Probe`):
 *
 * - `inlined` for a statement whose values are known here;
 * - `sql` (with `$n::text` parameters) for a statement that the runtime runs once per row: the
 *   key is bound at run time with `EXECUTE ... USING`, the way the runner binds it. The text of
 *   such a statement does not depend on the key it was built for, so it is built for a
 *   placeholder key; the values in front of the key (a moved column) are kept as `values`.
 *
 * What is decided at run time in the runner is decided at run time in SQL as well: the per-row
 * fallback, the takeover, whether the blind shape runs, and which row a scope escape moves (the
 * first expected key that the reach probe really reached).
 *
 * One plan is wider than the runner's, on purpose: the blind UPDATE also names columns the role
 * held no UPDATE privilege on in the exported run (`planBlindUpdate(context, true)`). The runner
 * measures today's privileges; the exported file must measure tomorrow's.
 */
import {
  NO_ROW_TO_CLONE_REMARK,
  NO_WRITABLE_COLUMN_REMARK,
  cellId,
  deleteBlindProbe,
  deleteReachProbe,
  deleteRowProbe,
  escapeBulkProbe,
  escapeTargetedProbe,
  identityProbes,
  insertProbeOf,
  planBlindUpdate,
  planEscapes,
  planFreshKey,
  planInsertClasses,
  pullMoves,
  pullRowProbe,
  rowVersionsProbe,
  rowsCarrying,
  rowsWithValueProbe,
  selectCountProbe,
  selectReachProbe,
  sortKeys,
  sourceCopyProbe,
  sourceGrantProbe,
  updateReachColumn,
  updateReachProbe,
  updateRowProbe,
  type CellPlanContext,
  type InsertClassKind,
  type Probe,
} from "@/lib/runner";
import type { Operation } from "@/lib/scenario";

/** What every exported cell carries. */
export interface CellPlanHeader {
  /** `personaId|schema.table|operation`, the id of the runner's cell. */
  readonly id: string;
  readonly operation: Operation;
  /** `schema.table`, as the seed check of the preflight names it (`tableNameOf`). */
  readonly table: string;
  /** One line for people: persona, role, operation, table, scope. */
  readonly label: string;
  readonly role: string;
  /** The statements of `identityProbes`, values inlined. */
  readonly identity: readonly string[];
  readonly keyColumns: number;
  /** Serialised keys in code-unit order. */
  readonly expectedKeys: readonly string[];
  /** Every seeded key of the table, in code-unit order. */
  readonly truthKeys: readonly string[];
}

/** A statement the runtime runs once per row: `values` come before the key in its parameters. */
export interface RowStatement {
  readonly sql: string;
  readonly values: readonly (string | null)[];
}

export interface SelectCellPlan extends CellPlanHeader {
  readonly kind: "select";
  readonly reach: string;
  readonly count: string;
}

export interface DeleteCellPlan extends CellPlanHeader {
  readonly kind: "delete";
  readonly reach: string;
  readonly row: RowStatement;
  readonly blind: string;
  /** As the superuser: every key, before and after the blind DELETE. */
  readonly readKeys: string;
}

export interface EscapeStatements {
  /** `column = value`, for the message. */
  readonly label: string;
  readonly targeted: RowStatement;
  readonly bulk: string;
  /** As the superuser: the rows that carry the foreign value after the bulk shape. */
  readonly read: string;
  /** The seeded rows that carry it already. */
  readonly before: readonly string[];
}

export interface UpdateCellPlan extends CellPlanHeader {
  readonly kind: "update";
  readonly reach: string;
  readonly row: RowStatement;
  /** The takeover variants for one row. */
  readonly pulls: readonly RowStatement[];
  readonly blind: {
    /** As the superuser: the source row and the grant on it. */
    readonly source: readonly string[];
    readonly versions: string;
    readonly constants: readonly string[];
    readonly pulls: readonly string[];
  } | null;
  readonly escapes: readonly EscapeStatements[];
  /** Why an escape pair is not in the file (no foreign value, a generated column, ...). */
  readonly skippedEscapes: readonly string[];
}

export interface InsertClone {
  readonly kind: InsertClassKind;
  readonly expected: "allowed" | "blocked";
  readonly sourceKey: string;
  /** As the superuser: the copy of the source row. */
  readonly source: string;
  readonly insert: string;
}

export interface InsertCellPlan extends CellPlanHeader {
  readonly kind: "insert";
  /** As the superuser: lets the persona's role read the source row. */
  readonly grant: string;
  readonly clones: readonly InsertClone[];
}

/** A cell that is a comment in the file: nothing can be probed, and why. */
export interface SkippedCellPlan {
  readonly kind: "skipped";
  readonly id: string;
  readonly operation: Operation;
  readonly label: string;
  readonly reason: string;
}

export type CellPlan =
  SelectCellPlan | DeleteCellPlan | UpdateCellPlan | InsertCellPlan | SkippedCellPlan;

/** A key of the right length whose values never reach the file: only `Probe.sql` is taken. */
function placeholderKey(context: CellPlanContext): string {
  return JSON.stringify(context.truth.primaryKey.map(() => ""));
}

/** The per-row spelling of a probe that was built for the placeholder key. */
function rowStatement(probe: Probe, keyColumns: number): RowStatement {
  return { sql: probe.sql, values: probe.params.slice(0, probe.params.length - keyColumns) };
}

/** `schema.table`: the name a table goes by in the preflight and in the messages. */
export function tableNameOf(table: { readonly schema: string; readonly name: string }): string {
  return `${table.schema}.${table.name}`;
}

function headerOf(context: CellPlanContext, personaLabel: string): CellPlanHeader {
  const { expectation, identity, truth } = context;
  return {
    id: cellId(expectation),
    operation: expectation.operation,
    table: tableNameOf(truth),
    label: labelOf(context, personaLabel),
    role: identity.role,
    identity: identityProbes(identity).map((probe) => probe.inlined),
    keyColumns: truth.primaryKey.length,
    expectedKeys: sortKeys(context.expectedKeys),
    truthKeys: sortKeys(truth.rows.map((row) => row.key)),
  };
}

export function labelOf(
  context: Pick<CellPlanContext, "expectation" | "identity">,
  personaLabel: string,
): string {
  const { expectation, identity } = context;
  return `${personaLabel} as role ${identity.role}: ${expectation.operation.toUpperCase()} on ${expectation.schema}.${expectation.table}, scope ${expectation.scope}`;
}

function skippedPlan(
  context: CellPlanContext,
  personaLabel: string,
  reason: string,
): SkippedCellPlan {
  return {
    kind: "skipped",
    id: cellId(context.expectation),
    operation: context.expectation.operation,
    label: labelOf(context, personaLabel),
    reason,
  };
}

function selectPlan(context: CellPlanContext, header: CellPlanHeader): SelectCellPlan {
  return {
    ...header,
    kind: "select",
    reach: selectReachProbe(context.truth).inlined,
    count: selectCountProbe(context.truth).inlined,
  };
}

function deletePlan(context: CellPlanContext, header: CellPlanHeader): DeleteCellPlan {
  const { truth } = context;
  return {
    ...header,
    kind: "delete",
    reach: deleteReachProbe(truth).inlined,
    row: rowStatement(deleteRowProbe(truth, placeholderKey(context)), header.keyColumns),
    blind: deleteBlindProbe(truth).inlined,
    readKeys: selectReachProbe(truth).inlined,
  };
}

function updatePlan(
  context: CellPlanContext,
  header: CellPlanHeader,
  column: string,
): UpdateCellPlan {
  const { truth, table } = context;
  const key = placeholderKey(context);
  // The privileges are the ones of the exported run, and a CI check exists for the day they
  // change: the constants also name columns the role holds no UPDATE on yet. They answer 42501
  // until a migration grants them, and then they measure what only the blind shape can see.
  const blind = planBlindUpdate(context, true);
  const escapes: EscapeStatements[] = [];
  const skippedEscapes: string[] = [];
  // Which row is moved is decided at run time; every expected key counts as reachable here, so
  // that a plan is skipped only for a reason that holds whatever the reach probe finds.
  for (const plan of planEscapes(context, context.expectedKeys)) {
    if (plan.status === "skipped") {
      skippedEscapes.push(plan.reason);
    } else {
      escapes.push({
        label: `${plan.move.column} = ${plan.move.value}`,
        targeted: rowStatement(escapeTargetedProbe(truth, plan.move, key), header.keyColumns),
        bulk: escapeBulkProbe(truth, plan.move).inlined,
        read: rowsWithValueProbe(truth, plan.move.column, plan.move.value).inlined,
        before: sortKeys(rowsCarrying(truth, plan.move)),
      });
    }
  }
  return {
    ...header,
    kind: "update",
    reach: updateReachProbe(truth, column).inlined,
    row: rowStatement(updateRowProbe(truth, column, key), header.keyColumns),
    pulls: pullMoves(table, truth, context.facts).map((moves) =>
      rowStatement(pullRowProbe(truth, moves, key), header.keyColumns),
    ),
    blind:
      blind === null
        ? null
        : {
            source: [
              sourceCopyProbe(truth, blind.sourceKey).inlined,
              sourceGrantProbe(context.identity.role).inlined,
            ],
            versions: rowVersionsProbe(truth).inlined,
            constants: blind.constants.map((probe) => probe.inlined),
            pulls: blind.pulls.map((probe) => probe.inlined),
          },
    escapes,
    skippedEscapes,
  };
}

function insertPlan(
  context: CellPlanContext,
  header: CellPlanHeader,
  personaLabel: string,
): InsertCellPlan | SkippedCellPlan {
  const { truth } = context;
  const classes = planInsertClasses(
    context.expectation.scope,
    truth,
    context.facts,
    context.membership,
    context.expectedKeys,
  );
  if (classes.length === 0) {
    return skippedPlan(context, personaLabel, NO_ROW_TO_CLONE_REMARK);
  }
  const freshKey = planFreshKey(context.table, truth);
  if (freshKey.status === "skipped") {
    return skippedPlan(context, personaLabel, freshKey.reason);
  }
  const insert = insertProbeOf(context, freshKey).inlined;
  return {
    ...header,
    kind: "insert",
    grant: sourceGrantProbe(context.identity.role).inlined,
    clones: classes.map((plan) => ({
      kind: plan.kind,
      expected: plan.expected,
      sourceKey: plan.sourceKey,
      source: sourceCopyProbe(truth, plan.sourceKey).inlined,
      insert,
    })),
  };
}

/** The exported form of one probed cell. */
export function planCell(context: CellPlanContext, personaLabel: string): CellPlan {
  const header = headerOf(context, personaLabel);
  switch (context.expectation.operation) {
    case "select":
      return selectPlan(context, header);
    case "delete":
      return deletePlan(context, header);
    case "insert":
      return insertPlan(context, header, personaLabel);
    case "update": {
      const column = updateReachColumn(context);
      return column === null
        ? skippedPlan(context, personaLabel, NO_WRITABLE_COLUMN_REMARK)
        : updatePlan(context, header, column);
    }
  }
}

/** The most parameters one per-row statement of `plan` binds: its values plus the key. */
export function maxParamsOf(plan: CellPlan): number {
  if (plan.kind === "delete") {
    return plan.row.values.length + plan.keyColumns;
  }
  if (plan.kind !== "update") {
    return 0;
  }
  const statements = [plan.row, ...plan.pulls, ...plan.escapes.map((escape) => escape.targeted)];
  return Math.max(...statements.map((statement) => statement.values.length)) + plan.keyColumns;
}
