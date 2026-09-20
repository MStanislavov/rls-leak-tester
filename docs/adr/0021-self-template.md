# ADR draft: the fourth template and the self-isolation proof

- Status: proposed
- Date: 2026-09-20
- Phase: 7 (task T4)

## Context

Brief 3.9 asks for a fourth template that is the app's own `scenarios` table and policies from
3.10 ("RLS Leak Tester verifies itself"), brief 5.3 for a CI job that loads `supabase/migrations`
into a Postgres service and runs the exported test for that template, and the gate of phase 7 for
the exported test to pass against the migrations in PGlite. ADR 0014 fixed the template
conventions (one bug, one changed expression, every cell explicit, exactly one failure kind per
failing cell, probe-friendly schemas) for schemas that were written for the purpose. This schema
was not: it is whatever `supabase/migrations` says, and it must stay that way.

## Decisions

1. **The migration is the single source of truth.** `src/lib/scenario` is pure and cannot read
   files, so the SQL lives as a string in the generated module
   `src/lib/scenario/templates/own-scenarios-migrations.ts`, written by
   `node scripts/self-isolation/sync-template.mjs` (`--check` exits 1 when it is out of date).
   Several migration files are joined in file name order with a newline. Drift guard:
   `tests/templates/own-scenarios-table.test.ts` compares the constant, the fixed variant's
   `schemaSql` and the module's text with the files on disk, byte for byte.
2. **The fixed variant is the reality, the leaky variant is derived from it.**
   `leakySchemaSql()` replaces the one expression `using (visibility = 'public');` of the policy
   `scenarios_public_read` by `using (visibility in ('public', 'unlisted'));` (with a `-- BUG:`
   comment). It throws unless the expression occurs exactly once, so a rewritten migration cannot
   silently turn the leaky variant into a copy of the fixed one. This is the mistake brief 3.10
   warns about: "whoever has the link may read it" written into a policy, which cannot ask for the
   slug, so every unlisted row can be listed. Declared failures: `anon`, `alice`, `bob`, `carol`
   `public.scenarios select: leak`. Writes stay correct (UPDATE and DELETE also need the owner
   policy, INSERT its WITH CHECK), so every failing cell has one cause. No static check sees it
   (`expectedStaticChecks` is empty, as for template 2); only the matrix does.
   The alternative "WITH CHECK missing on the owner policy" was not used: Postgres then applies
   USING to the new row, so nothing leaks.
3. **Explicit grants regime.** The migration revokes and grants by itself, so both variants run
   with `supabaseGrants: 'explicit'`. `TemplateParts` got the optional field `supabaseGrants`
   (default `legacy`), so the three demos and their snapshots are unchanged.
4. **`service_role` expects `none` everywhere.** The migration grants it nothing (the app never
   uses the service key). Its cells pass through `permission denied for table scenarios`; the
   persona still carries `rlsBypass: 'bypassrls'`, as the golden suite demands of the one
   service persona. Measured: EXECUTE on `get_scenario_by_slug` is refused for it as well.
5. **Personas and seed.** `anon`, Alice and Bob (each owns one public, one unlisted and one
   private scenario), Carol (signed in, owns nothing), `service`. Read expectations are `custom`:
   anon reaches `visibility = 'public'`, a user `visibility = 'public' or owner = :sub::uuid`;
   writes are `own`. `created_at` / `updated_at` are fixed literals.
