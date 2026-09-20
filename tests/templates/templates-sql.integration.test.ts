/**
 * The SQL of every template variant against a real PGlite: it loads through the real setup
 * pipeline, the catalog looks as the expectations assume, every `expectedRowsSql` runs, and one
 * hand-written, role-switched statement per template shows the leak with its exact rows in the
 * leaky variant and is blocked or filtered in the fixed one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { groundTruth } from "@/lib/runner/ground-truth";
import { findTable, introspect, type Catalog } from "@/lib/runner/introspect";
import { setupDatabase, type SetupSummary } from "@/lib/runner/setup";
import type { SqlEngine } from "@/lib/runner/types";
import { compareText, qualifiedName, splitSqlStatements, type Persona } from "@/lib/scenario";
import {
  MULTI_TENANT_SAAS,
  OWN_SCENARIOS_TABLE,
  TEAM_WORKSPACE,
  templateVariants,
  TODOS_SHARING,
  type TemplateVariant,
} from "@/lib/scenario/templates";
import {
  ACME_PROJECT_IDS,
  GLOBEX_PROJECT_IDS,
  GLOBEX_TENANT_ID,
} from "@/lib/scenario/templates/multi-tenant-saas";
import {
  DESIGN_DOCUMENT_IDS,
  FINANCE_DOCUMENT_IDS,
  FINANCE_TEAM_ID,
  PLATFORM_DOCUMENT_IDS,
} from "@/lib/scenario/templates/team-workspace";
import {
  ALICE_SLUGS,
  BOB_SLUGS,
  PRIVATE_SCENARIO_IDS,
  PUBLIC_SCENARIO_IDS,
  UNLISTED_SCENARIO_IDS,
} from "@/lib/scenario/templates/own-scenarios-table";
import { PRIVATE_TODO_IDS, PUBLIC_TODO_IDS } from "@/lib/scenario/templates/todos-sharing";
import {
  asPersona,
  bindExpectedRowsSql,
  BLOCKED,
  idsAs,
  idsAsSuperuser,
  personaOf,
  writeAs,
} from "./helpers";

interface Loaded {
  engine: SqlEngine;
  summary: SetupSummary;
  catalog: Catalog;
}

const loaded = new Map<string, Loaded>();

function databaseOf(variant: TemplateVariant): Loaded {
  const entry = loaded.get(variant.scenario.id);
  if (entry === undefined) {
    throw new Error(`${variant.scenario.id} was not loaded`);
  }
  return entry;
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort(compareText);
}

beforeAll(async () => {
  for (const { variant } of templateVariants()) {
    const engine = await createPgliteEngine();
    const summary = await setupDatabase(engine, variant.scenario, SUPABASE_SETUP_SQL);
    const catalog = await introspect(engine, summary.exposedSchemas);
    loaded.set(variant.scenario.id, { engine, summary, catalog });
  }
}, 120_000);

afterAll(async () => {
  for (const { engine } of loaded.values()) {
    await engine.close();
  }
});

describe.each(templateVariants().map(({ variant }) => ({ id: variant.scenario.id, variant })))(
  "template SQL: $id",
  ({ variant }) => {
    const { scenario } = variant;

    it("loads schema and seed without an error, statement by statement", () => {
      const { summary } = databaseOf(variant);
      expect(summary).toEqual({
        mode: "supabase",
        exposedSchemas: ["public"],
        supabaseGrants: scenario.options?.supabaseGrants,
        schemaStatements: splitSqlStatements(scenario.schemaSql).length,
        seedStatements: splitSqlStatements(scenario.seedSql).length,
      });
    });

    it("configures exactly the exposed tables; each has the key `id`, RLS and its columns", () => {
      const { catalog } = databaseOf(variant);
      expect(catalog.missingSchemas).toEqual([]);
      expect(catalog.tables.map((table) => `${table.schema}.${table.name}`)).toEqual(
        scenario.tables.map((table) => `${table.schema}.${table.name}`),
      );
      for (const config of scenario.tables) {
        const table = findTable(catalog, config.schema, config.name);
        const columns = table?.columns.map((column) => column.name) ?? [];
        expect(table?.primaryKey).toEqual(["id"]);
        expect(table?.rlsEnabled).toBe(true);
        expect(table?.owner).toBe("postgres");
        for (const column of [config.ownerColumn, config.tenantColumn]) {
          expect(column === undefined || columns.includes(column)).toBe(true);
        }
      }
    });

    it("gives the ground truth a handful of rows per table, none skipped", async () => {
      const { engine, catalog } = databaseOf(variant);
      const truth = await groundTruth(engine, catalog, scenario.tables);
      for (const table of truth.tables) {
        expect(table.status).toBe("ok");
        expect(table.status === "ok" ? table.rows.length : 0).toBeGreaterThanOrEqual(2);
      }
    });

    it("runs every expectedRowsSql; it returns one column, `id`, with keys that exist", async () => {
      const { engine } = databaseOf(variant);
      const custom = scenario.expectations.filter((cell) => cell.scope === "custom");
      let reached = 0;
      for (const cell of custom) {
        const persona = personaOf(scenario, cell.personaId);
        const bound = bindExpectedRowsSql(cell.expectedRowsSql ?? "", persona);
        const { rows } = await engine.query(bound.sql, bound.params);
        const existing = await idsAsSuperuser(
          engine,
          `select id from ${qualifiedName(cell.schema, cell.table)}`,
        );
        for (const row of rows) {
          expect(Object.keys(row)).toEqual(["id"]);
          expect(existing).toContain(String(row.id));
        }
        expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
        reached += rows.length;
      }
      // Templates 2 and 3 use the custom scope, and it is not an empty promise there.
      expect(reached > 0).toBe(custom.length > 0);
    });

    it("keeps what the static checks look at as declared", () => {
      const { catalog } = databaseOf(variant);
      const literalTrue = catalog.policies
        .filter((policy) => policy.using === "true" || policy.withCheck === "true")
        .map((policy) => `${policy.table}.${policy.name}`);
      const declared = variant.expectedStaticChecks
        .filter((check) => check.id === "RLS003")
        .map((check) => `${check.table}.${check.policy}`);
      expect(literalTrue).toEqual(declared);

      // Nothing else for RLS001, RLS002, RLS007, RLS008 to find, in either variant.
      for (const table of catalog.tables) {
        expect(catalog.policies.some((policy) => policy.table === table.name)).toBe(true);
      }
      expect(catalog.views).toEqual([]);
      // The demos have no SECURITY DEFINER function; the app's own schema has exactly one.
      expect(
        catalog.functions.filter((fn) => fn.securityDefiner).map((fn) => `${fn.schema}.${fn.name}`),
      ).toEqual(
        scenario.id.startsWith(OWN_SCENARIOS_TABLE.id) ? ["public.get_scenario_by_slug"] : [],
      );
      for (const check of variant.expectedStaticChecks) {
        expect(
          catalog.policies.some(
            (policy) => policy.table === check.table && policy.name === check.policy,
          ),
        ).toBe(true);
      }
    });
  },
);

describe("multi-tenant-saas: WITH CHECK (true) lets a member move rows into another tenant", () => {
  const move = `update public.projects set tenant_id = $1::text::uuid`;

  /** As the persona: the update. Then, in the same transaction, as superuser: who owns what. */
  async function globexProjectsAfterMove(variant: TemplateVariant, persona: Persona) {
    return asPersona(databaseOf(variant).engine, persona, async (tx) => {
      const { affectedRows } = await tx.query(move, [GLOBEX_TENANT_ID]);
      await tx.exec("reset role");
      const { rows } = await tx.query(
        "select id::text as id from public.projects where tenant_id = $1::text::uuid order by 1",
        [GLOBEX_TENANT_ID],
      );
      return { affectedRows, ids: rows.map((row) => String(row.id)) };
    });
  }

  it("leaky: Alice of Acme moves all three Acme projects to Globex", async () => {
    const alice = personaOf(MULTI_TENANT_SAAS.leaky.scenario, "alice");
    expect(await globexProjectsAfterMove(MULTI_TENANT_SAAS.leaky, alice)).toEqual({
      affectedRows: 3,
      ids: sorted([...ACME_PROJECT_IDS, ...GLOBEX_PROJECT_IDS]),
    });
  });

  it("leaky: the targeted shape of the same move is blocked, which is why a probe needs both", async () => {
    const { engine } = databaseOf(MULTI_TENANT_SAAS.leaky);
    const alice = personaOf(MULTI_TENANT_SAAS.leaky.scenario, "alice");
    expect(
      await writeAs(engine, alice, `${move} where id = $2::text::uuid`, [
        GLOBEX_TENANT_ID,
        ACME_PROJECT_IDS[0],
      ]),
    ).toBe(BLOCKED);
  });

  it("fixed: the same statement is refused with 42501, in both shapes", async () => {
    const { engine } = databaseOf(MULTI_TENANT_SAAS.fixed);
    const alice = personaOf(MULTI_TENANT_SAAS.fixed.scenario, "alice");
    expect(await writeAs(engine, alice, move, [GLOBEX_TENANT_ID])).toBe(BLOCKED);
    expect(
      await writeAs(engine, alice, `${move} where id = $2::text::uuid`, [
        GLOBEX_TENANT_ID,
        ACME_PROJECT_IDS[0],
      ]),
    ).toBe(BLOCKED);
  });

  it("both: nothing moved for good, and a legitimate edit still works in the fixed variant", async () => {
    for (const variant of [MULTI_TENANT_SAAS.leaky, MULTI_TENANT_SAAS.fixed]) {
      const { engine } = databaseOf(variant);
      expect(
        await idsAsSuperuser(
          engine,
          "select id from public.projects where tenant_id = $1::text::uuid",
          [GLOBEX_TENANT_ID],
        ),
      ).toEqual(sorted(GLOBEX_PROJECT_IDS));
    }
    const { engine } = databaseOf(MULTI_TENANT_SAAS.fixed);
    const bob = personaOf(MULTI_TENANT_SAAS.fixed.scenario, "bob");
    expect(await writeAs(engine, bob, "update public.projects set name = name || '!'")).toBe(3);
  });
});

