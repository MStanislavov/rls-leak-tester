/**
 * Regressions for wrong verdicts that three independent reviews reproduced. Every scenario here
 * once gave ISOLATED although the role reaches foreign rows (or LEAKING on a correct policy). Each
 * test states the reality first, as the reviewer measured it by hand in the same database.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_TABLE_REMARK } from "@/lib/runner";
import { ALICE, BOB, CAROL, CLAIM, cellOf, keys, run, scenarioOf, subProbeOf } from "./helpers";

const OWN = `user_id = ${CLAIM("sub")}::uuid`;
const MY_TENANT = `tenant_id = ${CLAIM("tenant_id")}::int`;
const RUN_TIMEOUT_MS = 60_000;

const alice = {
  id: "alice",
  label: "Alice",
  dbRole: "app_user",
  claims: { sub: ALICE, tenant_id: 1 },
  tenantClaimPath: "tenant_id",
};

describe("UPDATE reach", () => {
  it(
    "finds the row takeover when USING is wider than WITH CHECK",
    async () => {
      // As alice: update notes set user_id = ALICE where id = 2 returning id -> [2].
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            create table notes (id int primary key, user_id uuid not null, tenant_id int not null, body text);
            alter table notes enable row level security;
            create policy r on notes for select to app_user using (${MY_TENANT});
            create policy u on notes for update to app_user using (${MY_TENANT}) with check (${OWN});
            grant select, update on notes to app_user;`,
          seedSql: `insert into notes values (1,'${ALICE}',1,'a'),(2,'${BOB}',1,'b'),(3,'${CAROL}',2,'c');`,
          personas: [alice],
          expectations: [
            {
              personaId: "alice",
              schema: "public",
              table: "notes",
              operation: "select",
              scope: "tenant",
            },
          ],
        }),
      );
      const cell = cellOf(result, "alice", "notes", "update");
      expect(cell).toMatchObject({
        scope: "own",
        status: "leak",
        actualKeys: keys(1, 2),
        leakedKeys: keys(2),
        perRowFallback: true,
      });
      expect(cell.sql).toContain(`set "user_id" = '${ALICE}'::uuid`);
      expect(result.verdict).toBe("LEAKING");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "has a blind shape: a role without a SELECT policy can still overwrite every row",
    async () => {
      // As anon: update todos set done = true -> 2 rows.
      const { result } = await run(
        scenarioOf({
          mode: "supabase",
          schemaSql: `
            create table todos (id int primary key, user_id uuid not null, done boolean not null default false);
            alter table todos enable row level security;
            create policy sel on todos for select to authenticated using (auth.uid() = user_id);
            create policy upd_own on todos for update to authenticated using (auth.uid() = user_id);
            create policy upd_anon on todos for update to anon using (true);`,
          seedSql: `insert into todos values (1,'${ALICE}',false),(2,'${BOB}',true);`,
          personas: [
            { id: "anon", label: "Anon", dbRole: "anon", claims: {} },
            { id: "alice", label: "Alice", dbRole: "authenticated", claims: { sub: ALICE } },
          ],
        }),
      );
      expect(cellOf(result, "anon", "todos", "update")).toMatchObject({
        status: "leak",
        expectedKeys: [],
        actualKeys: keys(1, 2),
        blindKeys: keys(1, 2),
        leakedKeys: keys(1, 2),
      });
      expect(cellOf(result, "alice", "todos", "update")).toMatchObject({
        status: "pass",
        actualKeys: keys(1),
        blindKeys: [],
      });
      expect(result.verdict).toBe("LEAKING");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "is not fooled by column-level SELECT grants, nor by a write-only role",
    async () => {
      // As app_user: update accounts set secret_token = 'stolen' where id = 2 returning id -> [2].
      // As app_writer: update counters set hits = 999 -> 2 rows.
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            create role app_writer nologin;
            create table accounts (id int primary key, user_id uuid not null, secret_token text, display_name text);
            alter table accounts enable row level security;
            create policy r on accounts for select to app_user using (true);
            create policy u on accounts for update to app_user using (true);
            grant select (id, user_id, display_name) on accounts to app_user;
            grant update on accounts to app_user;
            create table counters (id int primary key, user_id uuid not null, hits int not null default 0);
            alter table counters enable row level security;
            create policy u on counters for update to app_writer using (true);
            grant update on counters to app_writer;`,
          seedSql: `
            insert into accounts values (1,'${ALICE}','s1','alice'),(2,'${BOB}','s2','bob');
            insert into counters values (1,'${ALICE}',0),(2,'${BOB}',0);`,
          personas: [
            { id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } },
            { id: "writer", label: "Writer", dbRole: "app_writer", claims: {} },
          ],
        }),
      );
      const accounts = cellOf(result, "alice", "accounts", "update");
      expect(accounts).toMatchObject({ status: "leak", leakedKeys: keys(2) });
      expect(accounts.statement).toBe(
        'update "public"."accounts" set "display_name" = "display_name" returning "id"::text as k0',
      );
      expect(cellOf(result, "writer", "counters", "update")).toMatchObject({
        status: "leak",
        actualKeys: keys(1, 2),
        blindKeys: keys(1, 2),
        perRowFallback: false,
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "tries the tenant column as well when the scope is own (the headline leak of template 1)",
    async () => {
      // As alice: update projects set tenant_id = 2 where id = 1 returning id -> [1].
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            create table projects (id int primary key, user_id uuid not null, tenant_id int not null, name text);
            alter table projects enable row level security;
            create policy r on projects for select to app_user using (${OWN});
            create policy u on projects for update to app_user using (${OWN} and ${MY_TENANT}) with check (${OWN});
            grant select, update on projects to app_user;`,
          seedSql: `insert into projects values (1,'${ALICE}',1,'a'),(2,'${BOB}',1,'b'),(3,'${CAROL}',2,'c');`,
          personas: [alice],
        }),
      );
      const cell = cellOf(result, "alice", "projects", "update");
      expect(cell).toMatchObject({ scope: "own", status: "escape", leakedKeys: [] });
      const moved = cell.subProbes.filter((probe) => probe.status === "escape");
      expect(moved.map((probe) => probe.kind)).toEqual(["escape-targeted", "escape-bulk"]);
      expect(moved[0]?.statement).toContain(`set "tenant_id" = '2'::integer`);
      expect(moved[0]?.movedKeys).toEqual(keys(1));
      // The owner column is still probed, and still blocked.
      expect(subProbeOf(cell, "escape-targeted")).toMatchObject({ status: "pass" });
      expect(subProbeOf(cell, "escape-targeted").statement).toContain(`set "user_id" =`);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("SELECT reach", () => {
  it(
    "is never a pass when only the key column is not selectable",
    async () => {
      // As app_anon: select email from profiles -> both rows.
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_anon nologin;
            create table profiles (id int primary key, user_id uuid not null, email text, display_name text);
            grant select (display_name, email) on profiles to app_anon;
            create table half (id int primary key, user_id uuid not null, email text);
            alter table half enable row level security;
            create policy one on half for select to app_anon using (id = 1);
            grant select (email) on half to app_anon;
            create table closed (id int primary key, user_id uuid not null, email text);`,
          seedSql: `
            insert into profiles values (1,'${ALICE}','a@x','alice'),(2,'${BOB}','b@x','bob');
            insert into half values (1,'${ALICE}','a@x'),(2,'${BOB}','b@x');
            insert into closed values (1,'${ALICE}','a@x');`,
          personas: [{ id: "visitor", label: "Visitor", dbRole: "app_anon", claims: {} }],
        }),
      );
      // Every row is visible, so every key is known although the key cannot be read.
      expect(cellOf(result, "visitor", "profiles", "select")).toMatchObject({
        status: "leak",
        actualKeys: keys(1, 2),
      });
      // One of two rows is visible: which one cannot be told without the key.
      const half = cellOf(result, "visitor", "half", "select");
      expect(half.status).toBe("inconclusive");
      expect(half.reason).toContain("1 of 2 rows");
      // No privilege at all is a real block.
      expect(cellOf(result, "visitor", "closed", "select")).toMatchObject({
        status: "pass",
        error: { sqlState: "42501" },
      });
      expect(result.verdict).toBe("LEAKING");
    },
    RUN_TIMEOUT_MS,
  );
});

describe("INSERT", () => {
  it(
    "clones a row whose column type lives in a schema the role cannot use",
    async () => {
      // As alice: insert into tickets (id, user_id, status) values (99, BOB, 'done') -> 1 row.
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            create schema private;
            create type private.status as enum ('open', 'done');
            create table tickets (id int primary key, user_id uuid not null, status private.status not null default 'open');
            alter table tickets enable row level security;
            create policy r on tickets for select to app_user using (${OWN});
            create policy i on tickets for insert to app_user with check (true);
            grant select, insert on tickets to app_user;`,
          seedSql: `insert into tickets values (1,'${ALICE}','open'),(2,'${BOB}','done');`,
          personas: [{ id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } }],
        }),
      );
      const cell = cellOf(result, "alice", "tickets", "insert");
      expect(cell.status).toBe("escape");
      expect(subProbeOf(cell, "insert-own")).toMatchObject({ outcome: "allowed", status: "pass" });
      expect(subProbeOf(cell, "insert-other")).toMatchObject({
        outcome: "allowed",
        status: "escape",
        error: null,
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "attempts an out-of-scope row of a class although the class also has in-scope rows",
    async () => {
      // As alice: insert into docs values (99, BOB, 2) -> 1 row.
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            create table docs (id int primary key, user_id uuid not null, tenant_id int);
            alter table docs enable row level security;
            create policy r on docs for select to app_user using (${OWN});
            create policy i on docs for insert to app_user with check (true);
            grant select, insert on docs to app_user;`,
          seedSql: `insert into docs values (1,'${ALICE}',2),(2,'${BOB}',2),(3,'${CAROL}',3);`,
          personas: [alice],
        }),
      );
      const cell = cellOf(result, "alice", "docs", "insert");
      expect(
        cell.subProbes.map((probe) => [probe.kind, probe.sourceKey, probe.expected, probe.status]),
      ).toEqual([
        ["insert-other", keys(1)[0], "allowed", "pass"],
        ["insert-other", keys(2)[0], "blocked", "escape"],
      ]);
      expect(cell.status).toBe("escape");
    },
    RUN_TIMEOUT_MS,
  );
});

describe("a 42501 that is not about the probed rows", () => {
  it(
    "is inconclusive, never blocked: a cast to a type in a schema the role cannot use",
    async () => {
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            create schema private;
            create domain private.tenant as int;
            create table docs (id int primary key, tenant_id private.tenant not null);
            alter table docs enable row level security;
            create policy t on docs for all to app_user using (true);
            grant select, update on docs to app_user;`,
          seedSql: "insert into docs values (1, 1), (2, 2);",
          personas: [
            {
              id: "alice",
              label: "Alice",
              dbRole: "app_user",
              claims: { sub: ALICE, tenant_id: 1 },
              tenantClaimPath: "tenant_id",
            },
          ],
        }),
      );
      const cell = cellOf(result, "alice", "docs", "update");
      const targeted = subProbeOf(cell, "escape-targeted");
      expect(targeted.error?.message).toBe("permission denied for schema private");
      expect(targeted).toMatchObject({ outcome: "inconclusive", status: "inconclusive" });
      // The reach probe alone already proves the leak.
      expect(cell).toMatchObject({ status: "leak", leakedKeys: keys(2) });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("nothing measured is never ISOLATED", () => {
  it.each([
    ["postgres", "create role app_user nologin; grant all on docs to app_user;", "app_user"],
    ["supabase", "", "anon"],
  ] as const)(
    "%s mode: a table without seeded rows proves nothing",
    async (mode, grants, dbRole) => {
      const { result } = await run(
        scenarioOf({
          mode,
          schemaSql: `create table docs (id int primary key, user_id uuid not null); ${grants}`,
          personas: [{ id: "someone", label: "Someone", dbRole, claims: {} }],
        }),
      );
      expect(result.verdict).toBe("NOT PROVEN");
      expect(result.counts).toMatchObject({ pass: 0, skipped: 4 });
      expect(cellOf(result, "someone", "docs", "select")).toMatchObject({
        status: "skipped",
        reason: EMPTY_TABLE_REMARK,
        sql: "",
      });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("own and tenant are decided by the database, not by comparing text", () => {
  it(
    "an upper-case uuid in sub (what macOS uuidgen prints) is the same user",
    async () => {
      const UPPER = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
      const { result } = await run(
        scenarioOf({
          mode: "supabase",
          schemaSql: `
            create table notes (id int primary key, user_id uuid not null, org_id uuid not null);
            alter table notes enable row level security;
            create policy own on notes for all to authenticated
              using (user_id = auth.uid())
              with check (user_id = auth.uid() and org_id = (auth.jwt() ->> 'org')::uuid);`,
          seedSql: `insert into notes values (1,'${UPPER}','${UPPER}'),(2,'${BOB}','${BOB}');`,
          personas: [
            {
              id: "alice",
              label: "Alice",
              dbRole: "authenticated",
              claims: { sub: UPPER, org: UPPER },
              tenantClaimPath: "org",
            },
          ],
          expectations: [
            {
              personaId: "alice",
              schema: "public",
              table: "notes",
              operation: "delete",
              scope: "tenant",
            },
          ],
        }),
      );
      expect(result.verdict).toBe("ISOLATED");
      expect(result.counts).toMatchObject({ pass: 4, leak: 0, escape: 0 });
      expect(cellOf(result, "alice", "notes", "select").expectedKeys).toEqual(keys(1));
      expect(cellOf(result, "alice", "notes", "delete").expectedKeys).toEqual(keys(1));
      const insert = cellOf(result, "alice", "notes", "insert");
      expect(subProbeOf(insert, "insert-own")).toMatchObject({ sourceKey: keys(1)[0] });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "a numeric tenant seeded as 1.0 belongs to the claim 1",
    async () => {
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            create table invoices (id int primary key, tenant_id numeric(4,1) not null);
            alter table invoices enable row level security;
            create policy t on invoices for all to app_user using (tenant_id = ${CLAIM("tenant_id")}::numeric);
            grant select, insert, update, delete on invoices to app_user;`,
          seedSql: "insert into invoices values (1, 1.0), (2, 2.0);",
          personas: [
            {
              id: "alice",
              label: "Alice",
              dbRole: "app_user",
              claims: { sub: ALICE, tenant_id: 1 },
              tenantClaimPath: "tenant_id",
            },
          ],
        }),
      );
      expect(cellOf(result, "alice", "invoices", "select")).toMatchObject({
        scope: "tenant",
        status: "pass",
        expectedKeys: keys(1),
      });
      expect(result.verdict).toBe("ISOLATED");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "scope tenant for a signed-in persona without tenantClaimPath cannot be decided",
    async () => {
      const { result } = await run(
        scenarioOf({
          mode: "supabase",
          schemaSql: `
            create table invoices (id int primary key, tenant_id int not null);
            alter table invoices enable row level security;
            create policy t on invoices for all to authenticated
              using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int)
              with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int);`,
          seedSql: "insert into invoices values (1, 1), (2, 2);",
          personas: [
            {
              id: "alice",
              label: "Alice",
              dbRole: "authenticated",
              claims: { sub: ALICE, app_metadata: { tenant_id: 1 } },
            },
          ],
        }),
      );
      const cell = cellOf(result, "alice", "invoices", "select");
      expect(cell).toMatchObject({ scope: "tenant", status: "skipped" });
      expect(cell.reason).toContain("tenantClaimPath");
      expect(result.counts).toMatchObject({ leak: 0, escape: 0, skipped: 4 });
      expect(result.verdict).toBe("NOT PROVEN");
    },
    RUN_TIMEOUT_MS,
  );
});

describe("edges of the new probe shapes", () => {
  it(
    "takeover and blind update: constraint errors, unfit claims and the next candidate column",
    async () => {
      const takeover = (name: string, extra: string): string => `
        create table ${name} (id int primary key, user_id uuid not null ${extra}, body text);
        alter table ${name} enable row level security;
        create policy see_all on ${name} for select to app_user using (true);
        create policy write_own on ${name} for update to app_user
          using (true) with check (user_id::text = ${CLAIM("sub")});
        grant select, update on ${name} to app_user;
        insert into ${name} values (1, '${ALICE}', 'a'), (2, '${BOB}', 'b');`;
      const writeOnly = (name: string, columns: string): string => `
        create table ${name} (id int primary key, ${columns});
        alter table ${name} enable row level security;
        create policy anyone on ${name} for update to app_user using (true);
        grant update on ${name} to app_user;`;
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            ${takeover("one_each", "unique")}
            ${takeover("plain", "")}
            ${writeOnly("slugs", "slug text unique, body text")}
            insert into slugs values (1, 'a', 'x'), (2, 'b', 'y');
            ${writeOnly("only_unique", "slug text unique")}
            insert into only_unique values (1, 'a'), (2, 'b');`,
          personas: [
            { id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } },
            { id: "mallory", label: "Mallory", dbRole: "app_user", claims: { sub: "mallory" } },
          ],
          tables: [
            { schema: "public", name: "slugs" },
            { schema: "public", name: "only_unique" },
          ],
        }),
      );
      // Taking Bob's row over would break unique (user_id): not authorization, so not a verdict.
      expect(cellOf(result, "alice", "one_each", "update")).toMatchObject({
        status: "inconclusive",
        perRowFallback: true,
        actualKeys: keys(1),
        error: { sqlState: "23505" },
      });
      expect(cellOf(result, "alice", "plain", "update")).toMatchObject({
        status: "leak",
        leakedKeys: keys(2),
      });
      // "mallory" is no uuid: the takeover value does not fit the column (22P02), which is not
      // a finding and not an error of the cell. She owns nothing and reaches nothing.
      expect(cellOf(result, "mallory", "plain", "update")).toMatchObject({
        status: "pass",
        perRowFallback: true,
        expectedKeys: [],
        actualKeys: [],
      });
      // One value for every row collides on the unique column; the next column measures.
      const slugs = cellOf(result, "alice", "slugs", "update");
      expect(slugs).toMatchObject({ status: "leak", blindKeys: keys(1, 2) });
      expect(slugs.sql).toContain(`set "slug" = (select "slug" from`);
      expect(slugs.sql).toContain(`set "body" = (select "body" from`);
      // No column is left that could take one value: nothing was measured, and it says so.
      expect(cellOf(result, "alice", "only_unique", "update")).toMatchObject({
        status: "inconclusive",
        actualKeys: [],
        error: { sqlState: "23505" },
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "the row count behind an unreadable key: none visible is a pass, a failing count is not",
    async () => {
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_anon nologin;
            create table hidden (id int primary key, user_id uuid not null, email text);
            alter table hidden enable row level security;
            create policy nobody on hidden for select to app_anon using (false);
            grant select (email) on hidden to app_anon;
            create table broken (id int primary key, user_id uuid not null, email text);
            alter table broken enable row level security;
            create policy boom on broken for select to app_anon using (1 / (id - id) > 0);
            grant select (email) on broken to app_anon;`,
          seedSql: `
            insert into hidden values (1, '${ALICE}', 'a@x');
            insert into broken values (1, '${ALICE}', 'a@x');`,
          personas: [{ id: "visitor", label: "Visitor", dbRole: "app_anon", claims: {} }],
        }),
      );
      const hidden = cellOf(result, "visitor", "hidden", "select");
      expect(hidden).toMatchObject({
        status: "pass",
        actualKeys: [],
        error: { sqlState: "42501" },
      });
      expect(hidden.sql).toContain('select count(*)::text as visible_rows from "public"."hidden";');
      expect(cellOf(result, "visitor", "broken", "select")).toMatchObject({
        status: "inconclusive",
        error: { sqlState: "22012" },
      });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("a 42501 that a trigger raises for one row", () => {
  it(
    "is measured row by row: the other rows are still a leak",
    async () => {
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            create table guarded (id int primary key, user_id uuid not null, body text);
            alter table guarded enable row level security;
            create policy anyone on guarded for all to app_user using (true);
            grant select, update on guarded to app_user;
            create function lock_first() returns trigger language plpgsql as $$
            begin
              if old.id = 1 then
                raise exception 'row 1 is locked' using errcode = 'insufficient_privilege';
              end if;
              return new;
            end $$;
            create trigger lock_first before update on guarded
              for each row execute function lock_first();`,
          seedSql: `insert into guarded values (1,'${BOB}','b1'),(2,'${BOB}','b2'),(3,'${ALICE}','a');`,
          personas: [{ id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } }],
        }),
      );
      expect(cellOf(result, "alice", "guarded", "update")).toMatchObject({
        status: "leak",
        perRowFallback: true,
        actualKeys: keys(2, 3),
        leakedKeys: keys(2),
        error: { sqlState: "42501", message: "row 1 is locked" },
      });
    },
    RUN_TIMEOUT_MS,
  );
});
