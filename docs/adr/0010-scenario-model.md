# Scenario model: decisions where the brief was silent or reality differed

Status: accepted (Phase 3, agent A1). Scope: `src/lib/scenario/**` without `templates/`.

## Context

Brief section 3.4 names the types and the defaults but leaves open: what a custom role in
`postgres` mode gets by default, how strict the schema is, which limits protect the browser, how
the SQL of a user is cut into statements for error display (3.3), and how versions are handled.
ADR 0002 added two facts the model has to carry: a non-uuid `sub` makes `auth.uid()` raise `22P02`,
and Supabase's default grants have a legacy and an explicit regime.

## Decisions

1. **`options` on the scenario** (not in the brief's field list): `exposedSchemas` (default
   `['public']`) and `supabaseGrants: 'legacy' | 'explicit'` (default `legacy`). `options` stays
   optional in the JSON so old documents round-trip unchanged; `resolveOptions()` fills defaults.
2. **Types and zod schemas cannot drift.** `types.ts` holds plain interfaces (no zod import, cheap
   to import anywhere); `schema.ts` asserts at compile time (`SCHEMAS_MATCH_TYPES`) that every
   `z.infer` is mutually assignable with its interface and has the same keys. Proven to have teeth
   with a throwaway file: a missing optional key and a wrong type both fail `tsc`.
3. **Strict everywhere except `claims`.** Scenario, persona, table config, expectation and options
   are `z.strictObject`: a shared scenario is attacker-controlled (SEC-002), and an unknown key is
   more likely a newer format or a typo than something to carry along silently. `claims` is an open
   JSON object, checked for plain-JSON values, depth (8) and size (4 000 characters as JSON).
4. **Limits** (exported from `limits.ts`): SQL 200 000 characters each for schema and seed, custom
   expectation SQL 10 000, 12 personas, 50 tables, 12 x 50 x 4 = 2 400 expectations, 8 exposed
   schemas, title 120, description 2 000, label 80, ids 64 of `[A-Za-z0-9_-]`, identifiers 63 UTF-8
   bytes (Postgres truncates longer names, so they would never match the catalog), whole document
   1 000 000 characters before `JSON.parse`. NUL characters are refused in SQL and identifiers.
5. **`supabase` mode personas**: `dbRole` must be `anon`, `authenticated` or `service_role`
   (custom roles need `postgres` mode, where the shim does not exist); a `sub`, when present, must
   be a hyphenated uuid of any version (seeds use `00000000-0000-0000-0000-000000000001`, which
   `z.uuid()` refuses, so the check is our own `isUuid`); an `authenticated` persona must have a
   `sub`. In `postgres` mode `sub` is free; `personaSub` reads strings and finite numbers as text.
6. **Default scope of a custom role** (`postgres` mode): the same rule as `authenticated` (own if
   owner column, else tenant if tenant column, else none). It stands for a signed-in application
   user, and it never defaults to `all`: a role meant to see everything needs explicit
   expectations. The rule goes by role NAME in both modes (`anon` none, `service_role` all). The
   brief's defaults do not differ by operation; `operation` is in the signature for later.
7. **`resolveExpectations` order**: tables by schema then name in code-unit order (independent of
   the order introspection reports), then personas in scenario order (the user's order), then
   select, insert, update, delete. Each cell is marked `source: 'explicit' | 'default'`.
   Expectations for tables that are not part of the run are not cells;
   `findOrphanExpectations` lists them so the UI can warn.
8. **`scenario.tables` is the user's override, whole.** `resolveTableConfigs` keeps a configured
   table exactly (that is how a user says "no owner column") and applies `suggestTableConfig` only
   to tables without a config. An expectation may name a table without a config: introspection may
   still find it.
9. **Version handling**: `parseScenario` looks at `version` first and answers with one clear issue
   for a missing, non-integer, newer or unmigratable version. `SCENARIO_MIGRATIONS` (keyed by the
   version a migration reads) is the hook; `migrateScenario(input, migrations, target)` takes both
   as parameters so the chain is tested today although only version 1 exists.
10. **Statement splitter follows psql, not only the lexer.** Besides comments (nested), strings
    (`''`, `E''` escapes, continuation of an `E` string on the next line), quoted identifiers and
    dollar quotes, it tracks parenthesis depth (`CREATE RULE ... DO (a; b)`) and the
    `BEGIN ATOMIC ... END` body of `CREATE [OR REPLACE] FUNCTION | PROCEDURE` with psql's heuristic
    (`begin` opens, `case` inside a body opens, `end` closes). Without it a SQL-standard function
    body is cut at its first semicolon. Unterminated constructs stay in the last statement so that
    Postgres reports the error. Leading and trailing comments are not part of a statement's text;
    `start`, `line` and `column` point at the first token. Not supported: psql meta-commands and
    `COPY ... FROM stdin` data blocks (PGlite cannot run those either).
11. **Quoting**: `quoteIdent` always quotes; `quoteLiteral` mirrors `quote_literal` including the
    `E'...'` form for backslashes, which is correct with `standard_conforming_strings` on and off.
    Both throw a `RangeError` for NUL, `quoteIdent` also for the empty name. Checked against
    PGlite: round trip of 17 hostile names and values, equality with `quote_literal` and with
    `quote_ident` wherever it quotes.
12. **Ids**: `createScenarioId(title, suffix)` is pure; `newScenarioId` adds a random suffix from
    `crypto.getRandomValues` (injectable, no `Math.random`). An id is an input of a run and appears
    in no computed result, so P6 (determinism) is untouched.
13. **Serialisation**: `stableStringify` sorts keys in code-unit order; `canonicalScenario` also
    sorts tables and expectations (their order means nothing) and keeps personas and exposed
    schemas (the user's order). `serializeScenario` is the text for save, share and export.

## Evidence

`npx vitest run src/lib/scenario`: 10 files, 301 tests, all green; coverage of the directory 100
percent statements, branches, functions and lines. `sql-postgres.test.ts` runs the splitter output
statement by statement in PGlite (trigger function with a `$fn$` body, `BEGIN ATOMIC` function, `DO`
block, rule with a parenthesised action list, `E''` and `U&''` strings) and compares the resulting
rows. `npx eslint --max-warnings 0 src/lib/scenario`, `npm run typecheck` and
`npm run rules:fast` on the files: clean.

## Consequences

- `src/lib/engine/supabase-shim.ts` has its own `quoteIdent` from Phase 1. It should import the one
  from `@/lib/scenario` so that there is a single quoting implementation.
- The runner must still refuse a persona whose role is a superuser or has `BYPASSRLS` in `postgres`
  mode (RUN-001); the model only validates names, it cannot see role attributes.
- A future format change adds `SCENARIO_MIGRATIONS[1]`, bumps `SCENARIO_VERSION` and changes
  nothing else in the load paths.
