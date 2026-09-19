import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import {
  groundTruth,
  keyOfRow,
  NO_PRIMARY_KEY_REASON,
  primaryKeySelectList,
  serializeKey,
  type GroundTruth,
  type GroundTruthTable,
} from "@/lib/runner/ground-truth";
import { introspect, type Catalog } from "@/lib/runner/introspect";
import { setupDatabase } from "@/lib/runner/setup";
import type { SqlEngine } from "@/lib/runner/types";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import type { TableConfig } from "@/lib/scenario";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const SCHEMA = `
create table docs (id uuid primary key, user_id uuid, tenant_id int not null);
create table memberships (user_id uuid not null, team_id int not null, primary key (team_id, user_id));
create table ledger (id int8 primary key, amount numeric(12,2), at timestamptz, owner_name text);
create table "Order Items" ("Order ID" int, "Line" int, "Owner" text, "Tenant ""X""" text,
  primary key ("Order ID", "Line"));
create table events (at timestamptz, payload jsonb);
create table dated (day date primary key, tenant_id int);
`;

const SEED = `
insert into docs values
  ('bbbbbbbb-0000-4000-8000-000000000002', '${BOB}', 2),
  ('aaaaaaaa-0000-4000-8000-000000000001', '${ALICE}', 1),
  ('cccccccc-0000-4000-8000-000000000003', null, 1);
insert into memberships values ('${BOB}', 10), ('${ALICE}', 10), ('${ALICE}', 2);
insert into ledger values (9007199254740993, 10.50, '2026-01-02T03:04:05Z', 'alice'), (2, 0.10, null, 'bob');
insert into "Order Items" values (2, 1, 'bob', 't2'), (1, 2, 'alice', 't1'), (1, 1, 'alice', 't1');
insert into events values (now(), '{}');
insert into dated values ('2026-03-01', 7), ('2025-12-31', 8);
`;

const CONFIGS: TableConfig[] = [
  { schema: "public", name: "docs", ownerColumn: "user_id", tenantColumn: "tenant_id" },
  { schema: "public", name: "memberships", ownerColumn: "user_id", tenantColumn: "team_id" },
  { schema: "public", name: "ledger", ownerColumn: "owner_name" },
  { schema: "public", name: "Order Items", ownerColumn: "Owner", tenantColumn: 'Tenant "X"' },
  { schema: "public", name: "dated", tenantColumn: "tenant_id" },
];

