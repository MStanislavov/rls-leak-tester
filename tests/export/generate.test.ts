/**
 * `generateCiExport` from hand-built runs: which files come out, what a cell without a plan
 * context becomes, and that scenario text cannot break out of a comment or a literal.
 */
import { describe, expect, it } from "vitest";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import {
  CI_EXPORT_FILE_NAMES,
  CORE_PRINCIPLE,
  CiExportError,
  DEFAULT_TOOL_NAME,
  generateCiExport,
  type CiExport,
} from "@/lib/export";
import { RESET_SESSION, supabasePrelude } from "@/lib/runner";
import type { Scenario } from "@/lib/scenario";
import { fileOf } from "./helpers";
import {
  MATRIX_TABLE,
  NOTES,
  NOTES_TRUTH,
  SCENARIO,
  cellResult,
  column,
  contextOf,
  resultOf,
} from "./unit-support";

function exportOf(
  scenario: Scenario,
  extra: Partial<Parameters<typeof generateCiExport>[0]> = {},
): CiExport {
  const contexts = [contextOf("select", "own"), contextOf("update", "own")];
  const cells = [
    cellResult("alice|public.notes|select"),
    cellResult("alice|public.notes|update"),
    cellResult("alice|public.nopk|select", {
      status: "skipped",
      reason: "The table has no primary key,\nso its rows cannot be tracked one by one.",
    }),
    cellResult("ghost|public.notes|select", { status: "inconclusive", reason: null }),
  ];
  return generateCiExport({
    scenario,
    run: { result: resultOf(scenario, cells), cellContexts: contexts },
    supabase: SUPABASE_SETUP_SQL,
    ...extra,
  });
}

