/**
 * The per-row fallback (a bulk statement that raises is measured again row by row in savepoints)
 * and the two shapes of the scope-escape probe (ADR 0002 claim 6), against a real PGlite.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MatrixResult } from "@/lib/runner";
import { ALICE, BOB, CLAIM, cellOf, keys, run, scenarioOf, subProbeOf } from "./helpers";

const OWN = `user_id = ${CLAIM("sub")}::uuid`;
const MY_TENANT = `tenant_id = ${CLAIM("tenant_id")}::int`;

const tenantTable = (name: string, policies: string): string => `
  create table ${name} (id int primary key, tenant_id int not null, title text);
  alter table ${name} enable row level security;
  ${policies}
  grant select, insert, update, delete on ${name} to app_user;
  insert into ${name} values (1, 1, 'a'), (2, 1, 'b'), (3, 2, 'c');
`;

const SCHEMA = `
  create role app_user nologin;

  -- WITH CHECK stricter than USING: the bulk no-op UPDATE raises 42501 for the whole statement.
  create table strict (id int primary key, user_id uuid not null, body text);
  alter table strict enable row level security;
  create policy see_all on strict for select using (true);
  create policy write_own on strict for update using (true) with check (${OWN});
  grant select, update on strict to app_user;
  insert into strict values (1, '${ALICE}', 'a1'), (2, '${ALICE}', 'a2'), (3, '${BOB}', 'b1');

  -- WITH CHECK (false): no new row passes, so neither the no-op nor the takeover goes through.
  create table sealed (id int primary key, user_id uuid not null, body text);
  alter table sealed enable row level security;
  create policy see_all on sealed for select using (true);
  create policy write_none on sealed for update using (true) with check (false);
  grant select, update on sealed to app_user;
  insert into sealed values (1, '${ALICE}', 'a1'), (2, '${ALICE}', 'a2'), (3, '${BOB}', 'b1');

  -- A foreign key makes DELETE raise 23503 for the whole statement.
  create table folders (id int primary key, user_id uuid not null);
  create table files (id int primary key, folder_id int not null references folders (id));
  alter table folders enable row level security;
  create policy own on folders for all using (${OWN});
  grant select, delete on folders to app_user;
  insert into folders values (1, '${ALICE}'), (2, '${ALICE}'), (3, '${BOB}');
  insert into files values (10, 1);

  create table folders_leaky (id int primary key, user_id uuid not null);
  create table files_leaky (id int primary key, folder_id int not null references folders_leaky (id));
  alter table folders_leaky enable row level security;
  create policy anyone on folders_leaky for all using (true);
  grant select, delete on folders_leaky to app_user;
  insert into folders_leaky values (1, '${ALICE}'), (2, '${ALICE}'), (3, '${BOB}');
  insert into files_leaky values (10, 1);

  ${tenantTable("t_using_only", `create policy p on t_using_only for all using (${MY_TENANT});`)}
  ${tenantTable(
    "t_check_true",
    `create policy p on t_check_true for all using (${MY_TENANT}) with check (true);`,
  )}
  ${tenantTable(
    "t_split",
    `create policy s on t_split for select using (${MY_TENANT});
     create policy u on t_split for update using (${MY_TENANT}) with check (true);`,
  )}
  ${tenantTable(
    "t_select_all",
    `create policy s on t_select_all for select using (true);
     create policy u on t_select_all for update using (${MY_TENANT}) with check (true);`,
  )}
  create table t_unique (id int primary key, tenant_id int not null, title text, unique (tenant_id, title));
  alter table t_unique enable row level security;
  create policy p on t_unique for all using (${MY_TENANT}) with check (true);
  grant select, insert, update, delete on t_unique to app_user;
  insert into t_unique values (1, 1, 'a'), (2, 1, 'b'), (3, 2, 'a');

  create table plain (id int primary key, title text);
  alter table plain enable row level security;
  grant select, update on plain to app_user;
  insert into plain values (1, 'x');
`;

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
  expectations: [
    { personaId: "alice", schema: "public", table: "strict", operation: "select", scope: "all" },
    { personaId: "alice", schema: "public", table: "sealed", operation: "select", scope: "all" },
    {
      personaId: "alice",
      schema: "public",
      table: "t_select_all",
      operation: "select",
      scope: "all",
    },
  ],
});

describe("per-row fallback and scope escape", () => {
  let result: MatrixResult;

  beforeAll(async () => {
    result = (await run(scenario)).result;
  }, 60_000);

  describe("per-row fallback", () => {
    it("a WITH CHECK stricter than USING: row by row, and the foreign row can be taken over", () => {
      // This cell used to be asserted as `pass`. It never was one: USING (true) lets Alice at
      // Bob's row, and WITH CHECK (own) is satisfied by making the row hers. By hand, as Alice:
      // update strict set user_id = ALICE where id = 3 returning id -> [3].
      const cell = cellOf(result, "alice", "strict", "update");
      expect(cell).toMatchObject({
        status: "leak",
        perRowFallback: true,
        expectedKeys: keys(1, 2),
        actualKeys: keys(1, 2, 3),
        leakedKeys: keys(3),
        error: {
          sqlState: "42501",
          message: 'new row violates row-level security policy for table "strict"',
        },
      });
      expect(cell.sql).toContain("-- The statement raised 42501: reach measured row by row.");
      expect(cell.sql).toContain("savepoint rls_probe;");
      expect(cell.sql).toContain(
        `update "public"."strict" set "body" = "body" where "id"::text = '3' returning "id"::text as k0;\nrollback to savepoint rls_probe;`,
      );
      expect(cell.sql).toContain(
        `update "public"."strict" set "user_id" = '${ALICE}'::uuid where "id"::text = '3' returning "id"::text as k0;\nrollback to savepoint rls_probe;`,
      );
      // The own rows need no takeover: the no-op went through for them.
      expect(cell.sql).not.toContain(`'${ALICE}'::uuid where "id"::text = '1'`);
    });

    it("a WITH CHECK that nothing satisfies blocks the takeover too", () => {
      expect(cellOf(result, "alice", "sealed", "update")).toMatchObject({
        status: "overblock",
        perRowFallback: true,
        actualKeys: [],
        leakedKeys: [],
        missingKeys: keys(1, 2),
      });
    });

    it("a foreign key error on one row makes the cell inconclusive and shows the error", () => {
      const cell = cellOf(result, "alice", "folders", "delete");
      expect(cell).toMatchObject({
        status: "inconclusive",
        perRowFallback: true,
        actualKeys: keys(2),
        leakedKeys: [],
        error: { sqlState: "23503" },
      });
      expect(cell.reason).toContain("violates foreign key constraint");
    });

    it("a proven leak stays a leak although another row was inconclusive", () => {
      expect(cellOf(result, "alice", "folders_leaky", "delete")).toMatchObject({
        status: "leak",
        perRowFallback: true,
        actualKeys: keys(2, 3),
        leakedKeys: keys(3),
        error: { sqlState: "23503" },
      });
    });
  });

  describe("scope escape", () => {
    it("USING alone covers the new row: both shapes are blocked", () => {
      const cell = cellOf(result, "alice", "t_using_only", "update");
      expect(cell.status).toBe("pass");
      for (const kind of ["escape-targeted", "escape-bulk"] as const) {
        expect(subProbeOf(cell, kind)).toMatchObject({
          expected: "blocked",
          outcome: "blocked",
          status: "pass",
          sourceKey: keys(1)[0],
          error: { sqlState: "42501" },
        });
      }
    });

    it.each(["t_check_true", "t_split"])(
      "%s: WITH CHECK (true) escapes only through the WHERE-less shape",
      (table) => {
        const cell = cellOf(result, "alice", table, "update");
        expect(cell).toMatchObject({ status: "escape", leakedKeys: [], actualKeys: keys(1, 2) });
        expect(subProbeOf(cell, "escape-targeted")).toMatchObject({
          outcome: "blocked",
          status: "pass",
        });
        const bulk = subProbeOf(cell, "escape-bulk");
        expect(bulk).toMatchObject({
          outcome: "allowed",
          status: "escape",
          movedKeys: keys(1, 2),
          error: null,
        });
        expect(bulk.sql).toContain(`update "public"."${table}" set "tenant_id" = '2'::integer;`);
        expect(bulk.sql).toContain(
          `reset role;\nselect "id"::text as k0 from "public"."${table}" where "tenant_id"::text = '2';`,
        );
      },
    );

    it("with SELECT open to everyone the targeted shape escapes too", () => {
      const cell = cellOf(result, "alice", "t_select_all", "update");
      expect(cell.status).toBe("escape");
      expect(subProbeOf(cell, "escape-targeted")).toMatchObject({
        outcome: "allowed",
        status: "escape",
        movedKeys: keys(1),
      });
      expect(subProbeOf(cell, "escape-bulk")).toMatchObject({ status: "escape" });
      expect(subProbeOf(cell, "escape-targeted").sql).toContain(
        `update "public"."t_select_all" set "tenant_id" = '2'::integer where "id"::text = '1' returning "id"::text as k0;`,
      );
    });

    it("a constraint error in an escape shape is inconclusive, never a pass and never an escape", () => {
      const cell = cellOf(result, "alice", "t_unique", "update");
      // Moving row 1 into tenant 2 collides with unique (tenant_id, title).
      expect(subProbeOf(cell, "escape-bulk")).toMatchObject({
        outcome: "inconclusive",
        status: "inconclusive",
        error: { sqlState: "23505" },
      });
      expect(cell.status).toBe("inconclusive");
      expect(cell.reason).toContain("duplicate key value");
    });

    it("a sub-probe that does not apply is skipped and leaves a passing cell passing", () => {
      const cell = cellOf(result, "alice", "plain", "update");
      expect(cell).toMatchObject({ status: "pass", scope: "none", actualKeys: [] });
      expect(cell.subProbes).toHaveLength(2);
      for (const probe of cell.subProbes) {
        expect(probe).toMatchObject({
          outcome: "skipped",
          status: "skipped",
          sql: "",
          reason: 'No row is inside scope "none": there is nothing to move.',
        });
      }
    });
  });

  it("counts the escapes: three UPDATE cells, and the INSERT that WITH CHECK (true) lets through", () => {
    expect(result.verdict).toBe("LEAKING");
    expect(result.cells.filter((cell) => cell.status === "escape").map((cell) => cell.id)).toEqual([
      "alice|public.t_check_true|insert",
      "alice|public.t_check_true|update",
      "alice|public.t_select_all|update",
      "alice|public.t_split|update",
    ]);
    expect(result.counts.escape).toBe(4);
  });
});