describe("groundTruth against a real PGlite", () => {
  let engine: SqlEngine;
  let catalog: Catalog;
  let truth: GroundTruth;
  const table = (name: string): GroundTruthTable | undefined =>
    truth.tables.find((entry) => entry.name === name);

  beforeAll(async () => {
    engine = await createPgliteEngine();
    await setupDatabase(
      engine,
      { mode: "postgres", schemaSql: SCHEMA, seedSql: SEED },
      SUPABASE_SETUP_SQL,
    );
    catalog = await introspect(engine, ["public"]);
    truth = await groundTruth(engine, catalog, CONFIGS);
  }, 60_000);

  afterAll(async () => {
    await engine.close();
  });

  it("has one entry per catalog table, in catalog order", () => {
    expect(truth.tables.map((entry) => entry.name)).toEqual(catalog.tables.map((t) => t.name));
    expect(truth.tables.map((entry) => entry.name)).toEqual([
      "Order Items",
      "dated",
      "docs",
      "events",
      "ledger",
      "memberships",
    ]);
  });

  it("snapshots every key with owner and tenant as text, sorted by key, NULL owner kept as null", () => {
    expect(table("docs")).toEqual({
      status: "ok",
      schema: "public",
      name: "docs",
      primaryKey: ["id"],
      ownerColumn: "user_id",
      tenantColumn: "tenant_id",
      rows: [
        { key: '["aaaaaaaa-0000-4000-8000-000000000001"]', owner: ALICE, tenant: "1" },
        { key: '["bbbbbbbb-0000-4000-8000-000000000002"]', owner: BOB, tenant: "2" },
        { key: '["cccccccc-0000-4000-8000-000000000003"]', owner: null, tenant: "1" },
      ],
    });
  });

  it("serialises a composite key in KEY order, not column order", () => {
    const memberships = table("memberships");
    expect(memberships).toMatchObject({ status: "ok", primaryKey: ["team_id", "user_id"] });
    expect(memberships?.status === "ok" && memberships.rows).toEqual([
      { key: `["10","${ALICE}"]`, owner: ALICE, tenant: "10" },
      { key: `["10","${BOB}"]`, owner: BOB, tenant: "10" },
      { key: `["2","${ALICE}"]`, owner: ALICE, tenant: "2" },
    ]);
  });

  it("keeps non-text keys exact: int8 beyond 2^53 and a date, as Postgres prints them", () => {
    const ledger = table("ledger");
    expect(ledger?.status === "ok" && ledger.rows).toEqual([
      { key: '["2"]', owner: "bob", tenant: null },
      { key: '["9007199254740993"]', owner: "alice", tenant: null },
    ]);
    const dated = table("dated");
    expect(dated?.status === "ok" && dated.rows).toEqual([
      { key: '["2025-12-31"]', owner: null, tenant: "8" },
      { key: '["2026-03-01"]', owner: null, tenant: "7" },
    ]);
  });

  it("handles quoted, mixed-case table and column names, a double quote in a name included", () => {
    expect(table("Order Items")).toEqual({
      status: "ok",
      schema: "public",
      name: "Order Items",
      primaryKey: ["Order ID", "Line"],
      ownerColumn: "Owner",
      tenantColumn: 'Tenant "X"',
      rows: [
        { key: '["1","1"]', owner: "alice", tenant: "t1" },
        { key: '["1","2"]', owner: "alice", tenant: "t1" },
        { key: '["2","1"]', owner: "bob", tenant: "t2" },
      ],
    });
  });

  it("marks a table without a primary key as skipped with the reason, never falls back to ctid", () => {
    expect(table("events")).toEqual({
      status: "skipped",
      schema: "public",
      name: "events",
      reason: NO_PRIMARY_KEY_REASON,
    });
  });

  it("refuses a configured column the catalog does not know before any SQL is built", async () => {
    const statements: string[] = [];
    const spy = {
      query: (sql: string, params?: readonly (string | number | boolean | null)[]) => {
        statements.push(sql);
        return engine.query(sql, params);
      },
      exec: (sql: string) => engine.exec(sql),
    };
    const hostile = 'id" from docs; drop table docs; --';
    const result = await groundTruth(spy, catalog, [
      { schema: "public", name: "docs", ownerColumn: hostile },
      { schema: "public", name: "dated", tenantColumn: "Tenant_ID" },
    ]);
    expect(result.tables.find((entry) => entry.name === "docs")).toEqual({
      status: "skipped",
      schema: "public",
      name: "docs",
      reason: `The configured owner column "${hostile}" does not exist in this table.`,
    });
    // Column names are case-sensitive, as in the catalog.
    expect(result.tables.find((entry) => entry.name === "dated")).toMatchObject({
      status: "skipped",
      reason: 'The configured tenant column "Tenant_ID" does not exist in this table.',
    });
    expect(statements.some((sql) => sql.includes("drop table"))).toBe(false);
    expect(statements.some((sql) => sql.includes('"docs"'))).toBe(false);
    const { rows } = await engine.query("select count(*)::int as n from docs");
    expect(rows).toEqual([{ n: 3 }]);
  });

  it("without a table config the keys are still snapshotted, owner and tenant are null", async () => {
    const bare = await groundTruth(engine, catalog, []);
    const docs = bare.tables.find((entry) => entry.name === "docs");
    expect(docs).toMatchObject({ status: "ok", ownerColumn: null, tenantColumn: null });
    expect(docs?.status === "ok" && docs.rows.map((row) => [row.owner, row.tenant])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it("is byte-identical on a second run and leaves the data untouched", async () => {
    const again = await groundTruth(engine, catalog, CONFIGS);
    expect(JSON.stringify(again)).toBe(JSON.stringify(truth));
  });

  it("gives probes the same key through RETURNING as the snapshot holds", async () => {
    const primaryKey = ["team_id", "user_id"];
    const returned = await engine.transaction(async (tx) => {
      try {
        const { rows } = await tx.query(
          `delete from memberships where team_id = $1 returning ${primaryKeySelectList(primaryKey)}`,
          [2],
        );
        return rows.map((row) => keyOfRow(row, primaryKey.length));
      } finally {
        await tx.rollback();
      }
    });
    expect(returned).toEqual([serializeKey(["2", ALICE])]);
    const memberships = table("memberships");
    expect(memberships?.status === "ok" && memberships.rows.map((row) => row.key)).toContain(
      returned[0],
    );
  });

  it("keyOfRow refuses a row that was not selected with primaryKeySelectList", () => {
    expect(() => keyOfRow({ id: 1 }, 1)).toThrow("missing");
    expect(() => keyOfRow({ k0: 1 }, 1)).toThrow("number");
    expect(primaryKeySelectList(['a"b', "c"])).toBe('"a""b"::text as k0, "c"::text as k1');
  });
});
