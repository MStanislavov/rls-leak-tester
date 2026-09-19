/**
 * The "by hand" half of the golden tests: every failing cell a template declares is reproduced
 * WITHOUT the runner, from nothing but the SQL transcript the runner recorded in the cell. The
 * transcript is split into statements and run one by one in a fresh database; the rows it returns
 * must be the evidence the cell reports. The same cell of the fixed variant must replay clean.
 *
 * This keeps three parties honest at once: the policy (it really leaks), the runner (its verdict
 * follows from SQL anyone can run) and the transcript (`cell.sql` is the exact probe, brief 3.5).
 */
import { describe, expect, it } from "vitest";
import type { CellResult, MatrixResult, SubProbeResult } from "@/lib/runner";
import { keyOfRow } from "@/lib/runner/ground-truth";
import {
  SqlError,
  SQLSTATE_INSUFFICIENT_PRIVILEGE,
  type SqlEngine,
  type SqlQueryResult,
} from "@/lib/runner/types";
import { compareText, splitSqlStatements } from "@/lib/scenario";
import { TEMPLATES, type ExpectedFailure, type Template } from "@/lib/scenario/templates";
import { cellOf, run } from "../runner/helpers";
import { loadScenario } from "../templates/helpers";

const RUN_TIMEOUT_MS = 120_000;
const WHOAMI =
  "select current_user::text as role, session_user::text as session_role, current_setting('row_security') as row_security";

interface ReplayedStatement {
  readonly text: string;
  readonly result: SqlQueryResult;
}

interface Replay {
  readonly statements: readonly ReplayedStatement[];
  /** The Postgres error that ended the transcript early, if one did. */
  readonly error: SqlError | null;
}

/** Runs a recorded transcript statement by statement and rolls back, like a person in psql. */
async function replay(engine: SqlEngine, transcript: string): Promise<Replay> {
  const texts = splitSqlStatements(transcript).map((statement) => statement.text);
  expect(texts.at(0)).toBe("begin");
  expect(texts.at(-1)).toBe("rollback");
  return engine.transaction(async (tx) => {
    const statements: ReplayedStatement[] = [];
    try {
      for (const text of texts.slice(1, -1)) {
        statements.push({ text, result: await tx.query(text) });
      }
      return { statements, error: null };
    } catch (error) {
      if (error instanceof SqlError) {
        return { statements, error };
      }
      throw error;
    } finally {
      await tx.rollback();
    }
  });
}

function resultOf(replayed: Replay, statement: string): SqlQueryResult {
  const found = replayed.statements.find((entry) => entry.text === statement);
  if (found === undefined) {
    throw new Error(`The transcript never ran: ${statement}`);
  }
  return found.result;
}

function keysOf(result: SqlQueryResult, keyLength: number): string[] {
  return result.rows.map((row) => keyOfRow(row, keyLength)).sort(compareText);
}

/** The transcript must have run as the persona's role, not as the session's superuser. */
function expectPersonaRole(replayed: Replay, result: MatrixResult, cell: CellResult): void {
  const persona = result.personas.find((candidate) => candidate.id === cell.personaId);
  const [row] = resultOf(replayed, WHOAMI).rows;
  expect(row?.role).toBe(persona?.dbRole);
  expect(row?.session_role).not.toBe(persona?.dbRole);
  // The transcript pins it itself: a pg_dump header (`SET row_security = off`) cannot reach it.
  expect(row?.row_security).toBe("on");
}

function escapingProbes(cell: CellResult): SubProbeResult[] {
  return cell.subProbes.filter((probe) => probe.status === "escape");
}

async function withDatabase<T>(
  template: Template,
  kind: "leaky" | "fixed",
  work: (engine: SqlEngine) => Promise<T>,
): Promise<T> {
  const engine = await loadScenario(template[kind].scenario);
  try {
    return await work(engine);
  } finally {
    await engine.close();
  }
}

function cellFor(result: MatrixResult, failure: ExpectedFailure): CellResult {
  return cellOf(result, failure.personaId, failure.table, failure.operation);
}

describe.each(TEMPLATES.map((template) => ({ id: template.id, template })))(
  "replay by hand: $id",
  ({ template }) => {
    const failures = template.leaky.expectedFailures;

    it(
      "reproduces every declared failure of the leaky variant from its recorded SQL",
      async () => {
        const { result } = await run(template.leaky.scenario);
        await withDatabase(template, "leaky", async (engine) => {
          for (const failure of failures) {
            const cell = cellFor(result, failure);
            expect(cell.status, cell.id).toBe(failure.status);
            const keyLength = result.tables.find((table) => table.name === cell.table)?.primaryKey
              .length;
            const reach = await replay(engine, cell.sql);
            expect(reach.error, cell.id).toBeNull();
            expectPersonaRole(reach, result, cell);
            const reached = keysOf(resultOf(reach, cell.statement), keyLength ?? 0);
            expect(reached, cell.id).toEqual(cell.actualKeys);
            if (failure.status === "leak") {
              const leaked = reached.filter((key) => !cell.expectedKeys.includes(key));
              expect(leaked, cell.id).toEqual(cell.leakedKeys);
              expect(leaked.length, cell.id).toBeGreaterThan(0);
            } else {
              expect(escapingProbes(cell).length, cell.id).toBeGreaterThan(0);
              for (const probe of escapingProbes(cell)) {
                const escaped = await replay(engine, probe.sql);
                expect(escaped.error, `${cell.id} ${probe.kind}`).toBeNull();
                expectPersonaRole(escaped, result, cell);
                const moved = resultOf(escaped, probe.statement);
                expect(moved.affectedRows, `${cell.id} ${probe.kind}`).toBe(probe.movedKeys.length);
                expect(probe.movedKeys.length).toBeGreaterThan(0);
              }
            }
          }
        });
      },
      RUN_TIMEOUT_MS,
    );

    it(
      "replays the same cells of the fixed variant clean",
      async () => {
        const leaky = (await run(template.leaky.scenario)).result;
        const { result } = await run(template.fixed.scenario);
        await withDatabase(template, "fixed", async (engine) => {
          for (const failure of failures) {
            const cell = cellFor(result, failure);
            expect(cell.status, cell.id).toBe("pass");
            const keyLength = result.tables.find((table) => table.name === cell.table)?.primaryKey
              .length;
            const reach = await replay(engine, cell.sql);
            expect(reach.error, cell.id).toBeNull();
            expectPersonaRole(reach, result, cell);
            expect(keysOf(resultOf(reach, cell.statement), keyLength ?? 0), cell.id).toEqual(
              cell.expectedKeys,
            );
            // The probe that escaped in the leaky variant is refused here, by the policy.
            for (const leakyProbe of escapingProbes(cellFor(leaky, failure))) {
              const probe = cell.subProbes.find((candidate) => candidate.kind === leakyProbe.kind);
              expect(probe?.statement, cell.id).toBe(leakyProbe.statement);
              const blocked = await replay(engine, probe?.sql ?? "");
              expect(blocked.error?.code, `${cell.id} ${leakyProbe.kind}`).toBe(
                SQLSTATE_INSUFFICIENT_PRIVILEGE,
              );
            }
          }
        });
      },
      RUN_TIMEOUT_MS,
    );
  },
);
