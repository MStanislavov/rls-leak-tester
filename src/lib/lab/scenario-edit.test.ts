import { describe, expect, it } from "vitest";
import { MAX_PERSONAS, parseScenario, type Scenario } from "@/lib/scenario";
import { MULTI_TENANT_SAAS } from "@/lib/scenario/templates";
import { formatClaims, parseClaimsText } from "./claims-text";
import {
  addPersona,
  blankScenario,
  canAddPersona,
  findExpectation,
  removePersona,
  resetTableConfig,
  scenarioFromTemplate,
  setExpectation,
  setTableColumn,
  sqlOf,
  starterExpectedRowsSql,
  updatePersona,
  withGrants,
  withMode,
  withSql,
  withTitle,
} from "./scenario-edit";
import {
  parseScenarioFile,
  renamedScenario,
  scenarioFileName,
  scenarioFileText,
} from "./scenario-file";
import { formatIssue, issuesUnder, personaIssues, validateLabScenario } from "./validation";

const SUB = "12345678-1234-4234-8234-123456789abc";
const CELL = {
  personaId: "user-a",
  schema: "public",
  table: "notes",
  operation: "select",
} as const;

function base(): Scenario {
  return blankScenario("blank-1");
}

describe("blankScenario and templates", () => {
  it("is a valid scenario", () => {
    expect(parseScenario(base())).toMatchObject({ ok: true });
  });

  it("copies a template so edits never reach the constant", () => {
    const copy = scenarioFromTemplate(MULTI_TENANT_SAAS, "leaky");
    expect(copy).toEqual(MULTI_TENANT_SAAS.leaky.scenario);
    const first = copy.personas[0];
    if (first !== undefined) {
      first.label = "changed";
    }
    copy.expectations.length = 0;
    expect(MULTI_TENANT_SAAS.leaky.scenario.personas[0]?.label).not.toBe("changed");
    expect(MULTI_TENANT_SAAS.leaky.scenario.expectations.length).toBeGreaterThan(0);
    expect(scenarioFromTemplate(MULTI_TENANT_SAAS, "fixed").id).toBe("multi-tenant-saas-fixed");
  });
});

describe("simple fields", () => {
  it("sets SQL, title, mode and grants without touching the input", () => {
    const scenario = base();
    const next = withGrants(
      withMode(
        withTitle(withSql(withSql(scenario, "schema", "select 1"), "seed", "select 2"), "T"),
        "postgres",
      ),
      "explicit",
    );
    expect(sqlOf(next, "schema")).toBe("select 1");
    expect(sqlOf(next, "seed")).toBe("select 2");
    expect(next.title).toBe("T");
    expect(next.mode).toBe("postgres");
    expect(next.options).toEqual({ exposedSchemas: ["public"], supabaseGrants: "explicit" });
    expect(scenario.schemaSql).toBe("");
    expect(scenario.mode).toBe("supabase");
  });

  it("fills the default options when the scenario has none", () => {
    const withoutOptions = base();
    delete withoutOptions.options;
    expect(withGrants(withoutOptions, "explicit").options).toEqual({
      exposedSchemas: ["public"],
      supabaseGrants: "explicit",
    });
  });
});