describe("team-workspace: the uncorrelated membership subquery shows every team's documents", () => {
  const read = "select id from public.documents";
  const everyDocument = sorted([
    ...DESIGN_DOCUMENT_IDS,
    ...PLATFORM_DOCUMENT_IDS,
    ...FINANCE_DOCUMENT_IDS,
  ]);

  it("leaky: Alice, a member of Design only, reads Platform and Finance as well", async () => {
    const { engine } = databaseOf(TEAM_WORKSPACE.leaky);
    const { scenario } = TEAM_WORKSPACE.leaky;
    expect(await idsAs(engine, personaOf(scenario, "alice"), read)).toEqual(everyDocument);
    expect(await idsAs(engine, personaOf(scenario, "bob"), read)).toEqual(everyDocument);
    expect(await idsAs(engine, personaOf(scenario, "carol"), read)).toEqual(everyDocument);
  });

  it("leaky: Dave is a member of no team, so the broken subquery finds nothing for him", async () => {
    const { engine } = databaseOf(TEAM_WORKSPACE.leaky);
    expect(await idsAs(engine, personaOf(TEAM_WORKSPACE.leaky.scenario, "dave"), read)).toEqual([]);
  });

  it("fixed: the same query returns the documents of the reader's own teams", async () => {
    const { engine } = databaseOf(TEAM_WORKSPACE.fixed);
    const { scenario } = TEAM_WORKSPACE.fixed;
    expect(await idsAs(engine, personaOf(scenario, "alice"), read)).toEqual(
      sorted(DESIGN_DOCUMENT_IDS),
    );
    expect(await idsAs(engine, personaOf(scenario, "bob"), read)).toEqual(
      sorted([...DESIGN_DOCUMENT_IDS, ...PLATFORM_DOCUMENT_IDS]),
    );
    expect(await idsAs(engine, personaOf(scenario, "carol"), read)).toEqual(
      sorted(PLATFORM_DOCUMENT_IDS),
    );
    expect(await idsAs(engine, personaOf(scenario, "dave"), read)).toEqual([]);
    expect(await idsAs(engine, personaOf(scenario, "anon"), read)).toEqual([]);
    expect(await idsAs(engine, personaOf(scenario, "service"), read)).toEqual(everyDocument);
  });

  it("both: writes stay correct, a document cannot be moved into a foreign team", async () => {
    for (const variant of [TEAM_WORKSPACE.leaky, TEAM_WORKSPACE.fixed]) {
      const { engine } = databaseOf(variant);
      const alice = personaOf(variant.scenario, "alice");
      expect(
        await writeAs(engine, alice, "update public.documents set team_id = $1::text::uuid", [
          FINANCE_TEAM_ID,
        ]),
      ).toBe(BLOCKED);
      expect(await idsAs(engine, alice, "delete from public.documents returning id")).toEqual([
        DESIGN_DOCUMENT_IDS[0],
      ]);
    }
  });
});

