# ADR draft: the three built-in templates

- Status: proposed
- Date: 2026-09-19
- Phase: 3 (task B3)

## Context

Brief 3.9 asks for three scenarios, each in a leaky and a fixed variant, with explicit
expectations. They are the demo a first-time user runs and the golden fixtures of the runner, the
static checks and the export. The brief names the leaks but leaves the schemas, the personas, the
exact failing cells and the shape of the metadata open. The runner was written in parallel, so the
templates had to be proven without it.

## Decisions

1. **Shape.** `src/lib/scenario/templates/` exports `TEMPLATES` (stable order: multi-tenant-saas,
   team-workspace, todos-sharing). A `Template` has `id`, `title`, `description` (one paragraph),
   `leak`, `fix`, and two `TemplateVariant`s, `leaky` and `fixed`. A variant carries the
   `Scenario` (id `<template>-leaky` / `<template>-fixed`), `expectedVerdict`,
   `expectedFailures` (`{ personaId, schema, table, operation, status: 'leak' | 'escape' }`, in
   matrix order) and `expectedStaticChecks` (`{ id, schema, table, policy? }`). The fixed variant
   declares none of either. The scenario index does not re-export the templates; import
   `@/lib/scenario/templates`.
2. **One bug, one changed expression.** Leaky and fixed share seed, personas, table configs and
   expectations. They differ in one policy expression (a test pins that only `schemaSql`, `id`,
   `title` and `description` differ). The user sees one bug and one fix.
3. **Every cell is explicit.** `buildExpectations` throws when a table does not name every
   persona, so no template relies on the default scopes. A test checks that
   `resolveExpectations` reports every cell as `explicit` and in the same order.
4. **Exactly one failure kind per failing cell.** A table without RLS (or an `ALL` policy with
   `WITH CHECK (true)`) makes an UPDATE cell a reach leak and a scope escape at once; which status
   such a cell gets is the classifier's precedence, not a property of the schema. Golden fixtures
   should not depend on that, so each leak was chosen so that every failing cell has one cause.
   A test asserts that no cell of any variant is a leak and an escape at once.
   - Template 1 uses separate per-command policies. Only `projects_update` has
     `WITH CHECK (true)`, so only the UPDATE cells escape and the INSERT cells pass. (With an
     `ALL` policy the out-of-scope INSERT would go through as well.)
   - Template 2 breaks only the SELECT policy of `documents`. UPDATE and DELETE cells pass because
     a row must satisfy their own, correct policies too.
   - **Template 3 uses `USING (true)` on the public read policy, not a table without RLS.** The
     brief allows either. With RLS off and the legacy grants every cell of the table fails and the
     UPDATE cells of signed-in users are leak and escape at once (see above). `USING (true)` is
     also how the bug happens in practice: the Supabase docs' "viewable by everyone" policy copied
     for a table where only some rows are public. Consequence: no template triggers `RLS001`; the
     static checks need their own fixture for it.
5. **The uncorrelated subquery of template 2 is the unqualified-column bug**:
   `exists (select 1 from memberships where user_id = auth.uid() and team_id = team_id)`. Both
   names bind to `memberships.team_id`, the comparison is always true, no error is raised. No
   static check sees it (`expectedStaticChecks` is empty); only the matrix does. Dave, signed in
   but in no team, passes even in the leaky variant, and Bob is in two teams, which is what makes
   the `custom` scope necessary.
6. **No policy recursion, no SECURITY DEFINER.** `memberships_select` is
   `user_id = auth.uid()` and looks at no other table. The membership subqueries in the policies
   of `teams` and `documents` run under the caller's RLS and see exactly the caller's memberships,
   which is what they need. `RLS007` stays quiet because there is nothing for it to look at.
7. **Probe-friendly schemas.** Every table has the single key `id uuid default
gen_random_uuid()`. There are no unique constraints besides the key, because the insert probe
   clones a seeded row under a fresh key and a second unique constraint would turn an allowed
   insert into `23505`, inconclusive (`memberships` says so in a comment). Foreign keys to a
   probed parent are `on delete cascade`, so the DELETE reach of `service_role` on `tenants` and
   `teams` is not a `23503`. `tenants` and `teams` have no tenant column configured: their tenant
   would be their key, and the runner skips the insert probe when every key column defines the
   scope class. Their read expectation is `custom` instead (`tenants` uses `:claims`, `teams`
   uses `:sub`).
8. **`expectedRowsSql` style.** One query that returns the single column `id`; `:sub::uuid`
   with an explicit cast, which works whether `:sub` is bound as an untyped `$n` (the runner), as
   text, or inlined as a literal (the export); `:claims` is used as jsonb.
9. **Grants.** All variants run under `supabaseGrants: 'legacy'` with `exposedSchemas:
['public']`, set explicitly. RLS is the only barrier, as brief 3.5 step 4 wants.
10. **Tenant claim.** Template 1 reads `app_metadata.tenant_id` through
    `public.current_tenant_id()` (SECURITY INVOKER, `search_path = ''`, `nullif(..., '')` guard).
    Personas set `tenantClaimPath: 'app_metadata.tenant_id'`.

## Declared failures

| Template                | Cells (`persona table operation: status`)           | Static checks                          |
| ----------------------- | --------------------------------------------------- | -------------------------------------- |
| multi-tenant-saas-leaky | alice, bob, carol `public.projects update: escape`  | RLS003 and RLS004 on `projects_update` |
| team-workspace-leaky    | alice, bob, carol `public.documents select: leak`   | none                                   |
| todos-sharing-leaky     | anon, alice, bob, carol `public.todos select: leak` | RLS003 on `todos_select_public`        |
| every fixed variant     | none                                                | none                                   |

Template 1's escape shows only in the WHERE-less shape of the scope-escape probe: the targeted
`UPDATE ... WHERE id = x` is blocked with `42501` because the SELECT policy is applied to the new
row (ADR 0002). A test pins both facts. `RLS003` fires on template 1 as well, because
`WITH CHECK (true)` is literally `true` for `authenticated`.

## Evidence

`tests/templates/` (run with `npx vitest run tests/templates`):

- `templates.test.ts`: every scenario passes `parseScenario` unchanged and round-trips through
  `serializeScenario`; all cells explicit; metadata consistent; `buildExpectations` refuses gaps.
- `templates-sql.integration.test.ts`: each variant loads through `setupDatabase`; the catalog has
  exactly the configured tables, each with key `id`, RLS on and its owner / tenant columns; ground
  truth has no skipped table; every `expectedRowsSql` runs and returns existing keys; one
  hand-written role-switched statement per template shows the leak with exact rows and is blocked
  or filtered in the fixed variant.
- `templates-matrix.integration.test.ts`: a hand-written matrix (select, no-op update and delete
  reach, scope escape in both shapes, cloned-row inserts for every seeded row) fails on exactly
  the declared cells for the leaky variants, passes every cell of the fixed ones, finds no
  overblock anywhere and leaves the database unchanged.
- `templates-static-checks.integration.test.ts`: `runStaticChecks` yields exactly the declared
  findings.

## Consequences

- The fourth template of brief 3.9 (the app's own `scenarios` table from 3.10) is not part of
  this slice; it depends on `supabase/migrations`.
- A golden test of the real runner and of the export against `TEMPLATES` is owed by those slices;
  `expectedFailures` and `expectedVerdict` are the data to compare with.