describe("generateCiExport", () => {
  it("postgres mode: schema, seed, test and workflow, with their repository paths", () => {
    const { files, checkedCells, skippedCells } = exportOf(SCENARIO);
    expect(files.map(({ name, path, mediaType }) => [name, path, mediaType])).toEqual([
      ["rls-isolation.schema.sql", "rls-isolation/rls-isolation.schema.sql", "application/sql"],
      ["rls-isolation.seed.sql", "rls-isolation/rls-isolation.seed.sql", "application/sql"],
      ["rls-isolation.test.sql", "rls-isolation/rls-isolation.test.sql", "application/sql"],
      ["rls-isolation.yml", ".github/workflows/rls-isolation.yml", "application/yaml"],
    ]);
    expect([checkedCells, skippedCells]).toEqual([2, 2]);
    expect(files.every((file) => file.content.endsWith("\n"))).toBe(true);
  });

  it("emits the scenario's SQL as it is, under a comment, newline-terminated", () => {
    const ciExport = exportOf(SCENARIO);
    expect(fileOf(ciExport, CI_EXPORT_FILE_NAMES.schema)).toMatch(
      /^-- RLS Leak Tester: the schema of the scenario Unit scenario \[unit-scenario\].*\n-- .*\n\ncreate table notes \(id int primary key\);\n$/,
    );
    expect(
      fileOf(ciExport, CI_EXPORT_FILE_NAMES.seed).endsWith("\n\ninsert into notes values (1)\n"),
    ).toBe(true);
    expect(fileOf(exportOf({ ...SCENARIO, seedSql: "" }), CI_EXPORT_FILE_NAMES.seed)).toMatch(
      /\.\n\n$/,
    );
  });

  it("supabase mode: the setup file is exactly what setupDatabase runs before the schema", () => {
    const scenario: Scenario = {
      ...SCENARIO,
      mode: "supabase",
      options: { exposedSchemas: ["public", "api"], supabaseGrants: "explicit" },
    };
    const ciExport = exportOf(scenario);
    expect(ciExport.files.map((file) => file.name)).toEqual(Object.values(CI_EXPORT_FILE_NAMES));
    const setup = fileOf(ciExport, CI_EXPORT_FILE_NAMES.setup);
    for (const { script } of supabasePrelude(scenario, SUPABASE_SETUP_SQL)) {
      expect(setup).toContain(script.trim());
    }
    expect(setup).toContain('create schema if not exists "api";');
    expect(setup).toContain("revoke select, insert, update, delete on tables");
    expect(setup).toContain("Grants regime: explicit");
    expect(fileOf(ciExport, CI_EXPORT_FILE_NAMES.workflow)).toContain("RLS_SETUP_SQL");
    const legacy = fileOf(
      exportOf({ ...scenario, options: { exposedSchemas: [], supabaseGrants: "legacy" } }),
      CI_EXPORT_FILE_NAMES.test,
    );
    expect(legacy).toContain("-- Mode: supabase. Grants regime: legacy (");
  });

  it("the test file: header, the runner's session reset, one block per probed cell", () => {
    const sql = fileOf(exportOf(SCENARIO), CI_EXPORT_FILE_NAMES.test);
    const header = sql.slice(0, sql.indexOf("\n\n"));
    expect(header).toContain(`-- ${DEFAULT_TOOL_NAME}: CI isolation proof`);
    expect(header).toContain("-- Scenario: Unit scenario [unit-scenario]");
    expect(header).toContain("-- Mode: postgres.");
    expect(header).toContain(`-- Core principle: ${CORE_PRINCIPLE}`);
    expect(header).toContain("-- 2 of 4 cells");
    // A rollback does not take back a sequence: the header must not promise more than is true.
    expect(header).not.toContain("the database is unchanged afterwards");
    expect(header).toContain("rolls everything back: rows, roles and settings are as before.");
    expect(header).toContain("sequence");
    expect(header).toContain("GENERATED ALWAYS AS IDENTITY");
    expect(header.split("\n").every((line) => line.startsWith("--"))).toBe(true);
    expect(sql).toContain(
      `${RESET_SESSION.map((line) => `${line};`).join("\n")}\nset lc_messages = 'C';`,
    );
    // Every cell asks the preflight first whether the rows of its table are the exported ones.
    expect(
      sql.match(
        /^do \$rls\$\nbegin\n {2}if not pg_temp\.rls_leak_tester_ready\('public\.notes', 'alice\|public\.notes\|(select|update)'\) then\n {4}return;\n {2}end if;\n {2}perform pg_temp\.rls_leak_tester_\1_cell\(/gm,
      ),
    ).toHaveLength(2);
    expect(sql).not.toMatch(/^\\/m);
  });

  it("the preflight: roles, the tables of the exposed schemas, the seed of every probed table", () => {
    const scenario: Scenario = {
      ...SCENARIO,
      options: { exposedSchemas: ["public", "api"], supabaseGrants: "legacy" },
    };
    const result = {
      ...resultOf(scenario, [
        cellResult("alice|public.notes|select"),
        cellResult("alice|public.notes|update"),
      ]),
      tables: [
        { ...MATRIX_TABLE, name: "nopk", primaryKey: [] },
        { ...MATRIX_TABLE, name: "notes" },
      ],
    };
    const ciExport = generateCiExport({
      scenario,
      run: { result, cellContexts: [contextOf("select", "own"), contextOf("update", "own")] },
      supabase: SUPABASE_SETUP_SQL,
    });
    const sql = fileOf(ciExport, CI_EXPORT_FILE_NAMES.test);
    const header = sql.slice(0, sql.indexOf("\n\n"));
    expect(header).toContain("exposed schemas (public, api)");
    expect(header).toContain("A table added to one of");
    expect(sql).toContain(
      "perform pg_temp.rls_leak_tester_check_roles(\n    p_roles => array['app_user']::text[]",
    );
    expect(sql).toContain(
      `perform pg_temp.rls_leak_tester_check_tables(\n    p_schemas => array['public', 'api']::text[],\n    p_tables => '[["public","nopk"],["public","notes"]]'::jsonb\n  );`,
    );
    expect(sql.match(/perform pg_temp\.rls_leak_tester_check_seed\(/g)).toHaveLength(1);
    expect(sql).toContain(
      `    p_truth => '[["1"],["2"],["3"]]'::jsonb,\n    p_cells => 2,\n    p_volatile => null\n  );`,
    );
    expect(ciExport.warnings).toEqual([]);
  });

  it("keys that most likely come from a volatile default: a warning, and the cause in the seed check", () => {
    const table = {
      ...NOTES,
      columns: [column("id", "uuid", { default: "gen_random_uuid()" }), ...NOTES.columns.slice(1)],
    };
    const key = "0b0f7b5e-6d0c-4a59-9d53-3f0c3c4f7a11";
    const truth = {
      ...NOTES_TRUTH,
      rows: [{ key: JSON.stringify([key]), owner: null, tenant: null }],
    };
    const volatile = contextOf("select", "own", { table, truth, expectedKeys: [] });
    const exported = (seedSql: string): CiExport =>
      generateCiExport({
        scenario: { ...SCENARIO, seedSql },
        run: {
          result: resultOf(SCENARIO, [cellResult("alice|public.notes|select")]),
          cellContexts: [volatile],
        },
        supabase: SUPABASE_SETUP_SQL,
      });
    const relied = exported("insert into notes (user_id) values ('x')");
    expect(relied.warnings).toEqual([
      "public.notes: the keys of the seeded rows are not in the seed and the key column id defaults to gen_random_uuid(), so they most likely differ on every load. The exported check would then stop at its preflight on every run. Give the seed explicit keys, run the matrix and export again.",
    ]);
    expect(fileOf(relied, CI_EXPORT_FILE_NAMES.test)).toContain(
      "p_volatile => 'The key column id defaults to gen_random_uuid() and the seed does not spell the exported keys: they most likely come from that default and differ on every load, so this check cannot pass. Give the seed explicit keys, then run the matrix and export the check again.'",
    );
    // The seed spells the key (in any letter case): nothing to warn about.
    const explicit = exported(`insert into notes (id) values ('${key.toUpperCase()}')`);
    expect(explicit.warnings).toEqual([]);
    expect(fileOf(explicit, CI_EXPORT_FILE_NAMES.test)).toContain("p_volatile => null");
  });

  it("an update cell without a row to read a constant from has no blind statements", () => {
    const empty = { ...NOTES_TRUTH, rows: [] };
    const ciExport = generateCiExport({
      scenario: SCENARIO,
      run: {
        result: resultOf(SCENARIO, [cellResult("alice|public.notes|update")]),
        cellContexts: [contextOf("update", "all", { truth: empty, expectedKeys: [] })],
      },
      supabase: SUPABASE_SETUP_SQL,
    });
    const sql = fileOf(ciExport, CI_EXPORT_FILE_NAMES.test);
    expect(sql).toContain(
      "    p_blind_source => array[]::text[],\n    p_blind_versions => null,\n    p_blind_constants => array[]::text[],",
    );
  });

  it("a cell the run never probed is a comment with its status and reason, on one line each", () => {
    const sql = fileOf(exportOf(SCENARIO), CI_EXPORT_FILE_NAMES.test);
    expect(sql).toContain(
      "-- [3/4] alice|public.nopk|select: Alice as role app_user: SELECT on public.nopk, scope own\n" +
        "-- NOT CHECKED: skipped in the run this file was exported from: The table has no primary key, so its rows cannot be tracked one by one.\n",
    );
    expect(sql).toContain(
      "-- [4/4] ghost|public.notes|select: ghost as role ?: SELECT on public.notes, scope own\n" +
        "-- NOT CHECKED: inconclusive in the run this file was exported from: no reason recorded\n",
    );
  });

  it("scenario text cannot leave its comment or its literal", () => {
    const hostile: Scenario = {
      ...SCENARIO,
      title: "x\n; drop table notes; --",
      personas: [{ ...SCENARIO.personas[0]!, label: "O'Brien $rls$ $sql$ \\ %s" }],
    };
    const ciExport = exportOf(hostile, { toolName: "Tool's 100% \n$rls$" });
    const sql = fileOf(ciExport, CI_EXPORT_FILE_NAMES.test);
    expect(sql).toContain("-- Scenario: x ; drop table notes; -- [unit-scenario]\n");
    expect(sql).not.toMatch(/^; drop table/m);
    expect(sql).toContain("p_label => E'O''Brien $rls$ $sql$ \\\\ %s as role app_user: SELECT");
    // The block that holds `$rls$` in a literal is quoted with another tag.
    expect(sql).toContain(
      "do $rls1$\nbegin\n  if not pg_temp.rls_leak_tester_ready('public.notes', 'alice|public.notes|select') then\n    return;\n  end if;\n  perform pg_temp.rls_leak_tester_select_cell(",
    );
    expect(sql).toContain("v_tool constant text := 'Tool''s 100% \n$rls$';");
    for (const name of [CI_EXPORT_FILE_NAMES.schema, CI_EXPORT_FILE_NAMES.seed]) {
      expect(fileOf(ciExport, name).split("\n")[0]).toContain("x ; drop table notes; --");
    }
  });

  it("refuses a run of another scenario or another mode", () => {
    const other = resultOf({ ...SCENARIO, id: "another" }, []);
    expect(() =>
      generateCiExport({
        scenario: SCENARIO,
        run: { result: other, cellContexts: [] },
        supabase: SUPABASE_SETUP_SQL,
      }),
    ).toThrow(CiExportError);
    const otherMode = resultOf({ ...SCENARIO, mode: "supabase" }, []);
    expect(() =>
      generateCiExport({
        scenario: SCENARIO,
        run: { result: otherMode, cellContexts: [] },
        supabase: SUPABASE_SETUP_SQL,
      }),
    ).toThrow(/Run the matrix again before exporting/);
  });

  it("is deterministic", () => {
    expect(exportOf(SCENARIO)).toEqual(exportOf(SCENARIO));
  });
});