describe("todos-sharing: USING (true) on the public read policy opens every todo", () => {
  const read = "select id from public.todos";
  const everyTodo = sorted([...PUBLIC_TODO_IDS, ...PRIVATE_TODO_IDS]);

  it("leaky: anon reads all seven todos, the five private ones included", async () => {
    const { engine } = databaseOf(TODOS_SHARING.leaky);
    const { scenario } = TODOS_SHARING.leaky;
    expect(await idsAs(engine, personaOf(scenario, "anon"), read)).toEqual(everyTodo);
    expect(await idsAs(engine, personaOf(scenario, "carol"), read)).toEqual(everyTodo);
  });

  it("fixed: anon reads the two public todos, a user reads those and their own", async () => {
    const { engine } = databaseOf(TODOS_SHARING.fixed);
    const { scenario } = TODOS_SHARING.fixed;
    expect(await idsAs(engine, personaOf(scenario, "anon"), read)).toEqual(sorted(PUBLIC_TODO_IDS));
    expect(await idsAs(engine, personaOf(scenario, "carol"), read)).toEqual(
      sorted([...PUBLIC_TODO_IDS, PRIVATE_TODO_IDS[3], PRIVATE_TODO_IDS[4]]),
    );
  });

  it("both: sharing is read-only, Bob cannot edit or take over Alice's public todo", async () => {
    for (const variant of [TODOS_SHARING.leaky, TODOS_SHARING.fixed]) {
      const { engine } = databaseOf(variant);
      const bob = personaOf(variant.scenario, "bob");
      expect(
        await idsAs(
          engine,
          bob,
          "update public.todos set done = true where id = $1::text::uuid returning id",
          [PUBLIC_TODO_IDS[0]],
        ),
      ).toEqual([]);
      expect(await writeAs(engine, bob, "delete from public.todos")).toBe(2);
      expect(
        await writeAs(engine, bob, "update public.todos set user_id = $1::text::uuid", [
          String(personaOf(variant.scenario, "alice").claims.sub),
        ]),
      ).toBe(BLOCKED);
    }
  });
});

