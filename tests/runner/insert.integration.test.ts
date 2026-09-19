/**
 * INSERT cells against a real PGlite: the scope classes, what is expected of each, deterministic
 * fresh keys for every kind of primary key, and constraint errors.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MatrixResult } from "@/lib/runner";
import { ALICE, BOB, CLAIM, cellOf, run, scenarioOf, subProbeOf } from "./helpers";

const OWN = `user_id = ${CLAIM("sub")}::uuid`;
const MY_TENANT = `tenant_id = ${CLAIM("tenant_id")}::int`;

const docs = (name: string, insertCheck: string): string => `
  create table ${name} (id int primary key, user_id uuid not null, tenant_id int not null, title text);
  alter table ${name} enable row level security;
  create policy read_tenant on ${name} for select using (${MY_TENANT});
  create policy write on ${name} for insert with check (${insertCheck});
  grant select, insert on ${name} to app_user;
  insert into ${name} values (1, '${ALICE}', 1, 'a'), (2, '${BOB}', 1, 'b'), (3, '${BOB}', 2, 'c');
`;

const SCHEMA = `
  create role app_user nologin;
  ${docs("docs_ok", MY_TENANT)}
  ${docs("docs_leaky", "true")}
  ${docs("docs_strict", `${MY_TENANT} and ${OWN}`)}

  create table by_uuid (id uuid primary key default gen_random_uuid(), user_id uuid not null, at timestamptz not null);
  alter table by_uuid enable row level security;
  create policy own on by_uuid for all using (${OWN});
  grant select, insert on by_uuid to app_user;
  insert into by_uuid values ('00000000-0000-4000-8000-000000000001', '${ALICE}', '2026-01-02T03:04:05Z'),
    ('bbbbbbbb-0000-4000-8000-000000000002', '${BOB}', '2026-01-02T03:04:05Z');

  create table by_identity (id int generated always as identity primary key, user_id uuid not null,
    doubled int generated always as (id * 2) stored);
  alter table by_identity enable row level security;
  create policy own on by_identity for all using (${OWN});
  grant select, insert on by_identity to app_user;
  insert into by_identity (user_id) values ('${ALICE}'), ('${BOB}');

  create table by_text (code text primary key, user_id uuid not null);
  alter table by_text enable row level security;
  create policy own on by_text for all using (${OWN});
  grant select, insert on by_text to app_user;
  insert into by_text values ('A-1', '${ALICE}');

  create table line_items (tenant_id int not null, line int not null, user_id uuid not null,
    primary key (tenant_id, line));
  alter table line_items enable row level security;
  create policy tenant on line_items for all using (${MY_TENANT});
  grant select, insert on line_items to app_user;
  insert into line_items values (1, 1, '${ALICE}'), (2, 1, '${BOB}');

  create table slugs (id int primary key, user_id uuid not null, slug text not null unique);
  alter table slugs enable row level security;
  create policy own on slugs for all using (${OWN});
  grant select, insert on slugs to app_user;
  insert into slugs values (1, '${ALICE}', 'hello'), (2, '${BOB}', 'world');
`;

const tenantScope = (table: string) => ({
  personaId: "alice",
  schema: "public",
  table,
  operation: "insert" as const,
  scope: "tenant" as const,
});

const scenario = scenarioOf({
  schemaSql: SCHEMA,
  personas: [
    {
      id: "alice",
      label: "Alice",
      dbRole: "app_user",
      claims: { sub: ALICE, tenant_id: 1 },
      tenantClaimPath: "tenant_id",
    },
  ],
  tables: [{ schema: "public", name: "line_items", tenantColumn: "tenant_id" }],
  expectations: ["docs_ok", "docs_leaky", "docs_strict"].map(tenantScope),
});

describe("insert probes", () => {
  let result: MatrixResult;

  beforeAll(async () => {
    result = (await run(scenario)).result;
  }, 60_000);

  it("a correct policy: clones of tenant rows go in, a clone of another tenant's row does not", () => {
    const cell = cellOf(result, "alice", "docs_ok", "insert");
    expect(cell).toMatchObject({ status: "pass", expectedKeys: [], actualKeys: [], sql: "" });
    expect(cell.subProbes.map((probe) => [probe.kind, probe.expected, probe.outcome])).toEqual([
      ["insert-own", "allowed", "allowed"],
      ["insert-same-tenant", "allowed", "allowed"],
      ["insert-other", "blocked", "blocked"],
    ]);
    expect(subProbeOf(cell, "insert-other")).toMatchObject({
      sourceKey: '["3"]',
      status: "pass",
      error: {
        sqlState: "42501",
        message: 'new row violates row-level security policy for table "docs_ok"',
      },
    });
  });

  it("clones the seeded row under a deterministic fresh key: max + 1000", () => {
    const probe = subProbeOf(cellOf(result, "alice", "docs_ok", "insert"), "insert-other");
    // The superuser lays the seeded row out, the persona inserts it under the fresh key. No value
    // of the row is written into the SQL: no cast can fail and no clock value can differ.
    const statement = `insert into "public"."docs_ok" ("id", "user_id", "tenant_id", "title") select '1003'::integer, "user_id", "tenant_id", "title" from pg_temp."rls_leak_tester_source"`;
    expect(probe.statement).toBe(statement);
    expect(probe.sql).toContain(`${statement};\nrollback;`);
    expect(probe.sql).toContain(
      `reset role;\ncreate temporary table "rls_leak_tester_source" on commit drop as select * from "public"."docs_ok" where "id"::text = '3';\ngrant select on pg_temp."rls_leak_tester_source" to "app_user";\nselect set_config('role', 'app_user', true);`,
    );
  });

  it("WITH CHECK (true): the out-of-scope insert goes through, an escape", () => {
    const cell = cellOf(result, "alice", "docs_leaky", "insert");
    expect(cell.status).toBe("escape");
    expect(subProbeOf(cell, "insert-other")).toMatchObject({
      expected: "blocked",
      outcome: "allowed",
      status: "escape",
      error: null,
    });
    expect(subProbeOf(cell, "insert-own").status).toBe("pass");
  });

  it("a policy stricter than the expectation: the in-scope insert is blocked, an overblock", () => {
    const cell = cellOf(result, "alice", "docs_strict", "insert");
    expect(cell.status).toBe("overblock");
    expect(subProbeOf(cell, "insert-same-tenant")).toMatchObject({
      expected: "allowed",
      outcome: "blocked",
      status: "overblock",
      error: { sqlState: "42501" },
    });
  });

  it("a uuid key gets a fixed literal that is free, never gen_random_uuid()", () => {
    const cell = cellOf(result, "alice", "by_uuid", "insert");
    expect(cell).toMatchObject({ status: "pass", scope: "own" });
    const sql = subProbeOf(cell, "insert-own").sql;
    // ...0001 is taken by a seeded row, so the first free one is ...0002.
    expect(sql).toContain("'00000000-0000-4000-8000-000000000002'::uuid");
    expect(sql).not.toContain("gen_random_uuid");
    // The seeded timestamp is copied inside the database and never appears in the recorded SQL.
    expect(sql).toContain(
      'select \'00000000-0000-4000-8000-000000000002\'::uuid, "user_id", "at" from',
    );
    expect(sql).not.toContain("2026-01-02");
  });

  it("an identity ALWAYS key and a generated column are left to the database", () => {
    const cell = cellOf(result, "alice", "by_identity", "insert");
    expect(cell.status).toBe("pass");
    expect(subProbeOf(cell, "insert-own").sql).toContain(
      'insert into "public"."by_identity" ("user_id") select "user_id" from pg_temp."rls_leak_tester_source";',
    );
    expect(subProbeOf(cell, "insert-other").outcome).toBe("blocked");
  });

  it("a key nobody can make is skipped with the reason, and so is the cell", () => {
    const cell = cellOf(result, "alice", "by_text", "insert");
    expect(cell.status).toBe("skipped");
    expect(cell.reason).toContain('No fresh value can be made for the primary key ("code")');
    expect(cell.subProbes).toMatchObject([{ kind: "insert-own", outcome: "skipped", sql: "" }]);
  });

  it("a composite key keeps its tenant column and replaces the other one", () => {
    const cell = cellOf(result, "alice", "line_items", "insert");
    expect(cell).toMatchObject({ status: "pass", scope: "tenant" });
    const clone = `("tenant_id", "line", "user_id") select "tenant_id", '1001'::integer, "user_id" from`;
    expect(subProbeOf(cell, "insert-same-tenant").sql).toContain(clone);
    expect(subProbeOf(cell, "insert-same-tenant").sql).toContain(
      `where "tenant_id"::text = '1' and "line"::text = '1';`,
    );
    expect(subProbeOf(cell, "insert-other")).toMatchObject({ outcome: "blocked" });
    expect(subProbeOf(cell, "insert-other").sql).toContain(clone);
    expect(subProbeOf(cell, "insert-other").sql).toContain(`where "tenant_id"::text = '2' and`);
  });

  it("a unique violation is inconclusive with the error shown, never a pass or an escape", () => {
    const cell = cellOf(result, "alice", "slugs", "insert");
    expect(cell).toMatchObject({
      status: "inconclusive",
      error: { sqlState: "23505" },
    });
    expect(cell.reason).toContain("duplicate key value violates unique constraint");
    expect(subProbeOf(cell, "insert-own")).toMatchObject({
      outcome: "inconclusive",
      status: "inconclusive",
    });
    // The policy is checked before the constraint: bob's clone is refused with 42501.
    expect(subProbeOf(cell, "insert-other")).toMatchObject({ outcome: "blocked", status: "pass" });
  });
});
