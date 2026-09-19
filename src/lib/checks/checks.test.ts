/**
 * The rules on hand-built catalogs: every branch that needs no database. The same rules run
 * against real SQL in tests/checks/static-checks.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import type {
  Catalog,
  CatalogFunction,
  CatalogPolicy,
  CatalogRole,
  CatalogTable,
  CatalogTablePrivilege,
  CatalogView,
} from "@/lib/runner/introspect";
import * as api from "./index";
import {
  CHECK_IDS,
  SEVERITIES,
  STATIC_CHECK_RULES,
  compareFindings,
  countBySeverity,
  ruleById,
  runStaticChecks,
  type CheckId,
  type Finding,
  type StaticCheckContext,
} from "./index";
import { applicationRoles, bypassesRls, privilegesOf } from "./roles";

const SUPABASE: StaticCheckContext = { mode: "supabase", personas: [] };
const EXPLICIT: StaticCheckContext = {
  ...SUPABASE,
  options: { exposedSchemas: ["public"], supabaseGrants: "explicit" },
};
const postgres = (...roles: string[]): StaticCheckContext => ({
  mode: "postgres",
  personas: roles.map((dbRole) => ({ dbRole })),
});

function catalogOf(parts: Partial<Catalog>): Catalog {
  return {
    exposedSchemas: ["public"],
    missingSchemas: [],
    tables: [],
    policies: [],
    tablePrivileges: [],
    roles: [],
    views: [],
    functions: [],
    ...parts,
  };
}

function table(name: string, parts: Partial<CatalogTable> = {}): CatalogTable {
  return {
    schema: "public",
    name,
    owner: "postgres",
    rlsEnabled: true,
    rlsForced: false,
    partitioned: false,
    columns: [],
    primaryKey: ["id"],
    ...parts,
  };
}

function policy(name: string, parts: Partial<CatalogPolicy> = {}): CatalogPolicy {
  return {
    schema: "public",
    table: "docs",
    name,
    command: "select",
    permissive: true,
    roles: ["authenticated"],
    using: "(auth.uid() = user_id)",
    withCheck: null,
    ...parts,
  };
}

function role(name: string, parts: Partial<CatalogRole> = {}): CatalogRole {
  return {
    name,
    superuser: false,
    bypassRls: false,
    inherit: true,
    canLogin: false,
    memberOf: [],
    ...parts,
  };
}

function grants(tableName: string, grantee: string, ...privileges: string[]) {
  return privileges.map((privilege): CatalogTablePrivilege => ({
    schema: "public",
    table: tableName,
    grantee,
    privilege,
    grantable: false,
  }));
}

function view(name: string, parts: Partial<CatalogView> = {}): CatalogView {
  return {
    schema: "public",
    name,
    owner: "postgres",
    materialized: false,
    definition: "SELECT id FROM docs;",
    securityInvoker: false,
    references: [{ schema: "public", name: "docs", kind: "table" }],
    ...parts,
  };
}

function fn(name: string, parts: Partial<CatalogFunction> = {}): CatalogFunction {
  return {
    schema: "public",
    name,
    identityArguments: "",
    kind: "function",
    owner: "postgres",
    language: "sql",
    securityDefiner: true,
    searchPath: null,
    ...parts,
  };
}

const POSTGRES_ROLE = role("postgres", { superuser: true, bypassRls: true });

function ids(findings: readonly Finding[], id: CheckId): string[] {
  return findings.filter((entry) => entry.id === id).map((entry) => entry.object.name);
}

function evidenceOf(entry: Finding | undefined): string[] {
  return (entry?.evidence ?? []).map((line) => `${line.label}: ${line.value}`);
}

describe("RLS001 and RLS002", () => {
  it("flags a table without RLS as critical and one without policies as info", () => {
    const catalog = catalogOf({
      tables: [table("open", { rlsEnabled: false }), table("locked"), table("docs")],
      policies: [policy("own")],
      tablePrivileges: grants("open", "anon", "SELECT", "MAINTAIN"),
    });
    const findings = runStaticChecks(catalog, SUPABASE);

    expect(ids(findings, "RLS001")).toEqual(["open"]);
    expect(ids(findings, "RLS002")).toEqual(["locked"]);
    expect(findings[0]).toMatchObject({
      id: "RLS001",
      severity: "critical",
      object: { kind: "table", schema: "public", name: "open", qualifiedName: '"public"."open"' },
      docsUrl: "https://supabase.com/docs/guides/api/securing-your-api",
    });
    expect(evidenceOf(findings[0])).toEqual([
      "row level security: not enabled",
      "owner: postgres",
      "granted to anon: SELECT",
    ]);
    expect(findings[0]?.explanation).toContain("only barrier");
  });

  it("says so when no application role holds a privilege, and links the Postgres page", () => {
    const [finding] = runStaticChecks(
      catalogOf({ tables: [table("open", { rlsEnabled: false })] }),
      postgres("app"),
    );

    expect(finding?.explanation).toContain("a single GRANT would expose every row");
    expect(finding?.docsUrl).toBe("https://www.postgresql.org/docs/current/ddl-rowsecurity.html");
  });
});

describe("RLS003", () => {
  const tables = [table("docs")];

  it("flags USING and WITH CHECK true for PUBLIC and for named roles", () => {
    const catalog = catalogOf({
      tables,
      policies: [
        policy("everyone", { roles: ["PUBLIC"], using: "true" }),
        policy("writers", { command: "all", using: "true", withCheck: "true" }),
        policy("mixed", { roles: ["authenticated", "service_role"], using: "true" }),
      ],
    });
    const findings = runStaticChecks(catalog, SUPABASE).filter((entry) => entry.id === "RLS003");

    expect(findings.map((entry) => entry.object.qualifiedName)).toEqual([
      '"everyone" ON "public"."docs"',
      '"mixed" ON "public"."docs"',
      '"writers" ON "public"."docs"',
    ]);
    expect(findings[0]?.explanation).toContain("every role (PUBLIC)");
    expect(findings[1]?.explanation).toContain("for authenticated.");
    expect(findings[2]?.explanation).toContain("USING and WITH CHECK");
    expect(findings[2]?.explanation).toContain("every command");
    expect(evidenceOf(findings[2])).toContain("literally true: USING, WITH CHECK");
  });

  it("ignores service_role, BYPASSRLS roles, restrictive policies and non-literal truths", () => {
    const catalog = catalogOf({
      tables,
      roles: [role("admin", { bypassRls: true }), role("root", { superuser: true })],
      policies: [
        policy("svc", { roles: ["service_role"], using: "true" }),
        policy("admins", { roles: ["admin", "root"], using: "true" }),
        policy("narrow", { permissive: false, using: "true" }),
        policy("tautology", { using: "(1 = 1)" }),
      ],
    });

    expect(ids(runStaticChecks(catalog, SUPABASE), "RLS003")).toEqual([]);
  });
});

describe("RLS004", () => {
  const tables = [table("docs")];

  it("does not flag a missing WITH CHECK, and only looks at UPDATE and ALL", () => {
    const catalog = catalogOf({
      tables,
      policies: [
        policy("missing", { command: "update" }),
        policy("missing_all", { command: "all" }),
        policy("insert_true", { command: "insert", using: null, withCheck: "true" }),
        policy("noop", { command: "update", permissive: false, using: null, withCheck: "true" }),
      ],
    });

    expect(ids(runStaticChecks(catalog, SUPABASE), "RLS004")).toEqual([]);
  });

  it("flags each decidable kind of looseness with its evidence", () => {
    const catalog = catalogOf({
      tables,
      policies: [
        policy("a", { command: "update", withCheck: "true" }),
        policy("b", { command: "update", using: null, withCheck: "true" }),
        policy("c", {
          command: "all",
          using: "((auth.uid() = user_id) AND (tenant_id = 1))",
          withCheck: "(auth.uid() = user_id)",
        }),
        policy("d", { command: "all", withCheck: "((auth.uid() = user_id) OR is_public)" }),
        policy("e", {
          command: "all",
          permissive: false,
          using: "(tenant_id = 1)",
          withCheck: "true",
        }),
      ],
    });
    const findings = runStaticChecks(catalog, SUPABASE).filter((entry) => entry.id === "RLS004");

    expect(findings.map((entry) => entry.object.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(findings.every((entry) => entry.severity === "high")).toBe(true);
    expect(findings[1]?.explanation).toContain("there is no USING");
    expect(evidenceOf(findings[2])).toContain(
      "conditions of using not in with check: tenant_id = 1",
    );
    expect(evidenceOf(findings[3])).toContain("alternatives only in with check: is_public");
    expect(findings[4]?.explanation).toContain("The policy is restrictive");
    expect(findings[0]?.explanation).not.toContain("The policy is restrictive");
  });
});

describe("RLS005", () => {
  const catalog = catalogOf({
    tables: [table("docs")],
    policies: [
      policy("app", { using: "((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'a'" }),
      policy("user", { using: "((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text) = 'a'" }),
      policy("check", {
        command: "insert",
        using: null,
        withCheck: "((auth.jwt() #>> '{user_metadata,t}'::text[]) = tenant)",
      }),
    ],
  });

  it("flags user_metadata and leaves app_metadata alone", () => {
    const findings = runStaticChecks(catalog, SUPABASE).filter((entry) => entry.id === "RLS005");

    expect(findings.map((entry) => entry.object.name)).toEqual(["check", "user"]);
    expect(evidenceOf(findings[0])).toContain("reads user_metadata in: WITH CHECK");
    expect(findings[0]?.docsUrl).toBe(
      "https://supabase.com/docs/guides/database/postgres/row-level-security",
    );
  });

  it("runs in supabase mode only", () => {
    expect(ids(runStaticChecks(catalog, postgres("app")), "RLS005")).toEqual([]);
  });
});

describe("RLS006", () => {
  const catalog = catalogOf({
    tables: [table("docs"), table("open", { rlsEnabled: false })],
    policies: [policy("own")],
    tablePrivileges: [
      ...grants("docs", "anon", "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"),
      ...grants("docs", "authenticated", "INSERT"),
      ...grants("open", "PUBLIC", "SELECT", "TRUNCATE"),
    ],
  });

  it("legacy grants: reports PUBLIC, never the platform's blanket grants to anon", () => {
    const findings = runStaticChecks(catalog, SUPABASE).filter((entry) => entry.id === "RLS006");

    expect(findings.map((entry) => entry.object.name)).toEqual(["open"]);
    expect(evidenceOf(findings[0])).toEqual([
      "granted to PUBLIC: TRUNCATE",
      "row level security: no",
    ]);
    expect(findings[0]?.explanation).toContain("TRUNCATE is not subject to row level security");
    expect(findings[0]?.explanation).toContain("nothing restricts these writes");
  });

  it("explicit grants: reports anon's INSERT, UPDATE and DELETE but not the TRUNCATE residue", () => {
    const findings = runStaticChecks(catalog, EXPLICIT).filter((entry) => entry.id === "RLS006");

    expect(findings.map((entry) => entry.object.name)).toEqual(["docs", "open"]);
    expect(evidenceOf(findings[0])).toEqual([
      "granted to anon: INSERT, UPDATE, DELETE",
      "row level security: yes",
    ]);
    expect(findings[0]?.explanation).not.toContain("TRUNCATE is not subject");
  });

  it("postgres mode: reports everything anon holds, with the Postgres page", () => {
    const findings = runStaticChecks(catalog, postgres("app")).filter(
      (entry) => entry.id === "RLS006",
    );

    expect(evidenceOf(findings[0])).toContain("granted to anon: INSERT, UPDATE, DELETE, TRUNCATE");
    expect(findings[0]?.docsUrl).toBe("https://www.postgresql.org/docs/current/sql-grant.html");
  });

  it("is silent for read-only grants and for other roles", () => {
    const readOnly = catalogOf({
      tables: [table("docs")],
      policies: [policy("own")],
      tablePrivileges: [
        ...grants("docs", "anon", "SELECT"),
        ...grants("docs", "PUBLIC", "SELECT", "REFERENCES"),
        ...grants("docs", "authenticated", "INSERT", "UPDATE", "DELETE"),
      ],
    });

    expect(runStaticChecks(readOnly, EXPLICIT)).toEqual([]);
  });
});

describe("RLS007", () => {
  it("flags SECURITY DEFINER without search_path, per overload, procedures included", () => {
    const catalog = catalogOf({
      functions: [
        fn("f", { identityArguments: "team integer" }),
        fn("f", { identityArguments: "team integer, who uuid", searchPath: '""' }),
        fn("invoker", { securityDefiner: false }),
        fn("p", { kind: "procedure" }),
      ],
    });
    const findings = runStaticChecks(catalog, SUPABASE);

    expect(findings.map((entry) => entry.object.qualifiedName)).toEqual([
      '"public"."f"(team integer)',
      '"public"."p"()',
    ]);
    expect(findings[0]?.object).toMatchObject({
      kind: "function",
      identityArguments: "team integer",
    });
    expect(findings[1]?.explanation).toContain("This procedure is SECURITY DEFINER");
    expect(findings[0]?.docsUrl).toContain("#SQL-CREATEFUNCTION-SECURITY");
  });

  it("ignores the shim's auth functions in supabase mode, not a user's function in auth", () => {
    const catalog = catalogOf({
      exposedSchemas: ["auth"],
      functions: [fn("uid", { schema: "auth" }), fn("is_admin", { schema: "auth" })],
    });

    expect(ids(runStaticChecks(catalog, SUPABASE), "RLS007")).toEqual(["is_admin"]);
    expect(ids(runStaticChecks(catalog, postgres("app")), "RLS007")).toEqual(["is_admin", "uid"]);
  });
});

describe("RLS008", () => {
  const tables = [table("docs"), table("plain", { rlsEnabled: false, owner: "app_owner" })];

  it("flags a view over a protected table and says how the owner stands to its RLS", () => {
    const catalog = catalogOf({
      tables: [
        ...tables,
        table("owned", { owner: "app_owner" }),
        table("forced", { owner: "app_owner", rlsForced: true }),
      ],
      policies: [policy("own"), policy("o", { table: "owned" }), policy("f", { table: "forced" })],
      roles: [POSTGRES_ROLE, role("app_owner")],
      views: [
        view("by_superuser"),
        view("by_owner", {
          owner: "app_owner",
          references: [
            { schema: "public", name: "forced", kind: "table" },
            { schema: "public", name: "owned", kind: "table" },
          ],
        }),
        view("cache", { materialized: true }),
      ],
    });
    const findings = runStaticChecks(catalog, SUPABASE).filter((entry) => entry.id === "RLS008");

    expect(findings.map((entry) => entry.object.name)).toEqual([
      "by_owner",
      "by_superuser",
      "cache",
    ]);
    expect(findings[0]?.object.kind).toBe("view");
    expect(evidenceOf(findings[0])).toEqual([
      "security_invoker: not set",
      "view owner: app_owner",
      'row level security of: "public"."forced": the policies that apply to the view owner are used, not the caller\'s',
      'row level security of: "public"."owned": skipped entirely, the view owner owns the table and FORCE is not set',
      "reachable by: assumed: the view is in an exposed schema (its privileges are not part of the catalog snapshot)",
    ]);
    expect(evidenceOf(findings[1])).toContain(
      'row level security of: "public"."docs": skipped entirely, the view owner is a superuser or has BYPASSRLS',
    );
    expect(findings[2]?.explanation).toContain("This materialized view");
    expect(evidenceOf(findings[2])).toContain(
      "security_invoker: not available for a materialized view",
    );
    expect(findings[2]?.docsUrl).toContain("sql-creatematerializedview");
  });

  it("ignores security invoker views, unprotected or unknown tables and other views", () => {
    const catalog = catalogOf({
      tables,
      policies: [policy("own")],
      views: [
        view("safe", { securityInvoker: true }),
        view("over_plain", { references: [{ schema: "public", name: "plain", kind: "table" }] }),
        view("over_private", { references: [{ schema: "private", name: "x", kind: "table" }] }),
        view("over_view", { references: [{ schema: "public", name: "safe", kind: "view" }] }),
      ],
    });

    expect(ids(runStaticChecks(catalog, SUPABASE), "RLS008")).toEqual([]);
  });

  it("uses the view's privileges when the catalog carries them", () => {
    const base = { tables, policies: [policy("own")], views: [view("v")] };
    const unreachable = catalogOf({
      ...base,
      tablePrivileges: [
        ...grants("v", "postgres", "SELECT"),
        ...grants("v", "anon", "TRUNCATE"),
        ...grants("v", "service_role", "SELECT"),
      ],
    });
    const reachable = catalogOf({
      ...base,
      tablePrivileges: [...grants("v", "postgres", "SELECT"), ...grants("v", "anon", "SELECT")],
    });

    expect(ids(runStaticChecks(unreachable, SUPABASE), "RLS008")).toEqual([]);
    const [finding] = runStaticChecks(reachable, SUPABASE).filter((entry) => entry.id === "RLS008");
    expect(evidenceOf(finding)).toContain("reachable by: anon");
  });
});

describe("RLS009", () => {
  const roles = [
    POSTGRES_ROLE,
    role("app"),
    role("team"),
    role("alice", { memberOf: ["team"] }),
    role("bob", { memberOf: ["team"], inherit: false }),
  ];

  it("flags an owner that is an application role, directly or through membership", () => {
    const catalog = catalogOf({
      roles,
      tables: [table("direct", { owner: "app" }), table("shared", { owner: "team" })],
      policies: [policy("a", { table: "direct" }), policy("b", { table: "shared" })],
    });
    const findings = runStaticChecks(catalog, postgres("alice", "app", "bob"));

    expect(findings.map((entry) => `${entry.id} ${entry.object.name}`)).toEqual([
      "RLS009 direct",
      "RLS009 shared",
    ]);
    expect(findings[0]?.severity).toBe("info");
    expect(evidenceOf(findings[1])).toEqual([
      "owner: team",
      "application roles with the owner's rights: alice (member of team)",
      "force row level security: no",
    ]);
  });

  it("is silent with FORCE, without RLS, for other owners and for roles that bypass anyway", () => {
    const catalog = catalogOf({
      roles,
      tables: [
        table("forced", { owner: "app", rlsForced: true }),
        table("migrated", { owner: "postgres" }),
        table("service", { owner: "service_role" }),
      ],
      policies: [
        policy("a", { table: "forced" }),
        policy("b", { table: "migrated" }),
        policy("c", { table: "service" }),
      ],
    });

    expect(runStaticChecks(catalog, postgres("app", "postgres", "service_role"))).toEqual([]);
    const disabled = catalogOf({
      roles,
      tables: [table("t", { owner: "app", rlsEnabled: false })],
    });
    expect(ids(runStaticChecks(disabled, postgres("app")), "RLS009")).toEqual([]);
  });

  it("treats anon and authenticated as application roles in supabase mode", () => {
    const catalog = catalogOf({
      tables: [table("docs", { owner: "authenticated" })],
      policies: [policy("own")],
    });

    expect(ids(runStaticChecks(catalog, SUPABASE), "RLS009")).toEqual(["docs"]);
  });
});

describe("roles", () => {
  const catalog = catalogOf({
    roles: [
      role("a", { memberOf: ["b"] }),
      role("b", { memberOf: ["a", "c"] }),
      role("c"),
      role("su", { superuser: true }),
    ],
  });

  it("follows memberships transitively and survives a cycle", () => {
    expect([...privilegesOf(catalog, "a")].sort()).toEqual(["a", "b", "c"]);
    expect([...privilegesOf(catalog, "unknown")]).toEqual(["unknown"]);
  });

  it("knows who bypasses RLS and who is an application role", () => {
    expect(bypassesRls(catalog, "su")).toBe(true);
    expect(bypassesRls(catalog, "service_role")).toBe(true);
    expect(bypassesRls(catalog, "a")).toBe(false);
    expect(applicationRoles(catalog, postgres("c", "a", "a", "su"))).toEqual(["a", "c"]);
    expect(
      applicationRoles(catalog, { mode: "supabase", personas: [{ dbRole: "service_role" }] }),
    ).toEqual(["anon", "authenticated"]);
  });
});

describe("the finding list", () => {
  it("is ordered by severity, id, then object, and is stable", () => {
    const catalog = catalogOf({
      tables: [table("b", { rlsEnabled: false }), table("a", { rlsEnabled: false }), table("docs")],
      policies: [
        policy("z", { using: "true" }),
        policy("a", { using: "true" }),
        policy("loose", { command: "update", withCheck: "true" }),
      ],
      functions: [fn("g", { identityArguments: "integer" }), fn("g", { identityArguments: "" })],
      tablePrivileges: grants("docs", "PUBLIC", "DELETE"),
    });
    const findings = runStaticChecks(catalog, SUPABASE);

    expect(
      findings.map((entry) => `${entry.severity} ${entry.id} ${entry.object.qualifiedName}`),
    ).toEqual([
      'critical RLS001 "public"."a"',
      'critical RLS001 "public"."b"',
      'high RLS003 "a" ON "public"."docs"',
      'high RLS003 "loose" ON "public"."docs"',
      'high RLS003 "z" ON "public"."docs"',
      'high RLS004 "loose" ON "public"."docs"',
      'medium RLS006 "public"."docs"',
      'medium RLS007 "public"."g"()',
      'medium RLS007 "public"."g"(integer)',
    ]);
    expect([...findings].reverse().sort(compareFindings)).toEqual(findings);
    expect(JSON.stringify(runStaticChecks(catalog, SUPABASE))).toBe(JSON.stringify(findings));
    expect(countBySeverity(findings)).toEqual({ critical: 2, high: 4, medium: 3, info: 0 });
  });

  it("is empty for an empty catalog and does not change its input", () => {
    const catalog = catalogOf({ tables: [table("docs")], policies: [policy("own")] });
    const before = JSON.stringify(catalog);

    expect(runStaticChecks(catalogOf({}), SUPABASE)).toEqual([]);
    expect(runStaticChecks(catalog, SUPABASE)).toEqual([]);
    expect(JSON.stringify(catalog)).toBe(before);
  });
});

describe("the rule registry and the public API", () => {
  it("has one rule per id with the severity of the brief and an official docs link", () => {
    expect(STATIC_CHECK_RULES.map((rule) => `${rule.id} ${rule.severity}`)).toEqual([
      "RLS001 critical",
      "RLS002 info",
      "RLS003 high",
      "RLS004 high",
      "RLS005 high",
      "RLS006 medium",
      "RLS007 medium",
      "RLS008 high",
      "RLS009 info",
    ]);
    expect(STATIC_CHECK_RULES.map((rule) => rule.id)).toEqual([...CHECK_IDS]);
    for (const rule of STATIC_CHECK_RULES) {
      expect(rule.docsUrl).toMatch(/^https:\/\/(www\.postgresql\.org|supabase\.com)\/docs\//);
      expect(rule.summary.length).toBeGreaterThan(40);
      expect(ruleById(rule.id)).toBe(rule);
      expect(rule.modes).toBe(rule.id === "RLS005" ? "supabase" : "all");
    }
    expect(SEVERITIES).toEqual(["critical", "high", "medium", "info"]);
  });

  it("refuses an id without a rule", () => {
    expect(() => ruleById("RLS999" as CheckId)).toThrow(RangeError);
  });

  it("exports exactly this", () => {
    expect(Object.keys(api).sort()).toEqual([
      "CHECK_IDS",
      "DOCS",
      "SEVERITIES",
      "STATIC_CHECK_RULES",
      "compareFindings",
      "countBySeverity",
      "ruleById",
      "runStaticChecks",
    ]);
  });
});