describe("own-scenarios-table: a policy that mentions unlisted rows lets everybody list them", () => {
  const read = "select id from public.scenarios";
  const aliceOwn = [PUBLIC_SCENARIO_IDS[0], UNLISTED_SCENARIO_IDS[0], PRIVATE_SCENARIO_IDS[0]];

  it("leaky: anon and Carol, who owns nothing, list both unlisted scenarios", async () => {
    const { engine } = databaseOf(OWN_SCENARIOS_TABLE.leaky);
    const { scenario } = OWN_SCENARIOS_TABLE.leaky;
    const listed = sorted([...PUBLIC_SCENARIO_IDS, ...UNLISTED_SCENARIO_IDS]);
    expect(await idsAs(engine, personaOf(scenario, "anon"), read)).toEqual(listed);
    expect(await idsAs(engine, personaOf(scenario, "carol"), read)).toEqual(listed);
    expect(await idsAs(engine, personaOf(scenario, "alice"), read)).toEqual(
      sorted([...aliceOwn, PUBLIC_SCENARIO_IDS[1], UNLISTED_SCENARIO_IDS[1]]),
    );
  });

  it("fixed: a query returns the public scenarios, plus the reader's own", async () => {
    const { engine } = databaseOf(OWN_SCENARIOS_TABLE.fixed);
    const { scenario } = OWN_SCENARIOS_TABLE.fixed;
    expect(await idsAs(engine, personaOf(scenario, "anon"), read)).toEqual(
      sorted(PUBLIC_SCENARIO_IDS),
    );
    expect(await idsAs(engine, personaOf(scenario, "carol"), read)).toEqual(
      sorted(PUBLIC_SCENARIO_IDS),
    );
    expect(await idsAs(engine, personaOf(scenario, "alice"), read)).toEqual(
      sorted([...aliceOwn, PUBLIC_SCENARIO_IDS[1]]),
    );
  });

  it("fixed: a filter on the slug or the visibility does not get around the policy", async () => {
    const { engine } = databaseOf(OWN_SCENARIOS_TABLE.fixed);
    const anon = personaOf(OWN_SCENARIOS_TABLE.fixed.scenario, "anon");
    expect(await idsAs(engine, anon, `${read} where slug = $1`, [BOB_SLUGS.unlisted])).toEqual([]);
    expect(await idsAs(engine, anon, `${read} where visibility = 'unlisted'`)).toEqual([]);
  });

  it("both: service_role holds no privilege on the table, BYPASSRLS or not", async () => {
    for (const variant of [OWN_SCENARIOS_TABLE.leaky, OWN_SCENARIOS_TABLE.fixed]) {
      const { engine } = databaseOf(variant);
      const service = personaOf(variant.scenario, "service");
      expect(await idsAs(engine, service, read)).toBe(BLOCKED);
      expect(await writeAs(engine, service, "delete from public.scenarios")).toBe(BLOCKED);
    }
  });

  it("both: publishing is read-only, Bob cannot edit, delete or take over Alice's public scenario", async () => {
    for (const variant of [OWN_SCENARIOS_TABLE.leaky, OWN_SCENARIOS_TABLE.fixed]) {
      const { engine } = databaseOf(variant);
      const bob = personaOf(variant.scenario, "bob");
      expect(
        await idsAs(
          engine,
          bob,
          "update public.scenarios set title = 'x' where slug = $1 returning id",
          [ALICE_SLUGS.public],
        ),
      ).toEqual([]);
      expect(await writeAs(engine, bob, "delete from public.scenarios")).toBe(3);
      expect(
        await writeAs(engine, bob, "update public.scenarios set owner = $1::text::uuid", [
          String(personaOf(variant.scenario, "alice").claims.sub),
        ]),
      ).toBe(BLOCKED);
      expect(
        await writeAs(engine, personaOf(variant.scenario, "anon"), "delete from public.scenarios"),
      ).toBe(BLOCKED);
    }
  });
});
