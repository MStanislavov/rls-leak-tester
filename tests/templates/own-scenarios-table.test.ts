/**
 * Drift guard of the fourth template: the SQL it carries is the SQL of `supabase/migrations`,
 * byte for byte, and the generated module is what the sync script would write today. The leaky
 * variant differs from that SQL in one policy expression.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "@/lib/scenario";
import { OWN_SCENARIOS_TABLE } from "@/lib/scenario/templates";
import { OWN_SCENARIOS_MIGRATIONS_SQL } from "@/lib/scenario/templates/own-scenarios-migrations";
import {
  FIXED_PUBLIC_READ_USING,
  LEAKY_PUBLIC_READ_USING,
  leakySchemaSql,
  PROBE_SLUG_HARNESS_SQL,
  SEED_ROWS_SQL,
} from "@/lib/scenario/templates/own-scenarios-table";
import {
  MIGRATIONS_DIRECTORY,
  MODULE_PATH,
  readMigrationsSql,
  renderModule,
} from "../../scripts/self-isolation/sync-template.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Computed here, not by the script: the files in name order, joined by a newline. */
function migrationsOnDisk(): string {
  const directory = path.join(REPO_ROOT, "supabase", "migrations");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => (a < b ? -1 : 1))
    .map((name) => readFileSync(path.join(directory, name), "utf8"))
    .join("\n");
}

describe("own-scenarios-table: the template is the migrations", () => {
  it("carries the concatenated migration files, byte for byte", () => {
    expect(MIGRATIONS_DIRECTORY).toBe("supabase/migrations");
    expect(migrationsOnDisk().length).toBeGreaterThan(1000);
    expect(OWN_SCENARIOS_MIGRATIONS_SQL).toBe(migrationsOnDisk());
    expect(readMigrationsSql()).toBe(migrationsOnDisk());
  });

  it("uses exactly that SQL as the schema of the fixed variant", () => {
    expect(OWN_SCENARIOS_TABLE.fixed.scenario.schemaSql).toBe(migrationsOnDisk());
  });

  it("has a generated module that the sync script would write unchanged", () => {
    const onDisk = readFileSync(path.join(REPO_ROOT, MODULE_PATH), "utf8");
    expect(onDisk).toBe(renderModule(migrationsOnDisk()));
  });

  it("escapes what a template literal would interpret", () => {
    const rendered = renderModule("select '\\d', `x`, '${y}';\n", ["a.sql"]);
    expect(rendered).toContain("select '\\\\d', \\`x\\`, '\\${y}';");
    expect(rendered).toContain("supabase/migrations/a.sql");
  });
});

describe("own-scenarios-table: the leaky variant", () => {
  it("differs from the migrations in the USING of the public read policy only", () => {
    const fixed = OWN_SCENARIOS_TABLE.fixed.scenario.schemaSql;
    const leaky = OWN_SCENARIOS_TABLE.leaky.scenario.schemaSql;
    expect(leaky).toBe(fixed.replace(FIXED_PUBLIC_READ_USING, LEAKY_PUBLIC_READ_USING));
    expect(leaky).toContain("using (visibility in ('public', 'unlisted'));");
    expect(splitSqlStatements(leaky)).toHaveLength(splitSqlStatements(fixed).length);
  });

  it("refuses a migration in which the expression is missing or ambiguous", () => {
    expect(() => leakySchemaSql("create table t ();")).toThrow("exactly once, found 0");
    expect(() => leakySchemaSql(`${FIXED_PUBLIC_READ_USING}\n${FIXED_PUBLIC_READ_USING}`)).toThrow(
      "exactly once, found 2",
    );
  });
});

describe("own-scenarios-table: the seed", () => {
  it("is the rows followed by the probe harness, and the harness touches the slug only", () => {
    const { seedSql } = OWN_SCENARIOS_TABLE.fixed.scenario;
    expect(seedSql).toBe(`${SEED_ROWS_SQL}\n${PROBE_SLUG_HARNESS_SQL}`);
    expect(PROBE_SLUG_HARNESS_SQL).toContain("new.slug :=");
    expect(PROBE_SLUG_HARNESS_SQL).not.toMatch(/new\.(owner|visibility|id)\s*:=/);
    expect(PROBE_SLUG_HARNESS_SQL).not.toMatch(/security\s+definer/i);
  });
});
