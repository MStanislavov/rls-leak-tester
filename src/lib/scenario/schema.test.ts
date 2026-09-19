import { describe, expect, it } from "vitest";

import {
  MAX_CLAIMS_DEPTH,
  MAX_CLAIMS_JSON_LENGTH,
  MAX_EXPECTATIONS,
  MAX_PERSONAS,
  MAX_SCENARIO_JSON_LENGTH,
  MAX_SQL_LENGTH,
  MAX_TABLES,
} from "./limits";
import {
  SCHEMAS_MATCH_TYPES,
  formatIssuePath,
  migrateScenario,
  parseScenario,
  parseScenarioJson,
  resolveOptions,
  type ParseScenarioResult,
} from "./schema";
import { SCENARIO_VERSION, type Scenario } from "./types";

const ALICE = "00000000-0000-0000-0000-00000000000a";
const BOB = "00000000-0000-0000-0000-00000000000b";

function validScenario(): Scenario {
  return {
    id: "saas-demo",
    version: SCENARIO_VERSION,
    title: "Multi-tenant SaaS",
    description: "Tenant comes from a JWT claim.",
    mode: "supabase",
    schemaSql: "create table public.notes (id uuid primary key, user_id uuid, tenant_id uuid);",
    seedSql: "",
    personas: [
      { id: "anon", label: "Visitor", dbRole: "anon", claims: { role: "anon" } },
      {
        id: "alice",
        label: "Alice",
        dbRole: "authenticated",
        claims: { sub: ALICE, role: "authenticated", app_metadata: { tenant_id: "t1" } },
        tenantClaimPath: "app_metadata.tenant_id",
      },
      { id: "service", label: "Backend", dbRole: "service_role", claims: {} },
    ],
    tables: [
      { schema: "public", name: "notes", ownerColumn: "user_id", tenantColumn: "tenant_id" },
    ],
    expectations: [
      {
        personaId: "alice",
        schema: "public",
        table: "notes",
        operation: "select",
        scope: "tenant",
      },
      {
        personaId: "alice",
        schema: "public",
        table: "notes",
        operation: "update",
        scope: "custom",
        expectedRowsSql: "select id from public.notes where user_id = :sub",
      },
    ],
  };
}

/** A valid scenario with one part replaced, as untyped input. */
function withChange(change: (draft: Record<string, unknown>) => void): unknown {
  const draft: Record<string, unknown> = structuredClone(validScenario()) as unknown as Record<
    string,
    unknown
  >;
  change(draft);
  return draft;
}

function issuesOf(result: ParseScenarioResult): string[] {
  if (result.ok) {
    return [];
  }
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

function expectIssue(input: unknown, path: string, fragment: string): void {
  const result = parseScenario(input);
  expect(result.ok).toBe(false);
  const match = issuesOf(result).find(
    (line) => line.startsWith(`${path}: `) && line.includes(fragment),
  );
  expect(match, `${path} / ${fragment} in ${JSON.stringify(issuesOf(result))}`).toBeDefined();
}

describe("parseScenario: valid input", () => {
  it("returns the scenario unchanged", () => {
    const result = parseScenario(validScenario());
    expect(result).toEqual({ ok: true, scenario: validScenario() });
  });

  it("round-trips through JSON", () => {
    const result = parseScenarioJson(JSON.stringify(validScenario()));
    expect(result).toEqual({ ok: true, scenario: validScenario() });
  });

  it("accepts a scenario without personas, tables and expectations", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.personas = [];
        draft.tables = [];
        draft.expectations = [];
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("fills the defaults of the options", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.options = {};
      }),
    );
    expect(result.ok && result.scenario.options).toEqual({
      exposedSchemas: ["public"],
      supabaseGrants: "legacy",
    });
  });

  it("keeps explicit options", () => {
    const options = { exposedSchemas: ["public", "api"], supabaseGrants: "explicit" };
    const result = parseScenario(
      withChange((draft) => {
        draft.options = options;
      }),
    );
    expect(result.ok && result.scenario.options).toEqual(options);
  });

  it("accepts custom roles and any sub in postgres mode", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.mode = "postgres";
        draft.personas = [
          { id: "u1", label: "App user", dbRole: "app_user", claims: { sub: "42" } },
          { id: "u2", label: "Numeric", dbRole: "App User", claims: { sub: 7 } },
        ];
        draft.expectations = [];
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts an anon persona without sub and a service persona with a uuid sub", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.personas = [
          { id: "anon", label: "Visitor", dbRole: "anon", claims: {} },
          { id: "svc", label: "Backend", dbRole: "service_role", claims: { sub: BOB } },
        ];
        draft.expectations = [];
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not return the input object itself", () => {
    const input = validScenario();
    const result = parseScenario(input);
    expect(result.ok && result.scenario).not.toBe(input);
  });
});

