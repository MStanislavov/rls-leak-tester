import { describe, expect, it } from "vitest";
import { NOT_ABOUT_THE_ROWS, ROW_SECURITY_VIOLATION, STATEMENT_DENIAL } from "@/lib/runner";
import {
  EMPTY_REPORT,
  REPORT_SETTING,
  RUNTIME_FUNCTIONS,
  SEED_CHANGED_ADVICE,
  dropRuntimeSql,
  runtimeName,
  runtimeSql,
  toPostgresPattern,
} from "./runtime";

describe("toPostgresPattern", () => {
  it("spells the word boundary the Postgres way and leaves the rest alone", () => {
    expect(toPostgresPattern(/^(a|b c)\b|d/)).toBe("^(a|b c)\\y|d");
    expect(toPostgresPattern(NOT_ABOUT_THE_ROWS)).toContain("|parameter)\\y|query would be");
    expect(toPostgresPattern(ROW_SECURITY_VIOLATION)).toBe(ROW_SECURITY_VIOLATION.source);
    expect(toPostgresPattern(STATEMENT_DENIAL)).toBe(STATEMENT_DENIAL.source);
  });

  it("refuses a pattern with flags: case folding would not travel", () => {
    expect(() => toPostgresPattern(/denied/i)).toThrow(RangeError);
  });

  it("the classifier's patterns use nothing else that the two dialects spell differently", () => {
    for (const pattern of [NOT_ABOUT_THE_ROWS, ROW_SECURITY_VIOLATION, STATEMENT_DENIAL]) {
      // Escapes other than \b (\d, \w, \s, lookarounds, named groups) would need a translation.
      expect(pattern.source.replaceAll("\\b", "")).not.toMatch(/\\|\(\?/);
    }
  });
});

describe("runtimeSql", () => {
  const sql = runtimeSql(3, "fail");

  it("creates every function it later drops, in pg_temp", () => {
    const created = [...sql.matchAll(/^create or replace function (\S+?)\(/gm)].map(
      (match) => match[1],
    );
    expect(created).toEqual(RUNTIME_FUNCTIONS.map((name) => runtimeName(name)));
    expect(created.every((name) => name?.startsWith("pg_temp.rls_leak_tester_"))).toBe(true);
    expect(dropRuntimeSql().split("\n")).toEqual(
      [...RUNTIME_FUNCTIONS].reverse().map((name) => `drop function ${runtimeName(name)};`),
    );
  });

  it("binds as many parameters as the file needs, and at least one", () => {
    expect(sql).toContain("using p_params[1], p_params[2], p_params[3] loop");
    expect(sql).not.toContain("p_params[4]");
    expect(runtimeSql(0, "fail")).toContain("using p_params[1] loop");
  });

  it("embeds the runner's identity check, role reset and classifier patterns", () => {
    expect(sql).toContain("select current_user::text as role, session_user::text as session_role");
    expect(sql).toContain("execute 'reset role';");
    expect(sql).toContain("permission denied for (schema|type|sequence");
    expect(sql).toContain(`current_setting('${REPORT_SETTING}')`);
  });

  it("an inconclusive cell fails the run, or is a warning on request", () => {
    expect(sql).toContain("if true then\n      v_bucket := 'failed';");
    expect(runtimeSql(3, "warn")).toContain(
      "if p_status <> 'inconclusive' then\n      v_bucket := 'failed';",
    );
  });

  it("a preflight line is a setup problem, never a failed cell, and it fails the run all the same", () => {
    expect(sql).toContain("if p_status = 'setup' then\n      v_bucket := 'setup';");
    expect(Object.keys(EMPTY_REPORT)).toEqual([
      "passed",
      "failed",
      "warned",
      "setup",
      "stale",
      "not_run",
    ]);
  });

  it("a stale seed marks its table, and the cells of a marked table are not run", () => {
    expect(sql).toContain(
      "jsonb_set(v_report, '{stale}', (v_report -> 'stale') || to_jsonb(p_table))",
    );
    expect(sql).toContain("jsonb_array_elements_text(v_report -> 'stale')");
    expect(sql).toContain("raise notice 'not run - %: the rows of % are not the exported ones'");
    expect(sql).toContain(SEED_CHANGED_ADVICE.replaceAll("'", "''"));
    expect(SEED_CHANGED_ADVICE).toContain("gen_random_uuid()");
  });

  it("lists the tables of the exposed schemas the way the runner's introspection does", () => {
    expect(sql).toContain("where c.relkind in ('r', 'p') and n.nspname = any (p_schemas)");
  });

  it("a blind constant without the UPDATE privilege is skipped, not counted as refused", () => {
    expect(sql).toContain(
      "if v_index <= v_constants and pg_temp.rls_leak_tester_blocked(v_state, v_message) and pg_temp.rls_leak_tester_statement_denial(v_state, v_message) then",
    );
  });

  it("is deterministic", () => {
    expect(runtimeSql(3, "fail")).toBe(sql);
  });
});