describe("personas", () => {
  it("adds a signed-in user with a fresh id", () => {
    const next = addPersona(base(), SUB);
    expect(next.personas.at(-1)).toEqual({
      id: "user-4",
      label: "User 4",
      dbRole: "authenticated",
      claims: { sub: SUB },
    });
    expect(parseScenario(next)).toMatchObject({ ok: true });
  });

  it("skips ids that are taken", () => {
    const scenario = base();
    scenario.personas.push({ id: "user-4", label: "x", dbRole: "anon", claims: {} });
    expect(addPersona(scenario, SUB).personas.at(-1)?.id).toBe("user-5");
  });

  it("uses the last custom role in postgres mode, else app_user", () => {
    const plain = withMode(base(), "postgres");
    expect(addPersona(plain, "1").personas.at(-1)?.dbRole).toBe("authenticated");
    const onlyAnon = { ...plain, personas: plain.personas.slice(0, 1) };
    expect(addPersona(onlyAnon, "1").personas.at(-1)?.dbRole).toBe("app_user");
  });

  it("stops at the persona limit", () => {
    let scenario = base();
    while (canAddPersona(scenario)) {
      scenario = addPersona(scenario, SUB);
    }
    expect(scenario.personas).toHaveLength(MAX_PERSONAS);
    expect(addPersona(scenario, SUB)).toBe(scenario);
  });

  it("removes a persona together with its expectations", () => {
    const scenario = setExpectation(base(), CELL, "own");
    const next = removePersona(scenario, "user-a");
    expect(next.personas.map((persona) => persona.id)).toEqual(["anon", "user-b"]);
    expect(next.expectations).toEqual([]);
  });

  it("updates fields and drops an empty tenant claim path", () => {
    const withPath = updatePersona(base(), "user-a", {
      label: "Alice",
      tenantClaimPath: "app_metadata.tenant_id",
    });
    expect(withPath.personas[1]).toMatchObject({
      label: "Alice",
      tenantClaimPath: "app_metadata.tenant_id",
    });
    const cleared = updatePersona(withPath, "user-a", { tenantClaimPath: "  " });
    expect(Object.hasOwn(cleared.personas[1] ?? {}, "tenantClaimPath")).toBe(false);
    expect(cleared.personas[0]).toBe(withPath.personas[0]);
  });
});

describe("table configs", () => {
  const suggested = { schema: "public", name: "notes", ownerColumn: "user_id" };

  it("starts an override from the effective config", () => {
    const next = setTableColumn(base(), suggested, "tenantColumn", "org_id");
    expect(next.tables).toEqual([
      { schema: "public", name: "notes", ownerColumn: "user_id", tenantColumn: "org_id" },
    ]);
  });

  it("clears a column with undefined or an empty value, and replaces the entry", () => {
    const first = setTableColumn(base(), suggested, "tenantColumn", "org_id");
    const effective = first.tables[0] ?? suggested;
    const second = setTableColumn(first, effective, "ownerColumn", undefined);
    expect(second.tables).toEqual([{ schema: "public", name: "notes", tenantColumn: "org_id" }]);
    const third = setTableColumn(second, second.tables[0] ?? suggested, "tenantColumn", "");
    expect(third.tables).toEqual([{ schema: "public", name: "notes" }]);
  });

  it("resets to the heuristics", () => {
    const next = setTableColumn(base(), suggested, "tenantColumn", "org_id");
    expect(resetTableConfig(next, { schema: "public", name: "notes" }).tables).toEqual([]);
  });
});

describe("expectations", () => {
  it("sets, replaces and removes a cell", () => {
    const own = setExpectation(base(), CELL, "own");
    expect(findExpectation(own, CELL)).toEqual({ ...CELL, scope: "own" });
    const all = setExpectation(own, CELL, "all");
    expect(all.expectations).toEqual([{ ...CELL, scope: "all" }]);
    expect(setExpectation(all, CELL, "default").expectations).toEqual([]);
  });

  it("keeps the SQL of a custom cell, takes a new one, and drops it for other scopes", () => {
    const custom = setExpectation(base(), CELL, "custom", "select id from public.notes");
    expect(findExpectation(custom, CELL)?.expectedRowsSql).toBe("select id from public.notes");
    expect(findExpectation(setExpectation(custom, CELL, "custom"), CELL)?.expectedRowsSql).toBe(
      "select id from public.notes",
    );
    expect(
      findExpectation(setExpectation(custom, CELL, "custom", "select 1"), CELL)?.expectedRowsSql,
    ).toBe("select 1");
    const own = findExpectation(setExpectation(custom, CELL, "own"), CELL);
    expect(own).toEqual({ ...CELL, scope: "own" });
    expect(findExpectation(setExpectation(base(), CELL, "custom"), CELL)?.expectedRowsSql).toBe("");
  });

  it("does not touch other cells", () => {
    const other = { ...CELL, operation: "delete" } as const;
    const next = setExpectation(setExpectation(base(), CELL, "own"), other, "none");
    expect(next.expectations).toHaveLength(2);
    expect(findExpectation(next, { ...CELL, personaId: "nobody" })).toBeUndefined();
  });

  it("builds a starter query that expects nothing", () => {
    expect(starterExpectedRowsSql({ schema: "public", name: "notes" }, ["id"])).toBe(
      'select "id" from "public"."notes" where false',
    );
    expect(starterExpectedRowsSql({ schema: "app", name: "t" }, ["a", "b"])).toBe(
      'select "a", "b" from "app"."t" where false',
    );
    expect(starterExpectedRowsSql({ schema: "app", name: "t" }, [])).toContain("select id from");
  });
});

