/**
 * Scenarios for the export suites. The templates have no per-row fallback, no takeover, no blind
 * shape, no overblock and no inconclusive cell, so these fixtures bring every branch of the SQL
 * runtime to life. What each table is for is said next to it; what the cells must come out as is
 * NOT declared here: the suites compare the exported file with the matrix runner, cell by cell.
 */
import type { Scenario } from "@/lib/scenario";
import { ALICE, BOB, CAROL, CLAIM, scenarioOf } from "../runner/helpers";

const OWN = `user_id = ${CLAIM("sub")}::uuid`;
const MY_TENANT = `tenant_id = ${CLAIM("tenant_id")}::int`;

const alice = {
  id: "alice",
  label: "Alice",
  dbRole: "app_user",
  claims: { sub: ALICE, tenant_id: 1 },
  tenantClaimPath: "tenant_id",
};

const notes = (name: string, policies: string): string => `
  create table ${name} (id int primary key, user_id uuid not null, body text);
  alter table ${name} enable row level security;
  ${policies}
  grant select, insert, update, delete on ${name} to app_user;
  insert into ${name} values (1, '${ALICE}', 'a1'), (2, '${ALICE}', 'a2'), (3, '${BOB}', 'b1');`;

/** Reach in all its shapes: bulk, row by row, takeover, blind UPDATE and DELETE, the row count. */
export const REACH_SHAPES: Scenario = scenarioOf({
  id: "export-reach-shapes",
  title: "Reach shapes",
  schemaSql: `
    create role app_user nologin;
    create role app_anon nologin;
    ${notes("notes_ok", `create policy own on notes_ok for all using (${OWN});`)}
    -- The bulk no-op raises 42501: row by row, then the takeover of Bob's row.
    ${notes("notes_leaky", `create policy anyone on notes_leaky for all using (true) with check (${OWN});`)}
    -- WITH CHECK (false): neither the no-op nor the takeover goes through.
    ${notes(
      "notes_sealed",
      `create policy see on notes_sealed for select using (true);
       create policy seal on notes_sealed for update using (true) with check (false);`,
    )}
    -- The RETURNING shape deletes the own rows, the WHERE-less one all of them.
    ${notes(
      "notes_blind",
      `create policy read_own on notes_blind for select using (${OWN});
       create policy delete_any on notes_blind for delete using (true);`,
    )}
    -- Default deny: every own row is missing, an overblock.
    ${notes("notes_locked", "")}

    -- Taking Bob's row over breaks unique (user_id): 23505, not authorization.
    create table one_each (id int primary key, user_id uuid not null unique, body text);
    alter table one_each enable row level security;
    create policy see on one_each for select to app_user using (true);
    create policy write_own on one_each for update to app_user using (true) with check (user_id::text = ${CLAIM("sub")});
    grant select, update on one_each to app_user;
    insert into one_each values (1, '${ALICE}', 'a'), (2, '${BOB}', 'b');

    -- A foreign key makes DELETE raise 23503 for the statement and for one row.
    create table folders (id int primary key, user_id uuid not null);
    create table files (id int primary key, folder_id int not null references folders (id));
    alter table folders enable row level security;
    create policy own on folders for all using (${OWN});
    grant select, delete on folders to app_user;
    insert into folders values (1, '${ALICE}'), (2, '${ALICE}'), (3, '${BOB}');
    insert into files values (10, 1);

    -- Write-only: no SELECT right, so only the blind UPDATE sees what the role can overwrite.
    create table counters (id int primary key, user_id uuid not null, hits int not null default 0);
    alter table counters enable row level security;
    create policy u on counters for update to app_user using (true);
    grant update on counters to app_user;
    insert into counters values (1, '${ALICE}', 0), (2, '${BOB}', 0);
    -- One value for every row collides on the unique column; the next column measures.
    create table slugs (id int primary key, slug text unique, body text);
    alter table slugs enable row level security;
    create policy u on slugs for update to app_user using (true);
    grant update on slugs to app_user;
    insert into slugs values (1, 'a', 'x'), (2, 'b', 'y');
    -- No column is left that could take one value: nothing measured.
    create table only_unique (id int primary key, slug text unique);
    alter table only_unique enable row level security;
    create policy u on only_unique for update to app_user using (true);
    grant update on only_unique to app_user;
    insert into only_unique values (1, 'a'), (2, 'b');

    -- The key is not selectable: all rows visible, one of two, none, and a failing count.
    create table profiles (id int primary key, user_id uuid not null, email text);
    grant select (email) on profiles to app_anon;
    insert into profiles values (1, '${ALICE}', 'a@x'), (2, '${BOB}', 'b@x');
    create table half (id int primary key, user_id uuid not null, email text);
    alter table half enable row level security;
    create policy one on half for select to app_anon using (id = 1);
    grant select (email) on half to app_anon;
    insert into half values (1, '${ALICE}', 'a@x'), (2, '${BOB}', 'b@x');
    create table hidden (id int primary key, user_id uuid not null, email text);
    alter table hidden enable row level security;
    create policy nobody on hidden for select to app_anon using (false);
    grant select (email) on hidden to app_anon;
    insert into hidden values (1, '${ALICE}', 'a@x');
    create table broken (id int primary key, user_id uuid not null, email text);
    alter table broken enable row level security;
    create policy boom on broken for select to app_anon using (1 / (id - id) > 0);
    grant select (email) on broken to app_anon;
    insert into broken values (1, '${ALICE}', 'a@x');

    -- Nothing to probe: no primary key, no rows.
    create table nopk (user_id uuid, body text);
    grant select on nopk to app_user;
    create table notes_empty (id int primary key, user_id uuid not null);
    grant select on notes_empty to app_user;
  `,
  personas: [
    alice,
    { id: "mallory", label: "Mallory", dbRole: "app_user", claims: { sub: "mallory" } },
    { id: "visitor", label: "Visitor", dbRole: "app_anon", claims: {} },
    { id: "ghost", label: "Ghost", dbRole: "no_such_role", claims: { sub: ALICE } },
  ],
  tables: [
    { schema: "public", name: "slugs" },
    { schema: "public", name: "only_unique" },
  ],
  expectations: [
    {
      personaId: "alice",
      schema: "public",
      table: "notes_ok",
      operation: "select",
      scope: "custom",
      expectedRowsSql: "select id from no_such_table",
    },
  ],
});

