/**
 * The self-isolation proof (brief 3.9, 3.10, 5.3, the gate of phase 7): RLS Leak Tester verifies
 * the table it stores shared scenarios in.
 *
 * The CI export of the template "own-scenarios-table" is EXECUTED in a fresh PGlite that was
 * prepared the way the CI job prepares Postgres: the setup file (Supabase shim, explicit grants),
 * then the files of `supabase/migrations` READ FROM DISK, then the seed. The fixed proof runs
 * green; the same proof against the leaky policy fails on exactly the declared cells, so a
 * migration that starts to expose unlisted rows turns the job red.
 *
 * `scripts/self-isolation/verify-postgres.sh` runs the same files against a real Postgres.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { CI_EXPORT_FILE_NAMES } from "@/lib/export";
import type { SqlEngine } from "@/lib/runner/types";
import { compareText, splitSqlStatements, type Scenario } from "@/lib/scenario";
import { OWN_SCENARIOS_TABLE, type TemplateVariant } from "@/lib/scenario/templates";
import {
  ALICE_SLUGS,
  BOB_SLUGS,
  PRIVATE_SCENARIO_IDS,
  PUBLIC_SCENARIO_IDS,
  SEED_ROWS_SQL,
  UNLISTED_SCENARIO_IDS,
} from "@/lib/scenario/templates/own-scenarios-table";
import {
  buildSelfProof,
  exportScenario,
  SELF_PROOF_FILE_NAMES,
  SelfProofError,
  type SelfProof,
} from "../../scripts/self-isolation/self-proof";
import {
  dumpEverything,
  failedCells,
  fileOf,
  runTestFile,
  type TestFileOutcome,
} from "../export/helpers";
import { cellOf, run } from "../runner/helpers";
import { BLOCKED, idsAs, loadScenario, personaOf } from "../templates/helpers";

const TIMEOUT_MS = 120_000;
const MIGRATIONS = path.resolve(import.meta.dirname, "..", "..", "supabase", "migrations");

function migrationFilesOnDisk(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort(compareText)
    .map((name) => readFileSync(path.join(MIGRATIONS, name), "utf8"));
}

/** `psql -f`: a session of its own, statement by statement, each committed on its own. */
async function psqlFile(engine: SqlEngine, content: string): Promise<void> {
  await engine.exec("discard all");
  await engine.exec("set time zone 'UTC'");
  for (const statement of splitSqlStatements(content)) {
    await engine.exec(statement.text);
  }
}

/** A fresh database after the CI job's steps: setup file, schema files, seed. The caller closes it. */
async function prepareLikeCiJob(
  proofFiles: SelfProof["files"],
  schemaFiles: readonly string[],
): Promise<SqlEngine> {
  const contentOf = (name: string): string =>
    proofFiles.find((file) => file.name === name)?.content ?? "";
  const engine = await createPgliteEngine();
  for (const content of [
    contentOf(CI_EXPORT_FILE_NAMES.setup),
    ...schemaFiles,
    contentOf(CI_EXPORT_FILE_NAMES.seed),
  ]) {
    await psqlFile(engine, content);
  }
  await engine.exec("discard all");
  return engine;
}

interface Executed {
  readonly outcome: TestFileOutcome;
  readonly before: string;
  readonly after: string;
}

async function execute(
  proof: SelfProof,
  schemaFiles: readonly string[],
  testSql: string,
): Promise<Executed> {
  const engine = await prepareLikeCiJob(proof.files, schemaFiles);
  try {
    const before = await dumpEverything(engine);
    const outcome = await runTestFile(engine, testSql);
    return { outcome, before, after: await dumpEverything(engine) };
  } finally {
    await engine.close();
  }
}

function declared(variant: TemplateVariant): string[] {
  return variant.expectedFailures
    .map(
      (failure) =>
        `${failure.status} ${failure.personaId}|${failure.schema}.${failure.table}|${failure.operation}`,
    )
    .sort(compareText);
}

