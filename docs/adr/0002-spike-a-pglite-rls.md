# ADR 0002: Spike A, row level security inside PGlite

- Status: accepted
- Date: 2026-09-19
- Phase: 1 (spikes)

## Context

The product's verdicts come from running SQL as different personas inside an in-browser Postgres
and comparing row sets. That only works if PGlite implements roles, grants, row level security and
transaction-local identity the way a server Postgres does. If it did not, the whole in-browser
design would fall back to a Docker-only engine. This spike had to answer that before anything
else is built, and it had to leave the answer behind as a test, not as a memory.

Checked against `@electric-sql/pglite` 0.5.8, which reports `PostgreSQL 18.3 ... on
wasm32-unknown-emscripten`, in Node v26.8.1 on macOS arm64.

## Decision

**Spike A passes. PGlite is a sound engine for the matrix runner.** All ten claims of the task
hold, with one documented negative answer (`statement_timeout` is not enforced) and three findings
that change how later phases must be built (grant order, shape of the scope-escape probe, and
which of Supabase's two default-grant regimes a scenario stands for).

The proof lives in these files:

| File                                 | Role                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/spikes/pglite-rls.claims.mts` | The claims, written once. Each throws when it does not hold and returns one line of evidence when it does.                              |
| `tests/spikes/pglite-rls.test.ts`    | Vitest suite, one test per claim. Permanent regression test; part of `npm test`.                                                        |
| `scripts/spikes/pglite-rls.mjs`      | `node scripts/spikes/pglite-rls.mjs` prints PASS/FAIL per claim and exits 1 on any failure.                                             |
| `src/lib/engine/supabase-shim.ts`    | The real Supabase shim (`SUPABASE_SHIM_SQL`, `supabaseDefaultGrantsSql(schema)`, `quoteIdent`), with `supabase-shim.test.ts` beside it. |

The script and the suite share one claims module so they cannot disagree. The module is `.mts`
with erasable type syntax only, because the script loads it through Node's built-in type
stripping. It cannot import project `.ts` files (a `.ts` import path is error TS5097 under this
`tsconfig.json`, and an extension-less path does not resolve in plain Node), so the shim is handed
in through a small context object. Node prints one harmless `MODULE_TYPELESS_PACKAGE_JSON` warning
for `supabase-shim.ts` when the script runs, because `package.json` has no `"type": "module"`.

Negative controls were run by hand to make sure the claims can fail: with the default grants
replaced by a no-op, claims 9b, 9c and 10 fail and the script exits 1; with `BYPASSRLS` moved from
`service_role` to `anon`, 9a and 9b fail; with Supabase's `nullif(..., '')` guard removed from
`auth.uid()`, 9a fails with `22P02`; with the `autoExposeNewTables` option ignored (legacy SQL
returned for both values), 9d fails on `'[1,2]'` where `42501` is expected.

## Findings, claim by claim

1. **DDL.** `CREATE ROLE ... NOLOGIN`, `... BYPASSRLS`, `GRANT`, `ENABLE` / `FORCE` (and
   `DISABLE` / `NO FORCE`) `ROW LEVEL SECURITY`, `CREATE POLICY` with `USING` and `WITH CHECK`,
   permissive and restrictive, all work and are visible in the catalogs.
2. **Transaction-local identity.** Inside a transaction `SET LOCAL ROLE x` plus
   `set_config('request.jwt.claims', $1, true)` give `current_user = x`, `session_user = postgres`,
   and `current_setting('request.jwt.claims', true)` returns the exact JSON string. After
   `ROLLBACK`, `current_user` is `postgres` again and the data is identical. **Quirk:** the setting
   is `NULL` before its first use and an **empty string** afterwards, not `NULL` (standard Postgres
   placeholder behaviour). Any function that casts it must guard with `nullif(..., '')`, as
   Supabase's do; `''::jsonb` raises `22P02`.
3. **Real filtering, and the control.** Same query, `select id from docs order by id`: superuser
   `[1,2,3,4]`, alice `[1,2]`, bob `[3]`, unknown user `[]`. The control that would make the
   product lie: the same claims **without** `SET LOCAL ROLE` return `[1,2,3,4]`.
4. **The three bypasses** behave as documented: the superuser bypasses even with `FORCE`; a
   `BYPASSRLS` role bypasses reads and writes even with `FORCE`; a table owner sees `[1,2,3]`
   without `FORCE` and `[1]` with it. RLS enabled with no policy is default deny: empty reads, and
   writes fail with `42501`.
5. **Error shape.** PGlite rejects with `messages.DatabaseError` (exported from
   `@electric-sql/pglite`, `instanceof Error`). The SQLSTATE is the **`code`** property; `message`
   is the primary message; `severity`, `detail`, `hint`, `schema`, `table`, `constraint` and
   friends are present when Postgres sends them, and PGlite adds `query`, `params` and
   `queryOptions`.
   - RLS violation on INSERT or UPDATE: `42501`, with the message
     `new row violates row-level security policy for table "docs"`.
   - A missing table privilege is **also `42501`** (`permission denied for table folders`). Only
     the message tells the two apart. Both mean "blocked", which is what the classifier wants.
   - Constraints: `23505`, `23502`, `23514`, `23503` all surface as expected.
   - The policy is checked **before** the constraints: a row that breaks both the policy and a
     unique or not-null constraint reports `42501`.
   - After an error the transaction is aborted: every further statement fails with `25P02` until
     `ROLLBACK`. `tx.rollback()` works in that state and the instance stays usable.
     `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` work and keep role and claims, should the runner ever
     want several probes in one transaction.
6. **RETURNING and scope escape.** `UPDATE ... RETURNING` and `DELETE ... RETURNING` return only
   permitted rows, and only those rows are touched. Without `WITH CHECK`, `USING` is applied to the
   new row, so moving a row out of scope fails with `42501` in every shape. With an explicit
   `WITH CHECK (true)` the move is allowed, **but see "Scope-escape probe" below**: whether it is
   allowed depends on the shape of the UPDATE.
7. **`gen_random_uuid()`** exists (core since Postgres 13) and works as a column default.
   **`statement_timeout` is accepted but NOT enforced.** `set statement_timeout = '100ms'` succeeds
   and `show` reports it, yet `select pg_sleep(0.6)` completes after 601 ms, `pg_sleep(2)` after
   2000 ms, and a 200-million-row cross join ran for 16.8 s under a 300 ms timeout. No `57014` is
   ever raised. PGlite is a single-threaded WASM build with no signals or timers. Worse, a running
   query **blocks its JavaScript thread completely**: a 10 ms `setInterval` fired 0 times during
   the query, and `Promise.race` against a timer is won by the query. PGlite has no cancel API.
   Claim 7 pins this with `STATEMENT_TIMEOUT_IS_ENFORCED = false`; if an upgrade changes it, the
   test fails with a message pointing here.
8. **Catalog introspection** is complete: `pg_class.relrowsecurity` / `relforcerowsecurity`;
   `pg_policies` (`cmd`, `permissive`, `roles`, `qual`, `with_check`) and raw `pg_policy` with
   `pg_get_expr`; primary keys with column order, type and default through `pg_index` and through
   `information_schema`; a table without a primary key simply has no row there; view
   `reloptions` (`{security_invoker=true}` or `NULL`); `pg_proc.prosecdef` and `proconfig`
   (`{search_path=public, pg_temp}` or `NULL`). The flags also behave: a plain view and a
   `SECURITY DEFINER` function return `[1,2]` to a role for which the table returns `[1]`; their
   `security_invoker` / invoker counterparts return `[1]`.
9. **Supabase shim**, end to end. See the next section.
10. **Cost.** In Node, in one process: a fresh instance takes about 500 ms (median 504 ms, range
    487 to 505 ms; the first one in a cold process about 790 ms). Shim + schema + seed + grants:
    6 ms. A probe transaction (BEGIN, SET LOCAL ROLE, set_config, UPDATE RETURNING, ROLLBACK):
    median 0.6 ms, max 1.0 ms over 50 runs. `db.clone()` of a prepared instance: 130 ms. A fresh
    instance per run is affordable; a fresh instance per probe is not needed because probes roll
    back. The whole spike suite (about 20 instances) takes 11 s. `close()` matters: closed instances do
    not accumulate memory (RSS flat over 12 create/close cycles), while each instance held open
    costs roughly 160 MB of RSS in Node.

## The Supabase shim

`SUPABASE_SHIM_SQL` mirrors, with source URLs in the file:

- `anon`, `authenticated`: `NOLOGIN NOINHERIT`; `service_role`: `NOLOGIN NOINHERIT BYPASSRLS`
  (supabase/postgres `00000000000000-initial-schema.sql`).
- `auth.uid()`, `auth.role()`, `auth.email()` from supabase/auth migration `20220224000811`, and
  `auth.jwt()` from `20220531120530`, token for token. They read the legacy per-claim settings
  (`request.jwt.claim.sub`, ...) first and `request.jwt.claims` second. The supabase/auth migration
  list was read up to `20260911120000`; nothing later redefines them.
- `grant usage on schema auth to anon, authenticated, service_role`.

Deliberate differences: no `authenticator`, `supabase_admin` or other platform roles (nothing logs
in; probes switch role from the superuser session).

**Addition beyond the brief:** a minimal `auth.users` table (columns of Supabase's original
definition, primary key `id`, no privileges for the API roles). `references auth.users (id)` is the
most common foreign key in Supabase schemas; without the table such a schema would not load at
all. Seeds for such schemas must insert the users first.

`supabaseDefaultGrantsSql(schema)` emits `grant usage on schema`, `grant all on all tables /
sequences / functions in schema`, and the matching three `alter default privileges in schema`
statements, to the three API roles. The schema name goes through `quoteIdent`; a hostile name was
executed against PGlite in the unit test and stayed inside its quotes. **These blanket grants are
Supabase's legacy behaviour, not its current default**; see "Default grants: legacy and explicit"
below. `supabaseDefaultGrantsSql(schema, { autoExposeNewTables: false })` emits the other regime.

Proved: with the leaky policy `using (auth.uid() is not null)` user B reads `[1,2,3]` (leaked
`[1,2]`); with the correct policy `using (auth.uid() = user_id) with check (...)` A reads `[1,2]`,
B `[3]`, anon `[]`, `service_role` `[1,2,3]`, A's own insert is allowed and A's insert for B fails
with `42501`. A table with RLS disabled gives anon `42501 permission denied` before the default
grants and rows `[1,2]` after them.

## Three findings that change later phases

### Grant order: apply the default grants BEFORE the user's schema

The brief (3.5, setup step 4) applies the default grants after schema and seed. Supabase does the
opposite: the privileges are **default** privileges that exist before any user object. The order
matters when the user's SQL contains a `REVOKE`. Claim 9c proves it: for a table the user revoked
from `anon`, grants-first yields `42501` (what a real project does), grants-last lets `anon` read
it, which the product would report as a leak that does not exist.

Recommendation for Phase 3: in `supabase` mode run shim, then `supabaseDefaultGrantsSql(schema)`
for each exposed schema (creating a non-`public` exposed schema first if needed), then the user's
schema and seed. The function already contains both the `grant ... on all` and the
`alter default privileges` statements, so it is correct in either position; only the position
decides whether a user's `REVOKE` survives. `alter default privileges` applies to objects created
by the role that ran it, which is `postgres` here, the same role that runs the user's schema.

### Scope-escape probe: `WHERE pk = ...` alone misses a real escape

Postgres enforces the SELECT-applicable policies' `USING` on the **new** row of any UPDATE that
needs SELECT rights, which means any UPDATE with a `WHERE` or `RETURNING` that reads a column.
Measured, as alice, moving her row to bob:

| Policies                                                               | `... where id = 1` (with or without RETURNING) | `update docs set owner = 'bob'` |
| ---------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------- |
| `for all using (own)`                                                  | blocked `42501`                                | blocked `42501`                 |
| `for all using (own) with check (true)`                                | blocked `42501`                                | **allowed, 2 rows moved**       |
| `for select using (own)` + `for update using (own) with check (true)`  | blocked `42501`                                | **allowed, 2 rows moved**       |
| `for select using (true)` + `for update using (own) with check (true)` | **allowed**, RETURNING gives `[1]`             | **allowed, 2 rows moved**       |
| `for select using (true)` + `for update using (own)`                   | blocked `42501`                                | blocked `42501`                 |

So a probe of the form `UPDATE t SET tenant = <other> WHERE pk = <x>` reports "blocked" for the
second and third rows although any client can run the WHERE-less statement and push its rows into
someone else's scope. The escape probe in Phase 3 should try both shapes (targeted, then
WHERE-less without RETURNING) and count either success as an `escape`. Inside the rolled-back
transaction the probe can `RESET ROLE` (the session user is the superuser) and read the ground
truth to see which rows moved; claim 6 does exactly that.

### Default grants: legacy and explicit

_Added on 2026-09-19 after review. The first version of this ADR and of the shim header described
the blanket grants as what Supabase does today. That was wrong._

The init script in supabase/postgres (`00000000000000-initial-schema.sql`, read again on
2026-09-19) still contains `alter default privileges in schema public grant all on tables /
functions / sequences to postgres, anon, authenticated, service_role`. It is no longer the whole
picture. Supabase changelog 45329, "Breaking Change: Tables Not Exposed to Data and GraphQL API
Automatically" (published 2026-04-28, https://github.com/orgs/supabase/discussions/45329), and the
guide https://supabase.com/docs/guides/api/securing-your-api state (both read on 2026-09-19; the
guide as raw text, the changelog entry through a fetch tool that summarises, so its dates and
quotes should be re-read at the source before they are shown to users):

- **Since 2026-05-30** new projects do not grant `select, insert, update, delete` on new tables in
  `public`, nor `usage, select` on new sequences, to `anon`, `authenticated` and `service_role`.
- **On 2026-10-30** the same is applied to every existing project. Objects that already exist keep
  their grants; only objects created afterwards are affected.
- The project setting is called "Automatically expose new tables" (`auto_expose_new_tables` in
  `config.toml`). The documented opt-in SQL for an existing project is:

  ```sql
  alter default privileges for role postgres in schema public
    revoke select, insert, update, delete on tables from anon, authenticated, service_role;
  alter default privileges for role postgres in schema public
    revoke usage, select on sequences from anon, authenticated, service_role;
  ```

- Only `public` is touched. `storage`, `auth`, `realtime` and custom exposed schemas keep their
  grants (the custom-schema guide still tells users to run the `grant all` block themselves).
- A table is then exposed by the user's own SQL, for example `grant select on public.t to anon;`
  and `grant select, insert, update, delete on public.t to authenticated;`. Without it PostgREST
  answers `42501 permission denied for table t`.
- Functions: the changelog entry's SQL covers tables and sequences only. The guide's opt-in block
  additionally revokes `execute on functions` from the API roles and from `public`. Which of the
  two the platform applies to new projects was **not verified**; a maintainer comment under the
  changelog says Postgres' built-in `execute` to `PUBLIC` still applies to new functions.

What this means for the product. The brief (3.5 step 4) wants the blanket grants on purpose: they
are what makes an RLS-disabled table show up as readable by `anon`. That is a true finding for a
project created before 2026-05-30 whose tables exist before 2026-10-30, and a **false finding** for
a project under the new regime, where the same table answers `42501` until the user grants it. A
tool that always assumes the legacy grants will report leaks that a new project does not have; one
that always assumes the new regime will miss the most common real-world leak in older projects.

What was done in this spike, so that Phase 3 decides with evidence and not by accident:

- `supabaseDefaultGrantsSql(schema, { autoExposeNewTables })`. `true` (the default, unchanged
  output) is the legacy regime. `false` emits the init script's `grant all` defaults followed by
  the two documented `revoke` statements, and no `grant ... on all tables / sequences in schema`,
  because the platform leaves existing objects alone. Function grants are the same in both modes.
- Claim **9d** runs both regimes against the same schema in PGlite. RLS-disabled `audit_log` as
  `anon`: legacy `[1,2]`; explicit `42501 permission denied for table audit_log`, whether the grants
  run before or after the user's schema; `[1,2]` again once the user's SQL contains
  `grant select on public.audit_log to anon`. With `notes_fixed` granted to `authenticated` only,
  A reads `[1,2]`, B `[3]`, and `anon` **and `service_role`** get `42501`: `BYPASSRLS` does not
  bypass the privilege check.
- `supabase-shim.test.ts` pins the emitted SQL and checks the catalogs: under the explicit regime a
  new table has none of the four data privileges for any API role, a `serial` sequence has neither
  `usage` nor `select`, a function stays executable, schema `usage` stays, and a table that existed
  before is neither granted nor revoked. One residue, faithful to the documented SQL: `grant all`
  minus the four data privileges leaves `truncate`, `references`, `trigger` (and `maintain`) on new
  tables when the grants run before the schema. PostgREST does not expose those; a lint that reads
  table ACLs (RLS006) must not count them as write access.

**Decision handed to Phase 3 (not taken here):** how a scenario says which regime it stands for.
The suggestion is a scenario option in `supabase` mode, for example `grants: "legacy" | "explicit"`
mapped onto `autoExposeNewTables`, shown in the UI next to the mode switch and recorded in the
exported proof, because the verdict for an RLS-disabled table depends on it. Whichever default is
chosen, a finding of the kind "RLS disabled, readable by anon" must say which regime produced it.
Under the explicit regime a missing grant makes every probe for that role `42501`, which the
classifier reads as "blocked"; the report should tell "blocked by a missing grant" from "blocked
by a policy" (the message differs, the SQLSTATE does not, see finding 5).

## PGlite API notes for the engine adapter

- **Constructor:** `new PGlite()` is in-memory; `await db.waitReady`; `await db.close()`.
  `PGlite.create()` is the awaitable form. Default user `postgres` is a superuser with
  `BYPASSRLS`; no other non-system role exists.
- **`query(sql, params?)`** uses the extended protocol: one statement only (two give `42601
cannot insert multiple commands into a prepared statement`), `$1` parameters. Returns
  `{ rows, fields, affectedRows, command?, rowCount? }`.
- **`exec(sql)`** uses the simple protocol: many statements, no parameters, returns one result per
  statement. A multi-statement `exec` without its own `BEGIN` is one implicit transaction: if
  statement 2 of 3 fails, statement 1 is rolled back too (checked: the table did not exist
  afterwards). With explicit `BEGIN; ...; COMMIT;` inside, the committed part stays.
  `affectedRows` is cumulative across the statements of one `exec`; `rowCount` is per statement.
- **`transaction(cb)`** sends `BEGIN`, runs `cb(tx)`, then `COMMIT`; if `cb` throws it sends
  `ROLLBACK` and rethrows the same error object. `tx.rollback()` sends `ROLLBACK` and closes the
  handle (`tx.closed`); later calls on `tx` throw `Transaction is closed`. The probe pattern is
  "do the work, then always `tx.rollback()` in `finally`".
- **Deadlock:** calling `db.query` (not `tx.query`) inside the `transaction` callback never
  resolves until the transaction ends. Always use the `tx` handle.
- There is one connection. `BEGIN` sent through `exec` leaves the session inside that transaction
  for the following calls.
- `SET LOCAL` outside a transaction does nothing and emits notice `25P01`. `SET LOCAL ROLE $1` is
  a syntax error (`42601`); **`select set_config('role', $1, true)` is the parameterised
  equivalent** and also handles role names that need quoting. A missing role gives `22023`.
- **Type parsing, relevant to determinism:** `int8` and `count(*)` come back as `number`, but as
  `bigint` beyond 2^53; `numeric` as string; `date` / `timestamptz` as `Date` in the local
  timezone; `json(b)` parsed; arrays (including `name[]` and `text[]`) as JS arrays; `bytea` as
  `Uint8Array`. For byte-identical result JSON the runner should select keys and scope values as
  `::text`.
- `create extension "uuid-ossp"` / `pgcrypto` fail with `0A000 extension ... is not available`
  unless the extension is passed to the constructor (both ship in the package under
  `@electric-sql/pglite/contrib/*`). `gen_random_uuid()` needs neither.
- A `sub` claim that is not a uuid makes `auth.uid()` raise `22P02`, which the classifier will
  correctly report as `inconclusive`; persona defaults in `supabase` mode should use real uuids.

## Consequences

- The in-browser design stands. The Docker-only fallback of Phase 1 is not needed.
- **Timeouts (brief 4.4):** `statement_timeout` must not be counted on. The only working timeout
  is the one the brief already names: run PGlite in a Web Worker, time the probe from the main
  thread, and on expiry `terminate()` the worker, start a new one, rebuild the database and mark
  the probe `inconclusive`. Setting `statement_timeout` in the session is harmless but does
  nothing. In Node (tests, a future CLI) there is no such guard unless the engine is put in a
  `worker_threads` worker; a runaway user query will hang a test until Vitest's own timeout.
- Rebuilding after a terminated worker costs about half a second plus a few milliseconds of setup,
  so it is cheap enough to do per timeout.
- `db.clone()` (130 ms) is a possible later optimisation for "fresh instance per run"; not needed
  now.
- The engine adapter should normalise errors to `{ code, message, detail?, hint? }` from
  `DatabaseError` and treat a missing `code` as a non-database failure.
- Open decisions handed to the orchestrator: adopt grants-first order; give the scope-escape probe
  its second shape; **choose how a scenario expresses legacy versus explicit default grants, and
  which one is the default** (see "Default grants: legacy and explicit"); keep or drop `auth.users`
  in the shim; whether to load `uuid-ossp` and `pgcrypto` (and create Supabase's `extensions`
  schema) so that common Supabase schema SQL loads unchanged.