const tenantTable = (name: string, policies: string): string => `
  create table ${name} (id int primary key, tenant_id int not null, user_id uuid not null, title text);
  alter table ${name} enable row level security;
  ${policies}
  grant select, insert, update, delete on ${name} to app_user;
  insert into ${name} values (1, 1, '${ALICE}', 'a'), (2, 1, '${BOB}', 'b'), (3, 2, '${CAROL}', 'c');`;

/** Scope escapes (both shapes, both columns) and inserts (classes, fresh keys, constraint errors). */
export const ESCAPES_AND_INSERTS: Scenario = scenarioOf({
  id: "export-escapes-inserts",
  title: "Escapes and inserts",
  schemaSql: `
    create role app_user nologin;
    create schema private;
    create domain private.tenant as int;
    ${tenantTable("t_ok", `create policy p on t_ok for all using (${MY_TENANT});`)}
    ${tenantTable("t_check_true", `create policy p on t_check_true for all using (${MY_TENANT}) with check (true);`)}
    -- SELECT of every tenant: the targeted shape sees the moved row, so both shapes escape.
    ${tenantTable(
      "t_select_all",
      `create policy s on t_select_all for select using (true);
       create policy u on t_select_all for update using (${MY_TENANT}) with check (true);`,
    )}
    -- Scope own with a tenant claim: the tenant column is moved as well.
    ${tenantTable("t_own", `create policy p on t_own for all using (${OWN}) with check (${OWN});`)}
    -- A policy stricter than the expectation: the in-scope insert is blocked, an overblock.
    ${tenantTable("t_strict", `create policy p on t_strict for all using (${MY_TENANT}) with check (${MY_TENANT} and ${OWN});`)}

    -- The moved value is cast to a type in a schema the role cannot use: inconclusive, not blocked.
    create table docs (id int primary key, tenant_id private.tenant not null);
    alter table docs enable row level security;
    create policy t on docs for all to app_user using (true);
    grant select, update on docs to app_user;
    insert into docs values (1, 1), (2, 2);

    -- A unique violation on a cloned column is inconclusive, never a pass or an escape.
    create table unique_slugs (id int primary key, user_id uuid not null, slug text not null unique);
    alter table unique_slugs enable row level security;
    create policy own on unique_slugs for all using (${OWN});
    grant select, insert on unique_slugs to app_user;
    insert into unique_slugs values (1, '${ALICE}', 'hello'), (2, '${BOB}', 'world');

    -- A composite key keeps its tenant column and replaces the other one.
    create table line_items (tenant_id int not null, line int not null, user_id uuid not null, primary key (tenant_id, line));
    alter table line_items enable row level security;
    create policy tenant on line_items for all using (${MY_TENANT});
    grant select, insert, update, delete on line_items to app_user;
    insert into line_items values (1, 1, '${ALICE}'), (1, 2, '${BOB}'), (2, 1, '${CAROL}');

    -- A uuid key, a default now() column, a key nobody can make, a table nobody can update.
    create table by_uuid (id uuid primary key default gen_random_uuid(), user_id uuid not null, at timestamptz not null default now());
    alter table by_uuid enable row level security;
    create policy own on by_uuid for all using (${OWN});
    grant select, insert on by_uuid to app_user;
    insert into by_uuid (id, user_id) values ('00000000-0000-4000-8000-000000000001', '${ALICE}'), ('bbbbbbbb-0000-4000-8000-000000000002', '${BOB}');
    create table by_text (code text primary key, user_id uuid not null);
    alter table by_text enable row level security;
    create policy own on by_text for all using (${OWN});
    grant select, insert on by_text to app_user;
    insert into by_text values ('A-1', '${ALICE}');
    create table all_generated (id int generated always as identity primary key, twice int generated always as (id * 2) stored);
    alter table all_generated enable row level security;
    create policy anyone on all_generated for all using (true);
    grant select, update on all_generated to app_user;
    insert into all_generated default values;
  `,
  personas: [alice],
  tables: [{ schema: "public", name: "line_items", tenantColumn: "tenant_id" }],
  expectations: [
    ...(["t_ok", "t_check_true", "t_select_all", "t_strict"] as const).flatMap((table) =>
      (["select", "insert", "update", "delete"] as const).map((operation) => ({
        personaId: "alice",
        schema: "public",
        table,
        operation,
        scope: "tenant" as const,
      })),
    ),
  ],
});

