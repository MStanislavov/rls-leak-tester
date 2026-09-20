/**
 * What a CI check is for: the file is exported from a GOOD scenario, the schema regresses later
 * and the seed stays. The good file runs against the regressed database and must say what the
 * matrix runner says about the regressed scenario, or say that it cannot know (a `[setup]` line);
 * it must never print ISOLATED. Plus the two ways the lab and CI could disagree about a scenario
 * that did not change at all: keys that differ on every load, and session state between the
 * schema and the seed.
 */
import { describe, expect, it } from "vitest";
import { CI_EXPORT_FILE_NAMES } from "@/lib/export";
import type { Scenario } from "@/lib/scenario";
import { TEMPLATES } from "@/lib/scenario/templates";
import { SESSION_STATE, VOLATILE_KEYS, tableAddedLater, writeOnlyGrant } from "./fixtures";
import {
  cellIdsOf,
  dumpEverything,
  exportOf,
  failedCells,
  fileOf,
  prepareLikeWorkflow,
  runTestFile,
  type Exported,
  type TestFileOutcome,
} from "./helpers";

const TIMEOUT_MS = 120_000;
const { test: TEST_SQL } = CI_EXPORT_FILE_NAMES;

interface Crossed {
  readonly good: Exported;
  readonly regressed: Exported;
  readonly outcome: TestFileOutcome;
}

/** The test file of `good` against the database of `regressed`. */
async function cross(good: Scenario, regressed: Scenario): Promise<Crossed> {
  const fromGood = await exportOf(good);
  const fromRegressed = await exportOf(regressed);
  const engine = await prepareLikeWorkflow(fromRegressed.ciExport);
  try {
    const before = await dumpEverything(engine);
    const outcome = await runTestFile(engine, fileOf(fromGood.ciExport, TEST_SQL));
    expect(await dumpEverything(engine)).toBe(before);
    return { good: fromGood, regressed: fromRegressed, outcome };
  } finally {
    await engine.close();
  }
}

function lines(outcome: TestFileOutcome): string[] {
  return outcome.passed ? [] : failedCells(outcome.error, []).map((cell) => cell.line);
}

function failing(exported: Exported): string[] {
  return exported.matrix.result.cells
    .filter((cell) => cell.status !== "pass" && cell.status !== "skipped")
    .map((cell) => `[${cell.status}] ${cell.id}`);
}

describe("a good export against a regressed database", () => {
  it(
    "an UPDATE grant without SELECT that came later is measured by the blind UPDATE",
    async () => {
      const { good, regressed, outcome } = await cross(writeOnlyGrant(false), writeOnlyGrant(true));
      expect(failing(good)).toEqual([]);
      expect(failing(regressed)).toEqual(["[leak] visitor|public.counters|update"]);
      expect(lines(outcome)).toHaveLength(1);
      expect(lines(outcome)[0]).toContain(
        '[leak] visitor|public.counters|update (Visitor as role app_anon: UPDATE on public.counters, scope none): leaked keys [["1"], ["2"]]; missing keys none',
      );
    },
    TIMEOUT_MS,
  );

  it(
    "a table added to an exposed schema is a setup failure, never ISOLATED",
    async () => {
      const { good, regressed, outcome } = await cross(
        tableAddedLater(false),
        tableAddedLater(true),
      );
      expect(failing(good)).toEqual([]);
      expect(regressed.matrix.result.verdict).toBe("LEAKING");
      expect(lines(outcome)).toEqual([
        "[setup] the table public.invoices is not covered by this file: the exported run did not have it, so nothing is known about its isolation. Run the matrix on the current schema and export the check again.",
      ]);
      const sql = fileOf(good.ciExport, TEST_SQL);
      expect(sql).toContain("p_schemas => array['public']::text[]");
      expect(sql).toContain(`p_tables => '[["public","notes"]]'::jsonb`);
    },
    TIMEOUT_MS,
  );

  it.each(TEMPLATES.map((template) => ({ id: template.id, template })))(
    "$id: the fixed export on the leaky schema fails with the leaky variant's cells",
    async ({ template }) => {
      const sameSeed = template.fixed.scenario.seedSql === template.leaky.scenario.seedSql;
      const { regressed, outcome } = await cross(template.fixed.scenario, template.leaky.scenario);
      expect(outcome.passed).toBe(false);
      if (sameSeed) {
        const reported = failedCells(outcome.passed ? never() : outcome.error, cellIdsOf(regressed))
          .filter((cell) => !cell.line.startsWith("[setup]"))
          .map((cell) => `[${cell.status}] ${cell.id}`);
        expect(lines(outcome).filter((line) => line.startsWith("[setup]"))).toEqual([]);
        expect(reported).toEqual(failing(regressed));
      }
    },
    TIMEOUT_MS,
  );
});

function never(): never {
  throw new Error("The outcome passed");
}

describe("the same scenario in the lab and in CI", () => {
  it(
    "keys from a volatile default: one [setup] line that names the cause, and no false leak",
    async () => {
      const exported = await exportOf(VOLATILE_KEYS);
      expect(failing(exported)).toEqual([]);
      expect(exported.ciExport.warnings).toEqual([
        expect.stringMatching(
          /^public\.todos: the keys of the seeded rows are not in the seed and the key column id defaults to gen_random_uuid\(\)/,
        ),
      ]);
      const engine = await prepareLikeWorkflow(exported.ciExport);
      try {
        const before = await dumpEverything(engine);
        const outcome = await runTestFile(engine, fileOf(exported.ciExport, TEST_SQL));
        expect(await dumpEverything(engine)).toBe(before);
        expect(outcome.passed).toBe(false);
        const reported = lines(outcome);
        expect(reported).toHaveLength(1);
        expect(reported[0]).toMatch(
          /^\[setup\] the rows of public\.todos are not the rows this file was exported for/,
        );
        expect(reported[0]).toContain("gen_random_uuid()");
        expect(reported[0]).toContain("differ on every load");
        expect(reported[0]).toContain("Give the seed explicit keys");
        expect(reported[0]).toContain("The 8 cells of this table were not run.");
        if (!outcome.passed) {
          // labels has explicit keys: its 8 cells ran and passed; the 8 of todos did not run.
          expect(outcome.error.message).toMatch(
            /^RLS Leak Tester: NOT PROVEN, no leak or escape was measured\. Of 16 checked cells: 0 leaked or escaped, 0 overblocked, 0 inconclusive, 8 passed; 0 warnings\. Setup problems: 1; cells not run because of them: 8\.\n/,
          );
        }
      } finally {
        await engine.close();
      }
    },
    TIMEOUT_MS,
  );

  it(
    "explicit keys under a volatile default are no warning",
    async () => {
      for (const template of TEMPLATES) {
        expect((await exportOf(template.fixed.scenario)).ciExport.warnings).toEqual([]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "session state of the schema script reaches the seed, as it does in the runner",
    async () => {
      const exported = await exportOf(SESSION_STATE);
      expect(failing(exported)).toEqual([]);
      expect(exported.ciExport.checkedCells).toBe(4);
      const engine = await prepareLikeWorkflow(exported.ciExport);
      try {
        expect(await runTestFile(engine, fileOf(exported.ciExport, TEST_SQL))).toEqual({
          passed: true,
        });
      } finally {
        await engine.close();
      }
    },
    TIMEOUT_MS,
  );
});