function reported(outcome: TestFileOutcome): string[] {
  return outcome.passed
    ? []
    : failedCells(outcome.error)
        .map((cell) => `${cell.status} ${cell.id}`)
        .sort(compareText);
}

describe("self-isolation proof: the exported check against supabase/migrations", () => {
  let proof: SelfProof;
  let testSql: string;

  beforeAll(async () => {
    proof = await buildSelfProof();
    testSql = proof.files.find((file) => file.name === CI_EXPORT_FILE_NAMES.test)?.content ?? "";
  }, TIMEOUT_MS);

  it("consists of the setup file, the seed and the test file; the schema is the migrations", () => {
    expect(proof.files.map((file) => file.name)).toEqual([...SELF_PROOF_FILE_NAMES]);
    expect(proof.files.map((file) => file.name)).not.toContain(CI_EXPORT_FILE_NAMES.schema);
    expect(proof.files.every((file) => file.content.length > 0)).toBe(true);
    expect(fileOf(proof.ciExport, CI_EXPORT_FILE_NAMES.schema)).toContain(
      migrationFilesOnDisk().join("\n").trim(),
    );
    expect(proof.ciExport.checkedCells).toBe(20);
    expect(proof.ciExport.skippedCells).toBe(0);
    expect(proof.matrix.result.verdict).toBe("ISOLATED");
  });

  it(
    "passes on a database built from the shim, the migration files on disk and the seed",
    async () => {
      const fixed = await execute(proof, migrationFilesOnDisk(), testSql);
      expect(fixed.outcome).toEqual({ passed: true });
      expect(fixed.after).toBe(fixed.before);
    },
    TIMEOUT_MS,
  );

  it(
    "fails on exactly the declared cells when the migration has the leaky policy",
    async () => {
      const { leaky } = OWN_SCENARIOS_TABLE;
      const broken = await execute(proof, [leaky.scenario.schemaSql], testSql);
      expect(declared(leaky)).toEqual([
        "leak alice|public.scenarios|select",
        "leak anon|public.scenarios|select",
        "leak bob|public.scenarios|select",
        "leak carol|public.scenarios|select",
      ]);
      expect(reported(broken.outcome)).toEqual(declared(leaky));
      expect(broken.after).toBe(broken.before);
      if (!broken.outcome.passed) {
        expect(broken.outcome.error.code).toBe("P0001");
        // The unlisted rows are named as the evidence: anon lists both of them.
        const anonLine = failedCells(broken.outcome.error).find(
          (cell) => cell.id === "anon|public.scenarios|select",
        );
        for (const id of UNLISTED_SCENARIO_IDS) {
          expect(anonLine?.line).toContain(id);
        }
      }
    },
    TIMEOUT_MS,
  );

  it(
    "the leaky variant's own export fails on the same cells",
    async () => {
      const { leaky } = OWN_SCENARIOS_TABLE;
      const exported = await exportScenario(leaky.scenario);
      expect(exported.matrix.result.verdict).toBe("LEAKING");
      const outcome = await execute(
        proof,
        [leaky.scenario.schemaSql],
        fileOf(exported.ciExport, CI_EXPORT_FILE_NAMES.test),
      );
      expect(reported(outcome.outcome)).toEqual(declared(leaky));
    },
    TIMEOUT_MS,
  );

  it("refuses to build a proof for a schema that is not the template's", async () => {
    await expect(buildSelfProof("create table t ();")).rejects.toThrow(SelfProofError);
    await expect(buildSelfProof("create table t ();")).rejects.toThrow("sync-template.mjs");
  });
});