describe("parseScenario: shape", () => {
  it.each([[null], [undefined], ["text"], [42], [[]], [[validScenario()]]])(
    "refuses a value that is not an object: %j",
    (input) => {
      const result = parseScenario(input);
      expect(result).toMatchObject({
        ok: false,
        issues: [{ path: "", message: "A scenario must be a JSON object" }],
        message: "A scenario must be a JSON object",
      });
    },
  );

  it("refuses unknown keys at every strict level", () => {
    expectIssue(
      withChange((draft) => {
        draft.extra = 1;
      }),
      "",
      "extra",
    );
    expectIssue(
      withChange((draft) => {
        draft.personas = [{ id: "a", label: "A", dbRole: "anon", claims: {}, admin: true }];
        draft.expectations = [];
      }),
      "personas[0]",
      "admin",
    );
    expectIssue(
      withChange((draft) => {
        draft.tables = [{ schema: "public", name: "notes", pk: "id" }];
      }),
      "tables[0]",
      "pk",
    );
    expectIssue(
      withChange((draft) => {
        draft.options = { grants: "legacy" };
      }),
      "options",
      "grants",
    );
    expectIssue(
      withChange((draft) => {
        draft.expectations = [
          {
            personaId: "alice",
            schema: "public",
            table: "notes",
            operation: "select",
            scope: "all",
            note: "x",
          },
        ];
      }),
      "expectations[0]",
      "note",
    );
  });

  it("reports missing fields with their path", () => {
    expectIssue(
      withChange((draft) => {
        delete draft.schemaSql;
      }),
      "schemaSql",
      "",
    );
  });

  it("refuses unknown enum values", () => {
    expectIssue(
      withChange((draft) => {
        draft.mode = "mysql";
      }),
      "mode",
      "",
    );
    expectIssue(
      withChange((draft) => {
        draft.expectations = [
          {
            personaId: "alice",
            schema: "public",
            table: "notes",
            operation: "truncate",
            scope: "all",
          },
        ];
      }),
      "expectations[0].operation",
      "",
    );
    expectIssue(
      withChange((draft) => {
        draft.options = { supabaseGrants: "blanket" };
      }),
      "options.supabaseGrants",
      "",
    );
  });

  it("joins every issue into one readable message", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.title = "";
        draft.mode = "mysql";
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBe(2);
      expect(result.message.split("\n")).toEqual(
        result.issues.map((issue) => `${issue.path}: ${issue.message}`),
      );
      expect(result.message).toContain("title: must not be empty");
    }
  });
});

describe("parseScenario: versions", () => {
  it.each([[undefined], ["1"], [1.5], [0], [-1], [null]])("refuses version %j", (version) => {
    expectIssue(
      withChange((draft) => {
        draft.version = version;
      }),
      "version",
      `this build reads scenario version ${SCENARIO_VERSION}`,
    );
  });

  it("refuses a newer version and says what to do", () => {
    expectIssue(
      withChange((draft) => {
        draft.version = SCENARIO_VERSION + 1;
      }),
      "version",
      `scenario version ${SCENARIO_VERSION + 1} is newer than this build`,
    );
  });

  it("checks the version before anything else, so one clear issue comes back", () => {
    const result = parseScenario({ version: 99, garbage: true });
    expect(result.ok).toBe(false);
    expect(issuesOf(result)).toHaveLength(1);
  });
});

