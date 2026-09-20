/**
 * Scope `custom` (membership-based access), composite keys and identifiers that need quoting,
 * against a real PGlite.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MatrixResult } from "@/lib/runner";
import { OPERATIONS, type Expectation } from "@/lib/scenario";
import { ALICE, BOB, CAROL, CLAIM, cellOf, run, scenarioOf, subProbeOf } from "./helpers";

const UID = `${CLAIM("sub")}::uuid`;

const documents = (name: string, using: string): string => `
  create table ${name} (id int primary key, team_id int not null references teams (id), title text);
  alter table ${name} enable row level security;
  create policy members on ${name} for all using (${using});
  grant select, insert, update, delete on ${name} to app_user;
  insert into ${name} values (1, 10, 'red one'), (2, 10, 'red two'), (3, 20, 'blue one');
`;

const SCHEMA = `
  create role app_user nologin;
  create table teams (id int primary key, name text);
  create table memberships (team_id int references teams (id), user_id uuid, primary key (team_id, user_id));
  insert into teams values (10, 'red'), (20, 'blue');
  insert into memberships values (10, '${ALICE}'), (10, '${BOB}'), (20, '${CAROL}');
  grant select on teams, memberships to app_user;

  ${documents(
    "documents",
    `exists (select 1 from memberships m where m.team_id = documents.team_id and m.user_id = ${UID})`,
  )}
  -- The classic bug: the subquery is not correlated to the row's team.
  ${documents("documents_leaky", `exists (select 1 from memberships m where m.user_id = ${UID})`)}

  create schema "App Data";
  grant usage on schema "App Data" to app_user;
  create table "App Data"."Order Items" ("Order ID" int, "Line" int, "Owner" uuid not null, "Note ""x""" text,
    primary key ("Order ID", "Line"));
  alter table "App Data"."Order Items" enable row level security;
  create policy "own rows" on "App Data"."Order Items" for all using ("Owner" = ${UID});
  grant select, insert, update, delete on "App Data"."Order Items" to app_user;
  insert into "App Data"."Order Items" values (1, 1, '${ALICE}', 'a'), (1, 2, '${ALICE}', 'b'), (2, 1, '${BOB}', 'c');
`;

const MEMBER_ROWS = (table: string): string =>
  `select d.id from ${table} d join memberships m on m.team_id = d.team_id where m.user_id = :sub::uuid -- :sub in a comment`;

const custom = (personaId: string, table: string, expectedRowsSql: string): Expectation[] =>
  OPERATIONS.map((operation) => ({
    personaId,
    schema: "public",
    table,
    operation,
    scope: "custom",
    expectedRowsSql,
  }));

const scenario = scenarioOf({
  schemaSql: SCHEMA,
  options: { exposedSchemas: ["public", "App Data", "ghost_schema"], supabaseGrants: "legacy" },
  personas: [
    { id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE, team: 10 } },
    { id: "carol", label: "Carol", dbRole: "app_user", claims: { sub: CAROL, team: 20 } },
  ],
  tables: [
    { schema: "public", name: "documents", tenantColumn: "team_id" },
    { schema: "public", name: "documents_leaky", tenantColumn: "team_id" },
    { schema: "App Data", name: "Order Items", ownerColumn: "Owner" },
    { schema: "public", name: "memberships" },
    { schema: "public", name: "teams" },
  ],
  expectations: [
    ...custom("alice", "documents", MEMBER_ROWS("documents")),
    ...custom("alice", "documents_leaky", MEMBER_ROWS("documents_leaky")),
    ...custom(
      "carol",
      "documents",
      "select id from documents where team_id = (:claims ->> 'team')::int",
    ),
    ...custom("carol", "documents_leaky", "select nope from documents_leaky"),
  ],
});

describe("custom scope, composite keys, quoted identifiers", () => {
  let result: MatrixResult;

  beforeAll(async () => {
    result = (await run(scenario)).result;
  }, 60_000);

  it("expected rows come from the query, with :sub bound", () => {
    for (const operation of ["select", "update", "delete"] as const) {
      expect(cellOf(result, "alice", "documents", operation)).toMatchObject({
        status: "pass",
        scope: "custom",
        expectedKeys: ['["1"]', '["2"]'],
        actualKeys: ['["1"]', '["2"]'],
      });
    }
  });

  it("and with :claims bound as jsonb", () => {
    expect(cellOf(result, "carol", "documents", "select")).toMatchObject({
      status: "pass",
      expectedKeys: ['["3"]'],
      actualKeys: ['["3"]'],
    });
  });

  it("the uncorrelated membership subquery leaks the other team's documents", () => {
    expect(cellOf(result, "alice", "documents_leaky", "select")).toMatchObject({
      status: "leak",
      leakedKeys: ['["3"]'],
    });
    expect(cellOf(result, "alice", "documents_leaky", "delete").status).toBe("leak");
  });

  it("custom insert classes are in-scope and out-of-scope of the expected rows", () => {
    const ok = cellOf(result, "alice", "documents", "insert");
    expect(ok.status).toBe("pass");
    expect(ok.subProbes.map((probe) => [probe.kind, probe.sourceKey, probe.outcome])).toEqual([
      ["insert-in-scope", '["1"]', "allowed"],
      ["insert-out-of-scope", '["3"]', "blocked"],
    ]);
    const leaky = cellOf(result, "alice", "documents_leaky", "insert");
    expect(leaky.status).toBe("escape");
    expect(subProbeOf(leaky, "insert-out-of-scope")).toMatchObject({
      outcome: "allowed",
      status: "escape",
    });
  });

  it("custom escape moves the row to a team outside the expected rows", () => {
    const ok = cellOf(result, "alice", "documents", "update");
    expect(subProbeOf(ok, "escape-bulk")).toMatchObject({ outcome: "blocked", status: "pass" });
    expect(subProbeOf(ok, "escape-bulk").sql).toContain(`set "team_id" = '20'::integer;`);
    // The leaky policy does not look at the row at all: anything a member writes is accepted.
    const leaky = cellOf(result, "alice", "documents_leaky", "update");
    expect(leaky.status).toBe("leak");
    expect(subProbeOf(leaky, "escape-targeted")).toMatchObject({ status: "escape" });
  });

  it("a failing expectedRowsSql is inconclusive with the message, and nothing is probed", () => {
    const cell = cellOf(result, "carol", "documents_leaky", "select");
    expect(cell).toMatchObject({
      status: "inconclusive",
      sql: "",
      error: { sqlState: "42703" },
    });
    expect(cell.reason).toBe('expectedRowsSql failed: column "nope" does not exist');
  });

  it("a failing expectedRowsSql names the statement that failed, as schema and seed errors do", () => {
    const cell = cellOf(result, "carol", "documents_leaky", "select");
    // What ran: the user's query inside the wrapper that reads the key columns.
    expect(cell.error?.statement).toBe(
      'select "id"::text as k0 from (\nselect nope from documents_leaky\n) as expected_rows("id")',
    );
    // The cell's own statement stays empty: no probe ran, and the CI export embeds that field.
    expect(cell.statement).toBe("");
    // A probe that failed is its own statement; only this failure needs to carry one.
    const probed = result.cells.filter((other) => other.error !== null && other.sql !== "");
    for (const other of probed) expect(other.error, other.id).not.toHaveProperty("statement");
  });

  it("composite keys whose columns are both scope columns cannot be cloned: skipped", () => {
    // memberships: no owner or tenant configured, default scope none, key (team_id, user_id).
    const cell = cellOf(result, "alice", "memberships", "select");
    expect(cell).toMatchObject({ status: "leak", scope: "none" });
    expect(cell.actualKeys).toEqual(
      [`["10","${ALICE}"]`, `["10","${BOB}"]`, `["20","${CAROL}"]`].sort(),
    );
  });

  it("quoted schema, table and column names, with a composite key", () => {
    for (const operation of ["select", "update", "delete"] as const) {
      expect(cellOf(result, "alice", "Order Items", operation)).toMatchObject({
        status: "pass",
        schema: "App Data",
        scope: "own",
        expectedKeys: ['["1","1"]', '["1","2"]'],
        actualKeys: ['["1","1"]', '["1","2"]'],
      });
    }
    const update = cellOf(result, "alice", "Order Items", "update");
    expect(update.sql).toContain(
      'update "App Data"."Order Items" set "Note ""x""" = "Note ""x""" returning "Order ID"::text as k0, "Line"::text as k1;',
    );
    expect(subProbeOf(update, "escape-targeted").sql).toContain(
      `set "Owner" = '${BOB}'::uuid where "Order ID"::text = '1' and "Line"::text = '1' returning`,
    );
    const insert = cellOf(result, "alice", "Order Items", "insert");
    expect(insert.status).toBe("pass");
    expect(subProbeOf(insert, "insert-other").sql).toContain(
      `insert into "App Data"."Order Items" ("Order ID", "Line", "Owner", "Note ""x""") select '1002'::integer, "Line", "Owner", "Note ""x""" from pg_temp."rls_leak_tester_source";`,
    );
    expect(cellOf(result, "carol", "Order Items", "select").actualKeys).toEqual([]);
  });

  it("reports tables of every exposed schema in order, and the schema that is missing", () => {
    expect(result.missingSchemas).toEqual(["ghost_schema"]);
    expect(result.tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "App Data.Order Items",
      "public.documents",
      "public.documents_leaky",
      "public.memberships",
      "public.teams",
    ]);
  });
});

describe("an expectedRowsSql no query can be built from", () => {
  it("names the text as the user wrote it", async () => {
    const twoStatements = "select id from documents; select id from documents";
    const { result } = await run({
      ...scenario,
      expectations: custom("alice", "documents", twoStatements),
    });

    const cell = cellOf(result, "alice", "documents", "select");
    expect(cell).toMatchObject({
      status: "inconclusive",
      error: { sqlState: null, statement: twoStatements },
    });
    expect(cell.reason).toContain("exactly one query; it has 2 statements");
  }, 60_000);
});
