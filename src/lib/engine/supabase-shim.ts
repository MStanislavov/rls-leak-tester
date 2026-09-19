/**
 * The Supabase shim: the smallest piece of a Supabase database that row level security policies
 * depend on, so that a policy written for Supabase runs unchanged inside a plain Postgres
 * (PGlite). Pure strings, no I/O; the engine decides when to execute them.
 *
 * Sources mirrored here (checked on 2026-09-19):
 *
 * - Roles `anon`, `authenticated`, `service_role` and the LEGACY default privileges on the exposed
 *   schema (`alter default privileges ... grant all`):
 *   https://github.com/supabase/postgres/blob/develop/migrations/db/init-scripts/00000000000000-initial-schema.sql
 *   That script is no longer the whole story. Since 2026-05-30 new projects do not auto-grant
 *   select, insert, update, delete on new `public` tables (nor usage, select on sequences) to the
 *   API roles, and from 2026-10-30 the same holds for every existing project; objects that already
 *   exist keep their grants. See `SupabaseDefaultGrantsOptions.autoExposeNewTables` below.
 *   https://github.com/orgs/supabase/discussions/45329
 *   https://supabase.com/docs/guides/api/securing-your-api
 * - `auth.uid()`, `auth.role()`, `auth.email()` (current bodies):
 *   https://github.com/supabase/auth/blob/master/migrations/20220224000811_update_auth_functions.up.sql
 * - `auth.jwt()`:
 *   https://github.com/supabase/auth/blob/master/migrations/20220531120530_add_auth_jwt_function.up.sql
 * - `grant usage on schema auth` and the original `auth.users` columns:
 *   https://github.com/supabase/postgres/blob/develop/migrations/db/init-scripts/00000000000001-auth-schema.sql
 *
 * No later migration in supabase/auth redefines the four functions (the migration list was read
 * up to 20260911120000).
 */

/** The three roles a Supabase API request can run as. Order is stable on purpose. */
export const SUPABASE_API_ROLES = ["anon", "authenticated", "service_role"] as const;

export type SupabaseApiRole = (typeof SUPABASE_API_ROLES)[number];

/** The setting PostgREST fills with the verified JWT payload for the length of one transaction. */
export const JWT_CLAIMS_SETTING = "request.jwt.claims";

const API_ROLE_LIST = SUPABASE_API_ROLES.join(", ");

/**
 * Run once, as the superuser, on a fresh database, before the user's schema.
 *
 * Differences from a real Supabase project, all deliberate:
 * - No `authenticator`, `supabase_admin`, `supabase_auth_admin` or other platform roles: probes
 *   switch role with `SET LOCAL ROLE` from the superuser session, so nothing needs to log in.
 * - `auth.users` carries only the columns of Supabase's original definition. It exists because
 *   `references auth.users (id)` is the most common foreign key in Supabase schemas; without the
 *   table that schema SQL would not even load. As on Supabase, the API roles get no privilege on it.
 * - The function bodies are Supabase's, token for token (only whitespace differs), including the
 *   legacy per-claim settings (`request.jwt.claim.sub` and friends) that are consulted first.
 */
export const SUPABASE_SHIM_SQL = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema if not exists auth;

create table if not exists auth.users (
  instance_id uuid null,
  id uuid not null unique,
  aud varchar(255) null,
  "role" varchar(255) null,
  email varchar(255) null unique,
  encrypted_password varchar(255) null,
  confirmed_at timestamptz null,
  invited_at timestamptz null,
  last_sign_in_at timestamptz null,
  raw_app_meta_data jsonb null,
  raw_user_meta_data jsonb null,
  is_super_admin bool null,
  created_at timestamptz null,
  updated_at timestamptz null,
  constraint users_pkey primary key (id)
);

create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql stable
as $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email()
returns text
language sql stable
as $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

create or replace function auth.jwt()
returns jsonb
language sql stable
as $$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$;

grant usage on schema auth to ${API_ROLE_LIST};
`;

/**
 * Quote a Postgres identifier. Schema names come from user input, so they are never
 * interpolated raw.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new Error("An identifier cannot be empty.");
  }
  if (name.includes("\0")) {
    throw new Error("An identifier cannot contain a NUL character.");
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export interface SupabaseDefaultGrantsOptions {
  /**
   * Mirrors the Supabase project setting "Automatically expose new tables"
   * (`auto_expose_new_tables` in `config.toml`).
   *
   * - `true` (default here): the LEGACY behaviour. Every table, sequence and function in the
   *   schema is granted to the API roles, so row level security is the only barrier left and a
   *   table with RLS disabled is readable by `anon`. This is what the brief asks for and what
   *   every project created before 2026-05-30 does until 2026-10-30.
   * - `false`: the behaviour of projects created since 2026-05-30, and of every project from
   *   2026-10-30 on. New tables get no select, insert, update or delete for the API roles, and new
   *   sequences no usage or select, until the user's own SQL grants them. Without such a grant a
   *   table is unreachable for `anon` whatever its RLS state (`42501 permission denied`).
   *
   * Which value a scenario uses is a Phase 3 decision; see docs/adr/0002-spike-a-pglite-rls.md.
   */
  readonly autoExposeNewTables?: boolean;
}

/**
 * The privileges Supabase gives the API roles on an exposed schema. The schema must exist when
 * this runs.
 *
 * With `autoExposeNewTables: true` (legacy) the statements cover both orders: the
 * `grant ... on all ... in schema` lines reach objects that already exist, the
 * `alter default privileges` lines reach objects the current role creates afterwards.
 *
 * With `autoExposeNewTables: false` the result is what a project has after Supabase's documented
 * opt-in SQL: the init script's `grant all` defaults, minus select, insert, update, delete on
 * tables and usage, select on sequences. Tables and sequences that already exist are left alone,
 * as on the platform ("existing tables keep their current grants"), so in this mode the position
 * relative to the user's schema does not change which of select, insert, update and delete the
 * user's tables get: none, unless the user's SQL grants them. (Applied before the schema, new
 * tables still receive what is left of `grant all`: truncate, references, trigger, maintain.)
 * Function privileges stay as in legacy mode: the changelog entry changes tables and sequences
 * only, while the "Securing your API" guide also revokes execute on functions; that difference is
 * left to Phase 3.
 */
export function supabaseDefaultGrantsSql(
  schema: string,
  options: SupabaseDefaultGrantsOptions = {},
): string {
  const target = quoteIdent(schema);
  const autoExposeNewTables = options.autoExposeNewTables ?? true;
  const defaults = `alter default privileges in schema ${target}`;
  return [
    `grant usage on schema ${target} to ${API_ROLE_LIST};`,
    ...(autoExposeNewTables
      ? [
          `grant all on all tables in schema ${target} to ${API_ROLE_LIST};`,
          `grant all on all sequences in schema ${target} to ${API_ROLE_LIST};`,
        ]
      : []),
    `grant all on all functions in schema ${target} to ${API_ROLE_LIST};`,
    `${defaults} grant all on tables to ${API_ROLE_LIST};`,
    `${defaults} grant all on sequences to ${API_ROLE_LIST};`,
    `${defaults} grant all on functions to ${API_ROLE_LIST};`,
    ...(autoExposeNewTables
      ? []
      : [
          `${defaults} revoke select, insert, update, delete on tables from ${API_ROLE_LIST};`,
          `${defaults} revoke usage, select on sequences from ${API_ROLE_LIST};`,
        ]),
    "",
  ].join("\n");
}
