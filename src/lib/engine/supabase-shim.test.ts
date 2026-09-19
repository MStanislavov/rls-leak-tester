import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  JWT_CLAIMS_SETTING,
  SUPABASE_API_ROLES,
  SUPABASE_SHIM_SQL,
  quoteIdent,
  supabaseDefaultGrantsSql,
} from "./supabase-shim";

describe("quoteIdent", () => {
  it("wraps a plain name in double quotes", () => {
    expect(quoteIdent("public")).toBe('"public"');
  });

  it("keeps case, spaces and doubles embedded quotes", () => {
    expect(quoteIdent('My "api" schema')).toBe('"My ""api"" schema"');
  });

  it("rejects an empty name", () => {
    expect(() => quoteIdent("")).toThrow("cannot be empty");
  });

  it("rejects a NUL character", () => {
    expect(() => quoteIdent("pub\0lic")).toThrow("NUL");
  });
});

describe("supabaseDefaultGrantsSql", () => {
  it("grants usage and everything on tables, sequences and functions to the three API roles", () => {
    expect(supabaseDefaultGrantsSql("public")).toBe(
      [
        'grant usage on schema "public" to anon, authenticated, service_role;',
        'grant all on all tables in schema "public" to anon, authenticated, service_role;',
        'grant all on all sequences in schema "public" to anon, authenticated, service_role;',
        'grant all on all functions in schema "public" to anon, authenticated, service_role;',
        'alter default privileges in schema "public" grant all on tables to anon, authenticated, service_role;',
        'alter default privileges in schema "public" grant all on sequences to anon, authenticated, service_role;',
        'alter default privileges in schema "public" grant all on functions to anon, authenticated, service_role;',
        "",
      ].join("\n"),
    );
  });

  it("treats an explicit autoExposeNewTables: true as the legacy default", () => {
    expect(supabaseDefaultGrantsSql("public", { autoExposeNewTables: true })).toBe(
      supabaseDefaultGrantsSql("public"),
    );
  });

  it("with autoExposeNewTables: false keeps Supabase's defaults minus the data privileges, and leaves existing tables alone", () => {
    expect(supabaseDefaultGrantsSql("public", { autoExposeNewTables: false })).toBe(
      [
        'grant usage on schema "public" to anon, authenticated, service_role;',
        'grant all on all functions in schema "public" to anon, authenticated, service_role;',
        'alter default privileges in schema "public" grant all on tables to anon, authenticated, service_role;',
        'alter default privileges in schema "public" grant all on sequences to anon, authenticated, service_role;',
        'alter default privileges in schema "public" grant all on functions to anon, authenticated, service_role;',
        'alter default privileges in schema "public" revoke select, insert, update, delete on tables from anon, authenticated, service_role;',
        'alter default privileges in schema "public" revoke usage, select on sequences from anon, authenticated, service_role;',
        "",
      ].join("\n"),
    );
  });

  it("never lets a schema name break out of its quotes", () => {
    const sql = supabaseDefaultGrantsSql('x"; drop schema auth cascade; --');
    expect(sql).toContain('on schema "x""; drop schema auth cascade; --" to anon');
    expect(sql.split("\n").filter((line) => line !== "")).toHaveLength(7);
  });
});