/** Supabase mode: `anon` may UPDATE every row without any SELECT policy (the blind shape). */
export const SUPABASE_BLIND: Scenario = scenarioOf({
  id: "export-supabase-blind",
  title: "Supabase, blind update",
  mode: "supabase",
  schemaSql: `
    create table todos (id int primary key, user_id uuid not null, done boolean not null default false);
    alter table todos enable row level security;
    create policy sel on todos for select to authenticated using (auth.uid() = user_id);
    create policy upd_own on todos for update to authenticated using (auth.uid() = user_id);
    create policy upd_anon on todos for update to anon using (true);`,
  seedSql: `insert into todos values (1, '${ALICE}', false), (2, '${BOB}', true);`,
  personas: [
    { id: "anon", label: "Anon", dbRole: "anon", claims: {} },
    { id: "alice", label: "Alice", dbRole: "authenticated", claims: { sub: ALICE } },
    { id: "service", label: "Service", dbRole: "service_role", claims: {} },
  ],
});

/** Every cell is skipped: nothing can be proven, and the file must say so instead of passing. */
export const NOTHING_TO_PROVE: Scenario = scenarioOf({
  id: "export-nothing-to-prove",
  title: "Nothing to prove",
  schemaSql: `
    create role app_user nologin;
    create table nopk (user_id uuid, body text);
    grant select on nopk to app_user;`,
  personas: [{ id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } }],
});

/** Names, labels and claims that would break naive quoting: the exported file must still run. */
export const HOSTILE_TEXT: Scenario = scenarioOf({
  id: "export-hostile-text",
  title: "Hostile $rls$ 'text' -- ; drop table",
  schemaSql: `
    create role "app user" nologin;
    create table "Odd ""Table" ("Id" int primary key, "user id" uuid not null, note text);
    alter table "Odd ""Table" enable row level security;
    create policy own on "Odd ""Table" for all using ("user id"::text = ${CLAIM("sub")});
    grant select, insert, update, delete on "Odd ""Table" to "app user";
    insert into "Odd ""Table" values (1, '${ALICE}', 'it''s'), (2, '${BOB}', '$sql$');`,
  personas: [
    {
      id: "alice",
      label: "O'Brien $rls$ $sql$ \\ %s",
      dbRole: "app user",
      claims: { sub: ALICE, note: "it's $sql$ \\ $fn$ back" },
    },
  ],
  tables: [{ schema: "public", name: 'Odd "Table', ownerColumn: "user id" }],
});

/**
 * Session state between the schema and the seed: the runner keeps one session for both, so the
 * seed finds `notes` through the schema script's `search_path`. The workflow must load them the
 * same way, or the lab is green and CI fails at the seed.
 */
export const SESSION_STATE: Scenario = scenarioOf({
  id: "export-session-state",
  title: "Session state between schema and seed",
  schemaSql: `
    create role app_user nologin;
    create schema app;
    grant usage on schema app to app_user;
    set search_path = app, public;
    create table notes (id int primary key, user_id uuid not null, body text);
    alter table notes enable row level security;
    create policy own on notes for all using (${OWN});
    grant select, insert, update, delete on notes to app_user;`,
  seedSql: `insert into notes values (1, '${ALICE}', 'a'), (2, '${BOB}', 'b');`,
  personas: [{ id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } }],
  options: { exposedSchemas: ["app"], supabaseGrants: "legacy" },
});

