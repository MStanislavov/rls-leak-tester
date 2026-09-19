# Static checks RLS001 to RLS009: semantics, decisions and limits

Status: accepted (draft number, the orchestrator assigns one)
Date: 2026-09-19

## Context

Brief 3.6 lists nine static checks that run on the catalog snapshot and are shown next to the
matrix. They must be deterministic, must not involve the model, and each must be confirmed against
the official documentation before it is implemented. Several rules are under-specified in the
brief ("looser", "granted to anon" while the tool grants to anon itself, "reachable by API
roles"), and the catalog model delivered by the engine slice does not carry everything the brief
assumes. This record states what was confirmed, what was measured and what was decided.

The code is `src/lib/checks/` (pure, ARCH-001): `runStaticChecks(catalog, context)` returns
`Finding[]`. A finding is a fact, never a verdict (P1); it does not change ISOLATED / LEAKING.

## Evidence

### Documentation (read on 2026-09-19; the URL is the `docsUrl` of the findings)

- https://www.postgresql.org/docs/current/ddl-rowsecurity.html (RLS001, RLS002, RLS009):
  "By default, tables do not have any policies, so that if a user has access privileges to a table
  according to the SQL privilege system, all rows within it are equally available for querying or
  updating." "If no policy exists for the table, a default-deny policy is used, meaning that no
  rows are visible or can be modified." "Superusers and roles with the BYPASSRLS attribute always
  bypass the row security system when accessing a table. Table owners normally bypass row security
  as well, though a table owner can choose to be subject to row security with ALTER TABLE ... FORCE
  ROW LEVEL SECURITY." "Operations that apply to the whole table, such as TRUNCATE and REFERENCES,
  are not subject to row security."
- https://www.postgresql.org/docs/current/sql-createpolicy.html (RLS003, RLS004): "All permissive
  policies which are applicable to a given query will be combined together using the Boolean 'OR'
  operator." "All restrictive policies ... will be combined together using the Boolean 'AND'
  operator." "The default is PUBLIC, which will apply the policy to all roles." "For policies that
  can have both USING and WITH CHECK expressions (ALL and UPDATE), if no WITH CHECK expression is
  defined, then the USING expression will be used both to determine which rows are visible (normal
  USING case) and which new rows will be allowed to be added (WITH CHECK case)."
- https://www.postgresql.org/docs/current/sql-createview.html (RLS008): "By default, access to the
  underlying base relations referenced in the view is determined by the permissions of the view
  owner." With `security_invoker` "the policies and permissions of the invoking user are used
  instead". "a security invoker view will always check its underlying base relations using the
  permissions of the current user, even if it is accessed from a view without the security_invoker
  property."
- https://www.postgresql.org/docs/current/sql-creatematerializedview.html: "The query is executed
  and used to populate the view at the time the command is issued ... and may be refreshed later".
- https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY
  (RLS007): "For security, search_path should be set to exclude any schemas writable by untrusted
  users." "write pg_temp as the last entry in search_path."
- https://www.postgresql.org/docs/current/sql-grant.html (RLS006): "The key word PUBLIC indicates
  that the privileges are to be granted to all roles, including those that might be created later."
- https://supabase.com/docs/guides/database/postgres/row-level-security (RLS005, RLS008):
  "raw_user_meta_data - can be updated by the authenticated user using the supabase.auth.update()
  function. It is not a good place to store authorization data. raw_app_meta_data - cannot be
  updated by the user, so it's a good place to store authorization data." "Views bypass RLS by
  default because they are usually created with the postgres user." "Set search_path = '' on every
  security definer function". "A secret key authorizes access through the service_role Postgres
  role, which has the bypassrls attribute."
- https://supabase.com/docs/guides/api/securing-your-api (RLS001, RLS006 in `supabase` mode):
  "tables created in public receive SELECT, INSERT, UPDATE, and DELETE privileges for anon,
  authenticated, and service_role by default", and the platform "is changing the platform default
  to revoke these automatic grants so that exposure becomes opt-in."

### Measured in PGlite 0.5.8 (PostgreSQL 18.3)

- `pg_get_expr` prints `true` for `(true)`, `((TRUE))`, `'t'::boolean`, `true::bool` and
  `cast('yes' as boolean)`. `(1 = 1)`, `(NOT false)` and `(true IS TRUE)` keep their shape.
- A boolean AND / OR is always parenthesised as a whole, operands are parenthesised unless they are
  a bare column, constant or call; BETWEEN prints as two comparisons; CASE prints over several
  lines; strings print as `'...'` with `''`. Example:
  `(((tenant_id >= 1) AND (tenant_id <= 5)) AND (status = 'a and b'::text) AND is_public)`.
- JWT reads print as `(auth.jwt() -> 'user_metadata'::text)`, `#>> '{user_metadata,role}'::text[]`
  and `'$."user_metadata"."admin"'::jsonpath`.
- A check-only policy `FOR UPDATE WITH CHECK (true)` reaches no row by itself (`affected=0`), but
  next to `FOR UPDATE USING (owner = current_user)` it lets `update t set owner = 'bob'` through
  (`affected=1`); without it the same statement fails with 42501. The WITH CHECK expressions of
  permissive policies are OR-ed independently of their USING.
- A restrictive `FOR ALL USING (tenant = 1) WITH CHECK (true)` lets `update t set tenant = 2`
  through; the same policy without WITH CHECK blocks it with 42501.
- A view owned by the superuser returns every row of an RLS table to a role that sees one row
  directly; with `security_invoker = true` it returns that one row, also when reached through a
  second view without the option. A materialized view returns every row; `security_invoker` is
  refused for it (22023 unrecognized parameter) and RLS cannot be enabled on it (42809).
- Under the `explicit` grant regime the platform's revoke leaves `TRUNCATE, REFERENCES, TRIGGER,
MAINTAIN` with `anon`, `authenticated` and `service_role` on every new table. Under `legacy`
  they hold everything. Both come from the tool's own default privileges, with the same grantor as
  a GRANT in the user's SQL.

## Decisions

1. **Shape.** `Finding { id, severity, object { kind, schema, name, table?, identityArguments?,
qualifiedName }, title, explanation, docsUrl, evidence: { label, value }[] }`. Severity, title
   and the default `docsUrl` come from the rule registry `STATIC_CHECK_RULES`, which the docs page
   can render. Order: severity (critical, high, medium, info), rule id, object (schema, table,
   kind, name, arguments) in code-unit order. One finding per rule and object.
2. **Context.** `StaticCheckContext = { mode, personas: { dbRole }[], options? }`; a `Scenario`
   fits. Application roles are the personas' roles plus `anon` and `authenticated` in `supabase`
   mode, minus every role that bypasses RLS anyway (`service_role` by name, superuser, BYPASSRLS).
3. **RLS003** flags only permissive policies. A restrictive `true` grants nothing. A policy whose
   roles all bypass RLS is not flagged (`service_role`, as the brief says, and any BYPASSRLS role).
   Only the constant counts; tautologies are not evaluated.
4. **RLS004** is decided in exactly these cases, all sound in three-valued logic: WITH CHECK is the
   constant true and USING is not; WITH CHECK is the constant true and there is no USING
   (permissive only, see the measurement above); WITH CHECK keeps a subset of the AND-ed
   conditions of USING; WITH CHECK is such a subset, or every alternative of an OR-ed USING, plus
   further OR alternatives. Conditions are compared as text, which works because Postgres printed
   both. Restrictive policies are included. Not decided: any two different conditions
   (`tenant_id = 1` against `tenant_id > 0`), implications through functions, casts or subqueries,
   policies that only loosen each other in combination (other than the check-only case). A missing
   WITH CHECK is never flagged. `WITH CHECK (true)` also raises RLS003 by the brief's wording; both
   are reported because they say different things (every new row is admitted / rows can leave the
   scope).
5. **RLS005** matches the key inside string literals (`user_metadata`, also in `{...}` paths and
   jsonpath) and the column `raw_user_meta_data`. A column of the user's own table called
   `user_metadata` is not matched. A helper function that reads `user_metadata` in its body is not
   seen: the catalog model has no function bodies.
6. **RLS006 and the tool's own grants.** PUBLIC is always reported; the tool never grants to
   PUBLIC. For `anon`: in `postgres` mode all four privileges; in `supabase` mode with `explicit`
   grants INSERT, UPDATE and DELETE (these can only come from the user's SQL) but not TRUNCATE,
   which the platform default leaves behind; with `legacy` grants nothing, because the blanket grant
   is the platform's design, is applied by the tool and cannot be told from a user's GRANT in the
   catalog. In that regime RLS001 lists what `anon` and `authenticated` hold on a table without
   RLS, and the matrix proves what they reach. One finding per table.
7. **RLS007** flags every SECURITY DEFINER routine whose `proconfig` has no `search_path`. The
   shim's `auth.uid/role/email/jwt` are skipped in `supabase` mode. A pinned path that contains a
   writable schema or lacks a trailing `pg_temp` is not judged.
8. **RLS008** looks at direct table references with RLS enabled. A reference to a security invoker
   view is safe per the documentation; a reference to another non-invoker view is reported on that
   view. Materialized views are included with their own remedy. "Reachable by API roles": the
   catalog model lists privileges of tables only, so a view in an exposed schema is **assumed**
   reachable and the evidence says so. If `tablePrivileges` carries rows for the view, they decide
   (SELECT, INSERT, UPDATE or DELETE for PUBLIC or an application role). Under `explicit` grants
   this can report a view that no API role was granted.
9. **RLS009** requires RLS enabled and FORCE not set (without RLS, RLS001 is the finding), and
   counts membership: an application role with INHERIT that is a member of the owner has the
   owner's rights. The catalog has the role-level `rolinherit`, not the per-membership option of
   PostgreSQL 16 and later.

## Consequences

- Tables outside the exposed schemas are not in the catalog, so a view in `public` over a protected
  table in a private schema is not reported by RLS008.
- The checks are text-based on deparsed expressions. They never report something they cannot show
  in the evidence, and they miss what needs evaluation. The matrix remains the proof.
- Adding view privileges to the introspection (either `relkind in ('v','m')` rows in
  `tablePrivileges` or a separate list) removes the assumption in RLS008 without a change here.
- Tests: `src/lib/checks/*.test.ts` on hand-built catalogs, and
  `tests/checks/static-checks.integration.test.ts` with a positive and a negative SQL fixture per
  rule, loaded through `setupDatabase` and `introspect` into a fresh PGlite.