6. **The seed carries a probe harness (the one deviation from "the schema is only the
   migrations").** `scenarios.slug` is unique. The runner proves INSERT by cloning a seeded row
   under a fresh key (ADR 0012; ADR 0014 decision 7 forbade a second unique constraint for this
   reason), so an ALLOWED insert collides with its source: 23505, inconclusive. Measured without
   the harness: `alice|public.scenarios|insert` is `inconclusive` (`scenarios_slug_key`), the
   blocked half still passes because RLS refuses a foreign row before the index is consulted, and
   the default export (`inconclusive: 'fail'`) would turn the CI job red. The seed therefore ends
   with a `BEFORE INSERT` trigger `scenarios_probe_slug` that gives every row inserted after the
   seed the slug `probe-<id without hyphens>` (38 characters, inside the slug format). It is
   SECURITY INVOKER with an empty `search_path`, EXECUTE revoked, touches no column a policy reads
   (a test pins that), and a BEFORE ROW trigger runs before WITH CHECK, so the policies judge the
   owner and visibility the persona sent. It lives in the SEED, never in the migrations, and the
   CI job loads it with the seed. `tests/self-isolation` pins the inconclusive result without it,
   so the day the runner learns to vary unique columns the harness can go.
   Alternatives rejected: changing the migration (a deferrable unique constraint changes the
   product for the sake of its test), teaching the runner about unique columns (another slice's
   behaviour and every snapshot), `inconclusive: 'warn'` plus a relaxed golden assertion (the
   proof would no longer show that an owner can insert at all).
7. **Golden coverage by extension.** `TEMPLATES` has a fourth entry; `templates.golden`,
   `replay.golden` and the export suites iterate it and needed no change. Four new snapshots
   (`own-scenarios-table-{leaky,fixed}.{result,findings}.json`); the six existing pairs are
   byte-identical (shasum before and after). Test edits, none of them a weaker assertion:
   - `tests/templates/templates.test.ts`: the pinned id list has four entries; the grants regime
     is pinned per template instead of "legacy for all"; the static-check list gained `[]`.
   - `tests/templates/templates-sql.integration.test.ts`: the setup summary expects the
     scenario's regime; "no SECURITY DEFINER function" became "none in the demos, exactly
     `public.get_scenario_by_slug` in the own template"; a hand-written leak demonstration for the
     new template.
   - `tests/golden/unchanged.golden.test.ts`: "the service role's DELETE reached rows" was the
     evidence that the run really wrote. It now reads: every DELETE cell that expects rows reached
     some (in the own template the owners'), the service cells have scope `all` in the demos and
     `none` in the own template, and service cells with scope `all` still must reach rows.
   - `tests/export/helpers.ts` (`dumpEverything`, another slice's helper, minimal edit): the dump
     is taken in UTC and the session's zone restored. The exported test file pins UTC for its
     session, psql's session ends with the file, PGlite's does not, so the first template with a
     `timestamptz` column rendered the same instants differently before and after.
8. **The self-isolation proof.** `scripts/self-isolation/self-proof.ts` (`buildSelfProof`) runs the
   fixed variant through `runMatrix` and `generateCiExport` and returns three files: the setup
   file (shim plus explicit-grants defaults), the seed, the test. The schema file is left out on
   purpose: the job loads `supabase/migrations/*.sql` itself. It refuses to build when the
   template is not the migrations on disk, when the PGlite verdict is not ISOLATED with every cell
   `pass`, or when the export does not check every cell.
   `npx tsx scripts/self-isolation/generate.ts <dir>` writes the files.
   `sh scripts/self-isolation/verify-postgres.sh` is the CI job in a shell script: generate,
   `docker run postgres:18-alpine`, then `psql --no-psqlrc -v ON_ERROR_STOP=1` with `PGTZ=UTC`
   through `docker exec` for the setup file, every migration in name order, the seed, the test.
   The CI job of phase 8 needs exactly these steps (a Postgres service instead of `docker run`).
9. **`tests/self-isolation/self-isolation.test.ts`** executes the proof in a PGlite prepared like
   the job, with the migration files READ FROM DISK: green and unchanged; the same test file
   against the leaky migration fails on exactly the four declared cells and names both unlisted
   rows as anon's leaked keys; the leaky variant's own export fails on the same cells.
   `get_scenario_by_slug`: anon gets an unlisted row by its exact slug; anon lists only the two
   public rows, a filter on slug or visibility returns nothing, the row count is 2, and `%`, a
   prefix, another case, the empty string and NULL open nothing; a private row opens for its
   owner only; a signed-in stranger is treated like anon; `service_role` may not call it.

## Evidence (2026-09-20, Node v26, PGlite 0.5.8, Docker 29.5.2)

- PGlite: fixed `ISOLATED`, 20 of 20 cells `pass`, no static finding; leaky `LEAKING`, 4 leaks,
  16 pass, no static finding. Sub-probes skipped for structural reasons only (scope `none`,
  Carol owns nothing).
- Real Postgres (`sh scripts/self-isolation/verify-postgres.sh`, PostgreSQL 18.4):
  `RLS Leak Tester: ISOLATED. 20 of 20 checked cells passed, 0 warnings.`, psql exit status 0.
- Negative control on the same image (setup, LEAKY schema, seed, the FIXED proof's test file):
  `LEAKING or not proven. 4 of 20 checked cells failed, 16 passed`, psql exit status 3, the four
  declared select cells, leaked keys `...a2` and `...b2` (the unlisted rows).
- `sh scripts/verify-export-postgres.sh` covers both new variants too: as expected, the same
  failing cells as the matrix runner's.

## Consequences and known limits

- A new migration file is picked up by the sync script and the drift test; if it changes the
  public read policy's USING, `leakySchemaSql` throws at import and names the expression.
- The proof covers table reach. The function path (`get_scenario_by_slug`) is outside the matrix
  model (the matrix probes tables) and is covered by the Vitest suite on PGlite only, not by the
  exported SQL file that the CI job runs.
- The probe harness means the INSERT evidence is "an owner may insert a row like their own, with
  another slug". Slug uniqueness itself is a constraint, not an isolation property, and is not
  part of the proof.
- The CI job needs Node (to generate the proof with `npx tsx`) before the psql steps.