/** The usual Supabase seed: the uuid key comes from its default, so it differs on every load. */
export const VOLATILE_KEYS: Scenario = scenarioOf({
  id: "export-volatile-keys",
  title: "Seed with default uuid keys",
  mode: "supabase",
  schemaSql: `
    create table todos (id uuid primary key default gen_random_uuid(), user_id uuid not null, title text);
    alter table todos enable row level security;
    create policy own on todos for all to authenticated
      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
    create table labels (id int primary key, user_id uuid not null);
    alter table labels enable row level security;
    create policy own on labels for all to authenticated
      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);`,
  seedSql: `
    insert into todos (user_id, title) values ('${ALICE}', 'a'), ('${BOB}', 'b');
    insert into labels values (1, '${ALICE}'), (2, '${BOB}');`,
  personas: [
    { id: "anon", label: "Anon", dbRole: "anon", claims: {} },
    { id: "alice", label: "Alice", dbRole: "authenticated", claims: { sub: ALICE } },
  ],
});

const visitor = { id: "visitor", label: "Visitor", dbRole: "app_anon", claims: {} };
const plainAlice = { id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } };

/**
 * The CI use case: the check is exported from the good schema, a later migration regresses it and
 * the seed stays. Regression: the anonymous role may UPDATE every row and holds no SELECT, which
 * only the blind UPDATE can see, and at export time the role held UPDATE on no column.
 */
export const writeOnlyGrant = (regressed: boolean): Scenario =>
  scenarioOf({
    id: `export-write-only-${regressed ? "regressed" : "good"}`,
    title: "Write-only grant added later",
    schemaSql: `
      create role app_user nologin;
      create role app_anon nologin;
      create table counters (id int primary key, user_id uuid not null, hits int not null default 0);
      alter table counters enable row level security;
      create policy own on counters for all to app_user using (${OWN});
      grant select, insert, update, delete on counters to app_user;
      ${
        regressed
          ? `create policy bump on counters for update to app_anon using (true);
             grant update on counters to app_anon;`
          : ""
      }`,
    seedSql: `insert into counters values (1, '${ALICE}', 0), (2, '${BOB}', 0);`,
    personas: [plainAlice, visitor],
    tables: [{ schema: "public", name: "counters", ownerColumn: "user_id" }],
    expectations: (["select", "insert", "update", "delete"] as const).map((operation) => ({
      personaId: "visitor",
      schema: "public",
      table: "counters",
      operation,
      scope: "none" as const,
    })),
  });

/** Regression: a table is added to the exposed schema and left without row level security. */
export const tableAddedLater = (regressed: boolean): Scenario =>
  scenarioOf({
    id: `export-new-table-${regressed ? "regressed" : "good"}`,
    title: "A table added later",
    schemaSql: `
      create role app_user nologin;
      create table notes (id int primary key, user_id uuid not null, body text);
      alter table notes enable row level security;
      create policy own on notes for all to app_user using (${OWN});
      grant select, insert, update, delete on notes to app_user;
      ${
        regressed
          ? `create table invoices (id int primary key, user_id uuid not null, amount int);
             grant select, insert, update, delete on invoices to app_user;
             insert into invoices values (1, '${ALICE}', 10), (2, '${BOB}', 20);`
          : ""
      }`,
    seedSql: `insert into notes values (1, '${ALICE}', 'a'), (2, '${BOB}', 'b');`,
    personas: [plainAlice],
  });

/**
 * Column grants and the blind UPDATE. The exported file also plans constants for columns the role
 * holds no UPDATE on (for the day a migration grants them); their "permission denied" must not
 * change what the granted columns measured: a collision stays inconclusive, as in the runner.
 */
export const COLUMN_GRANTS: Scenario = scenarioOf({
  id: "export-column-grants",
  title: "Column grants",
  schemaSql: `
    create role app_user nologin;
    -- UPDATE on the unique column only: one value for every row collides (23505), not measured.
    create table tags (id int primary key, slug text unique, body text);
    alter table tags enable row level security;
    create policy u on tags for update to app_user using (true);
    grant update (slug) on tags to app_user;
    insert into tags values (1, 'a', 'x'), (2, 'b', 'y');
    -- UPDATE on a plain column only: the blind shape overwrites every row.
    create table posts (id int primary key, slug text unique, body text);
    alter table posts enable row level security;
    create policy u on posts for update to app_user using (true);
    grant update (body) on posts to app_user;
    insert into posts values (1, 'a', 'x'), (2, 'b', 'y');
    -- No UPDATE at all: every constant is denied, which is no finding.
    create table sealed (id int primary key, slug text unique, body text);
    alter table sealed enable row level security;
    create policy s on sealed for select to app_user using (true);
    grant select on sealed to app_user;
    insert into sealed values (1, 'a', 'x');`,
  personas: [{ id: "mallory", label: "Mallory", dbRole: "app_user", claims: { sub: "mallory" } }],
  expectations: (["tags", "posts", "sealed"] as const).map((table) => ({
    personaId: "mallory",
    schema: "public",
    table,
    operation: "update" as const,
    scope: "none" as const,
  })),
});