describe("migrateScenario (the hook for future versions)", () => {
  const v1 = { version: 1, title: "old", name: "legacy-field" };

  it("returns a copy when the version is current", () => {
    const result = migrateScenario(v1);
    expect(result).toEqual({ ok: true, value: v1 });
    expect(result.ok && result.value).not.toBe(v1);
  });

  it("applies each migration in order and stamps the version", () => {
    const result = migrateScenario(
      v1,
      {
        1: (input) => ({ ...input, step1: true, version: 999 }),
        2: (input) => ({ ...input, step2: input.step1 === true }),
      },
      3,
    );
    expect(result).toEqual({
      ok: true,
      value: { version: 3, title: "old", name: "legacy-field", step1: true, step2: true },
    });
  });

  it("does not mutate its input", () => {
    const input = { version: 1, nested: { a: 1 } };
    migrateScenario(input, { 1: (old) => ({ ...old, added: true }) }, 2);
    expect(input).toEqual({ version: 1, nested: { a: 1 } });
  });

  it("refuses a version without a migration path", () => {
    const result = migrateScenario(v1, { 2: (input) => ({ ...input }) }, 3);
    expect(result).toEqual({
      ok: false,
      message: "scenario version 1 is no longer supported; this build reads version 3",
    });
  });
});

describe("parseScenario: ids and identifiers", () => {
  it.each([[""], ["has space"], ["-leading"], ["a/b"], ["ü"], ["x".repeat(65)]])(
    "refuses the scenario id %j",
    (id) => {
      expectIssue(
        withChange((draft) => {
          draft.id = id;
        }),
        "id",
        "",
      );
    },
  );

  it("accepts identifiers with quotes, upper case and reserved words", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.tables = [
          { schema: "My Schema", name: 'we"ird', ownerColumn: "select", tenantColumn: "Ünïcode" },
        ];
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses identifiers that Postgres cannot keep", () => {
    expectIssue(
      withChange((draft) => {
        draft.tables = [{ schema: "public", name: "" }];
      }),
      "tables[0].name",
      "must not be empty",
    );
    expectIssue(
      withChange((draft) => {
        draft.tables = [{ schema: "public", name: "a\0b" }];
      }),
      "tables[0].name",
      "NUL",
    );
    expectIssue(
      withChange((draft) => {
        draft.tables = [{ schema: "public", name: "n".repeat(64) }];
      }),
      "tables[0].name",
      "63 bytes",
    );
    // 32 two-byte characters are 64 bytes, although only 32 characters.
    expectIssue(
      withChange((draft) => {
        draft.tables = [{ schema: "public", name: "é".repeat(32) }];
      }),
      "tables[0].name",
      "63 bytes",
    );
  });

  it("accepts a 63 byte identifier", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.tables = [{ schema: "public", name: "n".repeat(63) }];
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("parseScenario: personas", () => {
  it("refuses duplicate persona ids", () => {
    expectIssue(
      withChange((draft) => {
        draft.personas = [
          { id: "a", label: "A", dbRole: "anon", claims: {} },
          { id: "a", label: "B", dbRole: "anon", claims: {} },
        ];
        draft.expectations = [];
      }),
      "personas[1].id",
      "duplicate persona id 'a'",
    );
  });

  it("refuses a custom role in supabase mode", () => {
    expectIssue(
      withChange((draft) => {
        draft.personas = [{ id: "a", label: "A", dbRole: "app_user", claims: { sub: ALICE } }];
        draft.expectations = [];
      }),
      "personas[0].dbRole",
      "custom roles need postgres mode",
    );
  });

  it.each([["alice"], ["42"], [42], [""], [`{${ALICE}}`], [ALICE.replaceAll("-", "")], [null]])(
    "refuses the non-uuid sub %j in supabase mode and says why",
    (sub) => {
      expectIssue(
        withChange((draft) => {
          draft.personas = [{ id: "a", label: "A", dbRole: "authenticated", claims: { sub } }];
          draft.expectations = [];
        }),
        "personas[0].claims.sub",
        "22P02",
      );
    },
  );

  it("refuses a non-uuid sub for anon and service_role as well", () => {
    expectIssue(
      withChange((draft) => {
        draft.personas = [{ id: "a", label: "A", dbRole: "anon", claims: { sub: "guest" } }];
        draft.expectations = [];
      }),
      "personas[0].claims.sub",
      "must be a uuid",
    );
  });

  it("accepts an upper-case uuid", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.personas = [
          { id: "a", label: "A", dbRole: "authenticated", claims: { sub: ALICE.toUpperCase() } },
        ];
        draft.expectations = [];
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("requires a sub for an authenticated persona in supabase mode", () => {
    expectIssue(
      withChange((draft) => {
        draft.personas = [{ id: "a", label: "A", dbRole: "authenticated", claims: {} }];
        draft.expectations = [];
      }),
      "personas[0].claims.sub",
      "needs a 'sub' claim",
    );
  });

  it.each([[""], ["."], ["a..b"], [".a"], ["a."], ["x".repeat(201)]])(
    "refuses the tenant claim path %j",
    (tenantClaimPath) => {
      expectIssue(
        withChange((draft) => {
          draft.personas = [{ id: "a", label: "A", dbRole: "anon", claims: {}, tenantClaimPath }];
          draft.expectations = [];
        }),
        "personas[0].tenantClaimPath",
        "",
      );
    },
  );

  it("refuses claims that are not an object", () => {
    expectIssue(
      withChange((draft) => {
        draft.personas = [{ id: "a", label: "A", dbRole: "anon", claims: [] }];
        draft.expectations = [];
      }),
      "personas[0].claims",
      "",
    );
  });

  it("refuses claims that are not plain JSON", () => {
    for (const bad of [Number.NaN, 10n, () => 1, new Date(0), undefined, Symbol("s")]) {
      expectIssue(
        withChange((draft) => {
          draft.personas = [{ id: "a", label: "A", dbRole: "anon", claims: { nested: [bad] } }];
          draft.expectations = [];
        }),
        "personas[0].claims",
        "plain JSON",
      );
    }
  });

  it("refuses claims that nest too deep, also when circular", () => {
    let deep: Record<string, unknown> = {};
    for (let level = 0; level < MAX_CLAIMS_DEPTH; level += 1) {
      deep = { next: deep };
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const claims of [deep, circular]) {
      expectIssue(
        withChange((draft) => {
          draft.personas = [{ id: "a", label: "A", dbRole: "anon", claims }];
          draft.expectations = [];
        }),
        "personas[0].claims",
        `deeper than ${MAX_CLAIMS_DEPTH} levels`,
      );
    }
  });

  it("accepts claims at exactly the depth limit", () => {
    let deep: Record<string, unknown> = {};
    for (let level = 1; level < MAX_CLAIMS_DEPTH; level += 1) {
      deep = { next: deep };
    }
    const result = parseScenario(
      withChange((draft) => {
        draft.personas = [{ id: "a", label: "A", dbRole: "anon", claims: deep }];
        draft.expectations = [];
      }),
    );
    expect(issuesOf(result)).toEqual([]);
  });

  it("refuses oversized claims", () => {
    expectIssue(
      withChange((draft) => {
        draft.personas = [
          {
            id: "a",
            label: "A",
            dbRole: "anon",
            claims: { blob: "x".repeat(MAX_CLAIMS_JSON_LENGTH) },
          },
        ];
        draft.expectations = [];
      }),
      "personas[0].claims",
      `${MAX_CLAIMS_JSON_LENGTH} characters`,
    );
  });
});

describe("parseScenario: tables and expectations", () => {
  it("refuses two configs for one table", () => {
    expectIssue(
      withChange((draft) => {
        draft.tables = [
          { schema: "public", name: "notes" },
          { schema: "public", name: "notes", ownerColumn: "user_id" },
        ];
      }),
      "tables[1]",
      "duplicate table config for public.notes",
    );
  });

  it("tells same-named tables in different schemas apart", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.tables = [
          { schema: "public", name: "notes" },
          { schema: "api", name: "notes" },
        ];
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an expectation for an unknown persona", () => {
    expectIssue(
      withChange((draft) => {
        draft.expectations = [
          {
            personaId: "mallory",
            schema: "public",
            table: "notes",
            operation: "select",
            scope: "all",
          },
        ];
      }),
      "expectations[0].personaId",
      "unknown persona 'mallory'",
    );
  });

  it("refuses two expectations for one cell", () => {
    expectIssue(
      withChange((draft) => {
        const cell = { personaId: "alice", schema: "public", table: "notes", operation: "select" };
        draft.expectations = [
          { ...cell, scope: "own" },
          { ...cell, scope: "all" },
        ];
      }),
      "expectations[1]",
      "duplicate expectation for persona 'alice', public.notes, select",
    );
  });

  it("allows an expectation for a table without a config: introspection may still find it", () => {
    const result = parseScenario(
      withChange((draft) => {
        draft.tables = [];
      }),
    );
    expect(result.ok).toBe(true);
  });

  it.each([[undefined], [""], ["   \n"]])(
    "requires expectedRowsSql for the custom scope (given %j)",
    (expectedRowsSql) => {
      expectIssue(
        withChange((draft) => {
          draft.expectations = [
            {
              personaId: "alice",
              schema: "public",
              table: "notes",
              operation: "select",
              scope: "custom",
              ...(expectedRowsSql === undefined ? {} : { expectedRowsSql }),
            },
          ];
        }),
        "expectations[0].expectedRowsSql",
        "is required when scope is 'custom'",
      );
    },
  );

  it.each([["none"], ["own"], ["tenant"], ["all"]])(
    "refuses expectedRowsSql for the scope %s",
    (scope) => {
      expectIssue(
        withChange((draft) => {
          draft.expectations = [
            {
              personaId: "alice",
              schema: "public",
              table: "notes",
              operation: "select",
              scope,
              expectedRowsSql: "select 1",
            },
          ];
        }),
        "expectations[0].expectedRowsSql",
        `is only allowed when scope is 'custom', not '${scope}'`,
      );
    },
  );
});

describe("parseScenario: limits that protect the browser", () => {
  it("refuses oversized SQL", () => {
    expectIssue(
      withChange((draft) => {
        draft.schemaSql = "-".repeat(MAX_SQL_LENGTH + 1);
      }),
      "schemaSql",
      `${MAX_SQL_LENGTH} characters`,
    );
    expectIssue(
      withChange((draft) => {
        draft.seedSql = "-".repeat(MAX_SQL_LENGTH + 1);
      }),
      "seedSql",
      `${MAX_SQL_LENGTH} characters`,
    );
  });

  it("accepts SQL at exactly the limit and refuses a NUL character", () => {
    const atLimit = parseScenario(
      withChange((draft) => {
        draft.schemaSql = "-".repeat(MAX_SQL_LENGTH);
      }),
    );
    expect(atLimit.ok).toBe(true);
    expectIssue(
      withChange((draft) => {
        draft.seedSql = "select 1;\0";
      }),
      "seedSql",
      "NUL",
    );
  });

  it("refuses too many personas, tables and expectations", () => {
    const personas = Array.from({ length: MAX_PERSONAS + 1 }, (_, index) => ({
      id: `p${index}`,
      label: `P ${index}`,
      dbRole: "anon",
      claims: {},
    }));
    expectIssue(
      withChange((draft) => {
        draft.personas = personas;
        draft.expectations = [];
      }),
      "personas",
      `at most ${MAX_PERSONAS} personas`,
    );

    const tables = Array.from({ length: MAX_TABLES + 1 }, (_, index) => ({
      schema: "public",
      name: `t${index}`,
    }));
    expectIssue(
      withChange((draft) => {
        draft.tables = tables;
      }),
      "tables",
      `at most ${MAX_TABLES} tables`,
    );

    const expectations = Array.from({ length: MAX_EXPECTATIONS + 1 }, (_, index) => ({
      personaId: "alice",
      schema: "public",
      table: `t${index}`,
      operation: "select",
      scope: "none",
    }));
    expectIssue(
      withChange((draft) => {
        draft.expectations = expectations;
      }),
      "expectations",
      `at most ${MAX_EXPECTATIONS} expectations`,
    );
  });

  it("refuses bad exposed schemas", () => {
    expectIssue(
      withChange((draft) => {
        draft.options = { exposedSchemas: [] };
      }),
      "options.exposedSchemas",
      "at least one schema",
    );
    expectIssue(
      withChange((draft) => {
        draft.options = { exposedSchemas: ["public", "public"] };
      }),
      "options.exposedSchemas",
      "must not repeat",
    );
    expectIssue(
      withChange((draft) => {
        draft.options = { exposedSchemas: Array.from({ length: 9 }, (_, index) => `s${index}`) };
      }),
      "options.exposedSchemas",
      "at most 8",
    );
  });
});

describe("parseScenarioJson", () => {
  it("refuses text that is not JSON without throwing", () => {
    expect(parseScenarioJson("{not json")).toEqual({
      ok: false,
      issues: [{ path: "", message: "The scenario is not valid JSON" }],
      message: "The scenario is not valid JSON",
    });
  });

  it("refuses oversized text before parsing it", () => {
    const result = parseScenarioJson(" ".repeat(MAX_SCENARIO_JSON_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(issuesOf(result)[0]).toContain("was not read");
  });

  it("validates what it parsed", () => {
    expect(parseScenarioJson("[]").ok).toBe(false);
    expect(parseScenarioJson('{"version":1}').ok).toBe(false);
  });

  it("does not let a __proto__ key through as a property", () => {
    const text = JSON.stringify(validScenario()).replace("{", '{"__proto__":{"polluted":true},');
    const result = parseScenarioJson(text);
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("resolveOptions", () => {
  it("gives the defaults when the scenario has no options", () => {
    expect(resolveOptions({})).toEqual({ exposedSchemas: ["public"], supabaseGrants: "legacy" });
    expect(resolveOptions({ options: undefined })).toEqual({
      exposedSchemas: ["public"],
      supabaseGrants: "legacy",
    });
  });

  it("returns a copy of explicit options", () => {
    const options = { exposedSchemas: ["api"], supabaseGrants: "explicit" as const };
    const resolved = resolveOptions({ options });
    expect(resolved).toEqual(options);
    expect(resolved.exposedSchemas).not.toBe(options.exposedSchemas);
  });

  it("never hands out the shared default array", () => {
    resolveOptions({}).exposedSchemas.push("mutated");
    expect(resolveOptions({}).exposedSchemas).toEqual(["public"]);
  });
});

describe("formatIssuePath", () => {
  it("formats keys and indexes", () => {
    expect(formatIssuePath([])).toBe("");
    expect(formatIssuePath(["personas", 0, "claims", "sub"])).toBe("personas[0].claims.sub");
    expect(formatIssuePath([2, "x"])).toBe("[2].x");
    expect(formatIssuePath([Symbol.for("k")])).toBe("Symbol(k)");
  });
});

describe("schemas and types", () => {
  it("are asserted equal at compile time", () => {
    expect(Object.values(SCHEMAS_MATCH_TYPES).every(Boolean)).toBe(true);
  });
});