describe("claims text", () => {
  it("accepts an object and an empty text", () => {
    expect(parseClaimsText('{"sub":"1","app_metadata":{"tenant_id":"t"}}')).toEqual({
      ok: true,
      claims: { sub: "1", app_metadata: { tenant_id: "t" } },
    });
    expect(parseClaimsText("  ")).toEqual({ ok: true, claims: {} });
  });

  it("refuses broken JSON, non-objects and claims the schema refuses", () => {
    expect(parseClaimsText("{")).toMatchObject({ ok: false });
    expect(parseClaimsText("[1]")).toMatchObject({ ok: false });
    expect(parseClaimsText("null")).toMatchObject({ ok: false });
    expect(parseClaimsText('"text"')).toMatchObject({ ok: false });
    const deep = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } });
    const result = parseClaimsText(deep);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("nest");
  });

  it("formats claims with two spaces", () => {
    expect(formatClaims({ sub: "1" })).toBe('{\n  "sub": "1"\n}');
  });
});

describe("validation", () => {
  it("passes a valid scenario through the parser", () => {
    const result = validateLabScenario(base());
    expect(result.ok).toBe(true);
    expect(result.scenario).toEqual(base());
    expect(result.issues).toEqual([]);
  });

  it("lists issues with their paths and finds those of one persona", () => {
    const scenario = updatePersona(base(), "user-a", { claims: { sub: "not-a-uuid" }, label: "" });
    const result = validateLabScenario(scenario);
    expect(result.ok).toBe(false);
    expect(result.scenario).toBeNull();
    expect(personaIssues(result.issues, 1).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["personas[1].label", "personas[1].claims.sub"]),
    );
    expect(personaIssues(result.issues, 0)).toEqual([]);
    expect(issuesUnder(result.issues, "personas")).toHaveLength(result.issues.length);
    expect(issuesUnder([{ path: "personas[10]", message: "m" }], "personas[1]")).toEqual([]);
  });

  it("formats an issue with and without a path", () => {
    expect(formatIssue({ path: "title", message: "must not be empty" })).toBe(
      "title: must not be empty",
    );
    expect(formatIssue({ path: "", message: "A scenario must be a JSON object" })).toBe(
      "A scenario must be a JSON object",
    );
  });
});

describe("scenario files", () => {
  it("names the file after the title", () => {
    expect(scenarioFileName({ title: "My SaaS: v2" })).toBe("my-saas-v2.scenario.json");
    expect(scenarioFileName({ title: "!!!" })).toBe("scenario.scenario.json");
  });

  it("round-trips through the file text", () => {
    const scenario = scenarioFromTemplate(MULTI_TENANT_SAAS, "leaky");
    const parsed = parseScenarioFile(scenarioFileText(scenario));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? scenarioFileText(parsed.scenario) : "").toBe(scenarioFileText(scenario));
    expect(parseScenarioFile("not json")).toMatchObject({ ok: false });
    expect(parseScenarioFile('{"version":1}')).toMatchObject({ ok: false });
  });

  it("renames for save as, keeping the old title when the new one is empty", () => {
    expect(renamedScenario(base(), "new-id", "  Copy  ")).toMatchObject({
      id: "new-id",
      title: "Copy",
    });
    expect(renamedScenario(base(), "new-id", "   ").title).toBe("Untitled scenario");
    expect(renamedScenario(base(), "new-id", "x".repeat(500)).title).toHaveLength(120);
  });
});