describe("get_scenario_by_slug: an unlisted scenario opens by its exact slug and cannot be listed", () => {
  const { scenario } = OWN_SCENARIOS_TABLE.fixed;
  const bySlug = "select id from public.get_scenario_by_slug($1)";
  const list = "select id from public.scenarios";
  let engine: SqlEngine;

  const as = (personaId: string, sql: string, params: string[] = []) =>
    idsAs(engine, personaOf(scenario, personaId), sql, params);

  beforeAll(async () => {
    engine = await loadScenario(scenario);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await engine.close();
  });

  it("anon gets Bob's unlisted scenario with the exact slug", async () => {
    expect(await as("anon", bySlug, [BOB_SLUGS.unlisted])).toEqual([UNLISTED_SCENARIO_IDS[1]]);
    expect(await as("anon", bySlug, [ALICE_SLUGS.unlisted])).toEqual([UNLISTED_SCENARIO_IDS[0]]);
    expect(await as("anon", bySlug, [ALICE_SLUGS.public])).toEqual([PUBLIC_SCENARIO_IDS[0]]);
  });

  it("anon cannot enumerate unlisted rows: not through the table, not through the function", async () => {
    expect(await as("anon", list)).toEqual([...PUBLIC_SCENARIO_IDS].sort(compareText));
    expect(await as("anon", `${list} where visibility = 'unlisted'`)).toEqual([]);
    expect(await as("anon", `${list} where slug = $1`, [BOB_SLUGS.unlisted])).toEqual([]);
    expect(await as("anon", "select count(*)::text as id from public.scenarios")).toEqual(["2"]);
    // The function compares with `=`: no pattern, no prefix, no other case, no NULL.
    for (const guess of ["%", "bob-%", "bob-client", BOB_SLUGS.unlisted.toUpperCase(), ""]) {
      expect(await as("anon", bySlug, [guess]), guess).toEqual([]);
    }
    expect(await as("anon", "select id from public.get_scenario_by_slug(null)")).toEqual([]);
  });

  it("a private scenario opens for its owner only, with or without the slug", async () => {
    expect(await as("anon", bySlug, [BOB_SLUGS.private])).toEqual([]);
    expect(await as("alice", bySlug, [BOB_SLUGS.private])).toEqual([]);
    expect(await as("carol", bySlug, [BOB_SLUGS.private])).toEqual([]);
    expect(await as("bob", bySlug, [BOB_SLUGS.private])).toEqual([PRIVATE_SCENARIO_IDS[1]]);
  });

  it("a signed-in stranger is treated like anon: the slug opens, a query lists nothing unlisted", async () => {
    expect(await as("carol", bySlug, [ALICE_SLUGS.unlisted])).toEqual([UNLISTED_SCENARIO_IDS[0]]);
    expect(await as("carol", list)).toEqual([...PUBLIC_SCENARIO_IDS].sort(compareText));
    expect(await as("alice", `${list} where visibility = 'unlisted'`)).toEqual([
      UNLISTED_SCENARIO_IDS[0],
    ]);
  });

  it("service_role may not even call the function: the migration revokes EXECUTE", async () => {
    expect(await as("service", bySlug, [ALICE_SLUGS.public])).toBe(BLOCKED);
  });
});

describe("why the seed carries a probe harness", () => {
  it(
    "without it an allowed insert collides on the unique slug: 23505, inconclusive",
    async () => {
      const bare: Scenario = {
        ...OWN_SCENARIOS_TABLE.fixed.scenario,
        id: "own-scenarios-table-no-harness",
        seedSql: SEED_ROWS_SQL,
      };
      const { result } = await run(bare);
      const insert = cellOf(result, "alice", "scenarios", "insert");
      expect(insert.status).toBe("inconclusive");
      expect(insert.error?.sqlState).toBe("23505");
      expect(insert.error?.message).toContain("scenarios_slug_key");
      // The isolation half is proven either way: RLS refuses the foreign row before the index does.
      expect(
        insert.subProbes.map((probe) => `${probe.kind} ${probe.expected} ${probe.status}`),
      ).toEqual(["insert-own allowed inconclusive", "insert-other blocked pass"]);
      expect(result.counts).toMatchObject({ leak: 0, escape: 0, inconclusive: 2 });
    },
    TIMEOUT_MS,
  );
});
