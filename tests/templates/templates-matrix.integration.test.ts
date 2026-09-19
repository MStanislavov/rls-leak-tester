/**
 * Proves the `expectedFailures` of every template variant against a real PGlite, without the
 * matrix runner (it is built in another slice). A small hand-written matrix follows the probe
 * semantics of brief 3.5: select, no-op update and delete reach by key, the scope-escape update
 * in both shapes of ADR 0002, and cloned-row inserts. Every probe switches role and claims and
 * rolls back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlEngine } from "@/lib/runner/types";
import {
  qualifiedName,
  quoteIdent,
  type Expectation,
  type Persona,
  type Scenario,
  type TableConfig,
} from "@/lib/scenario";
import { templateVariants, type ExpectedFailure } from "@/lib/scenario/templates";
import { BLOCKED, expectedIds, idsAs, loadScenario, personaOf, writeAs } from "./helpers";

interface CellResult {
  cell: string;
  leaked: string[];
  missing: string[];
  escaped: boolean;
}

function cellName(cell: Pick<Expectation, "personaId" | "schema" | "table" | "operation">): string {
  return `${cell.personaId} ${cell.schema}.${cell.table} ${cell.operation}`;
}

function minus(left: readonly string[], right: readonly string[]): string[] {
  const drop = new Set(right);
  return left.filter((value) => !drop.has(value));
}

async function reach(
  engine: SqlEngine,
  persona: Persona,
  expectation: Expectation,
): Promise<string[]> {
  const table = qualifiedName(expectation.schema, expectation.table);
  const sql = {
    select: `select id from ${table}`,
    update: `update ${table} set id = id returning id`,
    delete: `delete from ${table} returning id`,
    insert: "",
  }[expectation.operation];
  const ids = await idsAs(engine, persona, sql);
  return ids === BLOCKED ? [] : ids;
}

/** The column a scope-escape moves: the tenant column, else the owner column, never the key. */
function scopeColumn(config: TableConfig | undefined): string | undefined {
  return [config?.tenantColumn, config?.ownerColumn].find(
    (column) => column !== undefined && column !== "id",
  );
}

/**
 * Takes a value of the scope column that only rows outside the expected set have, and tries to
 * give it to the persona's rows: targeted first, then without WHERE and without RETURNING.
 */
async function escapes(
  engine: SqlEngine,
  scenario: Scenario,
  expectation: Expectation,
  expected: readonly string[],
): Promise<boolean> {
  const column = scopeColumn(
    scenario.tables.find(
      (config) => config.schema === expectation.schema && config.name === expectation.table,
    ),
  );
  const firstExpected = expected[0];
  if (column === undefined || firstExpected === undefined) {
    return false;
  }
  const table = qualifiedName(expectation.schema, expectation.table);
  const { rows } = await engine.query(
    `select ${quoteIdent(column)}::text as value from ${table}
     where not (id::text = any (string_to_array($1, ',')))
     except
     select ${quoteIdent(column)}::text from ${table}
     where id::text = any (string_to_array($1, ','))
     order by 1 limit 1`,
    [expected.join(",")],
  );
  const foreign = rows[0]?.value;
  if (typeof foreign !== "string") {
    return false;
  }
  const persona = personaOf(scenario, expectation.personaId);
  const set = `update ${table} set ${quoteIdent(column)} = $1::text::uuid`;
  const targeted = await writeAs(engine, persona, `${set} where id = $2::text::uuid`, [
    foreign,
    firstExpected,
  ]);
  const whereLess = await writeAs(engine, persona, set, [foreign]);
  return [targeted, whereLess].some((moved) => moved !== BLOCKED && moved > 0);
}

/** Clones every seeded row under a fresh id as the persona; returns the ids whose clone went in. */
async function insertable(
  engine: SqlEngine,
  persona: Persona,
  expectation: Expectation,
): Promise<string[]> {
  const table = qualifiedName(expectation.schema, expectation.table);
  const { rows } = await engine.query(
    `select id::text as id, to_jsonb(t)::text as doc from ${table} t order by 1`,
  );
  const accepted: string[] = [];
  for (const row of rows) {
    const inserted = await writeAs(
      engine,
      persona,
      `insert into ${table}
       select (jsonb_populate_record(null::${table},
         jsonb_set($1::text::jsonb, '{id}', to_jsonb(gen_random_uuid())))).*`,
      [String(row.doc)],
    );
    if (inserted !== BLOCKED) {
      accepted.push(String(row.id));
    }
  }
  return accepted;
}

async function probe(
  engine: SqlEngine,
  scenario: Scenario,
  expectation: Expectation,
): Promise<CellResult> {
  const persona = personaOf(scenario, expectation.personaId);
  const expected = await expectedIds(engine, scenario, expectation);
  if (expectation.operation === "insert") {
    const accepted = await insertable(engine, persona, expectation);
    return {
      cell: cellName(expectation),
      leaked: [],
      missing: minus(expected, accepted),
      escaped: minus(accepted, expected).length > 0,
    };
  }
  const actual = await reach(engine, persona, expectation);
  return {
    cell: cellName(expectation),
    leaked: minus(actual, expected),
    missing: minus(expected, actual),
    escaped:
      expectation.operation === "update" &&
      (await escapes(engine, scenario, expectation, expected)),
  };
}

function statusOf(result: CellResult): "leak" | "escape" | "overblock" | "pass" {
  if (result.leaked.length > 0) {
    return "leak";
  }
  if (result.escaped) {
    return "escape";
  }
  return result.missing.length > 0 ? "overblock" : "pass";
}

function failureName(failure: ExpectedFailure): string {
  return `${cellName(failure)}: ${failure.status}`;
}

describe.each(templateVariants().map(({ variant }) => ({ id: variant.scenario.id, variant })))(
  "hand-written matrix: $id",
  ({ variant }) => {
    const { scenario } = variant;
    let engine: SqlEngine;
    let results: CellResult[];
    let snapshotBefore: string;

    const snapshot = async (): Promise<string> => {
      const parts: string[] = [];
      for (const table of scenario.tables) {
        const { rows } = await engine.query(
          `select coalesce(jsonb_agg(to_jsonb(t) order by id)::text, '[]') as doc
           from ${qualifiedName(table.schema, table.name)} t`,
        );
        parts.push(String(rows[0]?.doc));
      }
      return parts.join("\n");
    };

    beforeAll(async () => {
      engine = await loadScenario(scenario);
      snapshotBefore = await snapshot();
      results = [];
      for (const expectation of scenario.expectations) {
        results.push(await probe(engine, scenario, expectation));
      }
    }, 120_000);

    afterAll(async () => {
      await engine.close();
    });

    it("fails on exactly the declared cells, with the declared status", () => {
      const failing = results
        .filter((result) => ["leak", "escape"].includes(statusOf(result)))
        .map((result) => `${result.cell}: ${statusOf(result)}`);
      expect(failing).toEqual(variant.expectedFailures.map(failureName));
      expect(failing.length === 0 ? "ISOLATED" : "LEAKING").toBe(variant.expectedVerdict);
    });

    it("passes every other cell: nothing is overblocked", () => {
      const overblocked = results.filter((result) => result.missing.length > 0);
      expect(overblocked).toEqual([]);
    });

    it("has no cell that is a leak and an escape at once, so every status is unambiguous", () => {
      const both = results.filter((result) => result.leaked.length > 0 && result.escaped);
      expect(both).toEqual([]);
    });

    it("probed every cell and left the database unchanged", async () => {
      expect(results).toHaveLength(scenario.personas.length * scenario.tables.length * 4);
      expect(await snapshot()).toBe(snapshotBefore);
    });
  },
);