describe("the shim inside a real Postgres (PGlite)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(SUPABASE_SHIM_SQL);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it("names the claims setting PostgREST uses", () => {
    expect(JWT_CLAIMS_SETTING).toBe("request.jwt.claims");
    expect(SUPABASE_SHIM_SQL).toContain(`current_setting('${JWT_CLAIMS_SETTING}', true)`);
  });

  it("creates exactly the API roles, and only service_role bypasses RLS", async () => {
    const roles = await db.query<{ name: string; bypassrls: boolean; login: boolean }>(
      `select rolname::text as name, rolbypassrls as bypassrls, rolcanlogin as login
         from pg_roles where rolname !~ '^pg_' and not rolsuper order by rolname`,
    );
    expect(roles.rows.map((role) => role.name)).toEqual([...SUPABASE_API_ROLES].sort());
    expect(roles.rows.filter((role) => role.bypassrls).map((role) => role.name)).toEqual([
      "service_role",
    ]);
    expect(roles.rows.some((role) => role.login)).toBe(false);
  });

  it("defines the four auth functions as STABLE, SECURITY INVOKER, with Supabase's return types", async () => {
    const functions = await db.query(
      `select p.proname::text as name, pg_get_function_result(p.oid) as returns,
              p.provolatile::text as volatility, p.prosecdef as security_definer
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' order by p.proname`,
    );
    expect(functions.rows).toEqual([
      { name: "email", returns: "text", volatility: "s", security_definer: false },
      { name: "jwt", returns: "jsonb", volatility: "s", security_definer: false },
      { name: "role", returns: "text", volatility: "s", security_definer: false },
      { name: "uid", returns: "uuid", volatility: "s", security_definer: false },
    ]);
  });

  it("lets the API roles into the auth schema but not into auth.users", async () => {
    const access = await db.query(
      `select r as role, has_schema_privilege(r, 'auth', 'usage') as auth_usage,
              has_function_privilege(r, 'auth.uid()', 'execute') as uid_execute,
              has_table_privilege(r, 'auth.users', 'select') as users_select
         from unnest(array['anon', 'authenticated']) as r order by r`,
    );
    expect(access.rows).toEqual([
      { role: "anon", auth_usage: true, uid_execute: true, users_select: false },
      { role: "authenticated", auth_usage: true, uid_execute: true, users_select: false },
    ]);
  });

  it("applies the default grants to a schema with a hostile name without touching anything else", async () => {
    const hostile = 'x"; drop schema auth cascade; --';
    await db.exec(
      `create schema ${quoteIdent(hostile)}; create table ${quoteIdent(hostile)}.t (id int);`,
    );
    await db.exec(supabaseDefaultGrantsSql(hostile));

    const result = await db.query(
      `select has_schema_privilege('anon', $1, 'usage') as usage,
              has_table_privilege('anon', $2, 'select') as table_select,
              exists (select 1 from pg_namespace where nspname = 'auth') as auth_still_there`,
      // has_schema_privilege takes the bare name, has_table_privilege parses a quoted path.
      [hostile, `${quoteIdent(hostile)}.t`],
    );
    expect(result.rows).toEqual([{ usage: true, table_select: true, auth_still_there: true }]);
  });

  it("with autoExposeNewTables: false a new table and its sequence stay closed until the user grants them", async () => {
    await db.exec(`create schema explicit_api; create table explicit_api.before (id int);`);
    await db.exec(supabaseDefaultGrantsSql("explicit_api", { autoExposeNewTables: false }));
    await db.exec(
      `create table explicit_api.after (id serial primary key);
       create function explicit_api.ping() returns int language sql as 'select 1';`,
    );

    const privileges = (table: string) =>
      db.query(
        `select r as role,
                has_table_privilege(r, $1, 'select') as can_select,
                has_table_privilege(r, $1, 'insert') as can_insert,
                has_table_privilege(r, $1, 'update') as can_update,
                has_table_privilege(r, $1, 'delete') as can_delete
           from unnest(array['anon', 'authenticated', 'service_role']) as r order by r`,
        [table],
      );
    const closed = ["anon", "authenticated", "service_role"].map((role) => ({
      role,
      can_select: false,
      can_insert: false,
      can_update: false,
      can_delete: false,
    }));
    expect((await privileges("explicit_api.after")).rows).toEqual(closed);
    // A table that existed before is left exactly as it was: nothing granted, nothing revoked.
    expect((await privileges("explicit_api.before")).rows).toEqual(closed);

    const rest = await db.query(
      `select has_schema_privilege('anon', 'explicit_api', 'usage') as schema_usage,
              has_sequence_privilege('anon', 'explicit_api.after_id_seq', 'usage') as sequence_usage,
              has_sequence_privilege('anon', 'explicit_api.after_id_seq', 'select') as sequence_select,
              has_function_privilege('anon', 'explicit_api.ping()', 'execute') as function_execute,
              has_table_privilege('anon', 'explicit_api.after', 'truncate') as leftover_truncate`,
    );
    expect(rest.rows).toEqual([
      {
        schema_usage: true,
        sequence_usage: false,
        sequence_select: false,
        function_execute: true,
        leftover_truncate: true,
      },
    ]);

    // The user's own grant, as Supabase now documents it, is what opens the table.
    await db.exec(`grant select on explicit_api.after to anon;`);
    expect((await privileges("explicit_api.after")).rows[0]).toEqual({
      role: "anon",
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
    });
  });

  it("is meant for a fresh database: a second application fails on the existing role", async () => {
    await expect(db.exec(SUPABASE_SHIM_SQL)).rejects.toMatchObject({ code: "42710" });
  });
});
