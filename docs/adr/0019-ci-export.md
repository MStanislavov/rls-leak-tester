# ADR: the CI export

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-20
- Phase: 4 (export)
- Builds on: ADR 0002 (grants before the schema), 0011 (setup), 0012 and 0016 (runner, the list of
  builders the export must share)

## Context

Brief 3.8 asks for two files: `rls-isolation.test.sql` (plain SQL, one `DO` block per cell, same
probes as the runner, exception on mismatch, rolled back, "starts with the shim") and
`rls-isolation.yml` (Postgres service, loads schema and seed, runs the test file with `psql` and
`ON_ERROR_STOP`). Everything below was executed: in PGlite 0.5.8 (PostgreSQL 18.3) by the test
suite and against `postgres:18-alpine` (PostgreSQL 18.4) in Docker by
`scripts/verify-export-postgres.sh`.

## Public API

`src/lib/export` (pure, ARCH-001):

```ts
generateCiExport({ scenario, run, supabase, toolName?, inconclusive? }): CiExport
// run:      Pick<MatrixRun, "result" | "cellContexts">, the completed run of THIS scenario
// supabase: SUPABASE_SETUP_SQL from @/lib/engine/supabase-setup-sql (SEC-004: the export may
//           not import it; a "use client" module passes it in, as it does for runMatrix)
// returns   { files: { name, path, mediaType, content }[], checkedCells, skippedCells, warnings }
//           warnings: why the files, as they are, would not do their job in CI (decision 6)
// throws    CiExportError when run.result.scenarioId / mode is not the scenario's
```

## Decisions

### 1. The input is the scenario plus the run, and the run now carries its plan contexts

A pure function cannot know the catalog, the ground truth, which rows Postgres counts as the
persona's own, the column privileges, or what an `expectedRowsSql` returned. The runner knows all
of it at the moment it plans a cell. `runMatrix` now returns `MatrixRun.cellContexts`: for every
PROBED cell the very object the cell functions were given (`CellPlanContext` = the old
`CellContext` minus engine and executor). The export plans from those, so it needs no second
database and cannot derive a different column, source row or foreign value. A cell without a
context (skipped, or `expectedRowsSql` failed) becomes a comment with the run's reason.
`MatrixRun` is not the result JSON: the golden snapshots are byte-identical (verified).

Other additive changes in `src/lib/runner`, each used by the runner itself and by the export, so
there is one implementation: `updateReachColumn`, `planBlindUpdate`, `planEscapes`,
`insertProbeOf`, `rowsCarrying` (extracted from `cells.ts`), `supabasePrelude` /
`supabaseGrantsOf` (extracted from `setupDatabase`), and the exported constants `RESET_SESSION`,
`PIN_TIME_ZONE`, `NOT_ABOUT_THE_ROWS`, `ROW_SECURITY_VIOLATION`, `STATEMENT_DENIAL`,
`NO_WRITABLE_COLUMN_REMARK`, `NO_ROW_TO_CLONE_REMARK`.

Expected keys are literal in the file (also for scope `custom`). The file therefore starts with a
preflight that compares every table's keys with the exported ones and fails with "export the
check again" when the seed changed, instead of reporting nonsense leaks (decision 6 says how).

### 2. Five files, not two; the shim is a file of its own (deviation from the brief)

The brief's order (load schema and seed, then a test file that starts with the shim) cannot work:
a Supabase schema needs the roles and `auth.uid()` to load at all, and the default grants must
precede the schema (ADR 0002). So:

| File                       | Content                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `rls-isolation.setup.sql`  | supabase mode only: exactly the scripts of `supabasePrelude` (shim, then grants) |
| `rls-isolation.schema.sql` | the scenario's schema SQL, unchanged, under a comment                            |
| `rls-isolation.seed.sql`   | the scenario's seed SQL, unchanged, under a comment                              |
| `rls-isolation.test.sql`   | the proof                                                                        |
| `rls-isolation.yml`        | the workflow                                                                     |

Schema and seed are emitted so that the files work when dropped into a repository
(`.github/workflows/rls-isolation.yml`, the SQL in `rls-isolation/`). In the workflow their paths
are environment variables marked `PLACEHOLDER`: a real project points `RLS_SCHEMA_SQL` at its own
migrations. User SQL is never inlined into the YAML: a `run:` block goes through the Actions
expression engine. Each file carries `path` (where the workflow expects it) and `mediaType`.

### 3. One `DO` block per cell that calls a small PL/pgSQL runtime (the "or equivalent")

The runner's cell logic is adaptive (row by row after a row-caused error, takeover, blind shapes,
the row count behind an unreadable key, which row an escape moves). A transcript replay would
freeze the path taken at export time and could not re-measure after the schema changed, which is
the whole point of a CI check. So the file defines about twenty functions in `pg_temp`
(`src/lib/export/runtime.ts`) that mirror `executor.ts`, `cells.ts` and `classify.ts`, and every
cell is a `DO` block that hands them role, identity statements, expected keys and the probe
statements. Every probe statement comes from the shared builders: `inlined` when its values are
known, `sql` with its `$n::text` parameters for per-row statements, which run through
`EXECUTE ... USING` with the key from the loop, exactly as the runner binds them.

- A probe transaction is a block that always ends in `RAISE ... 'RLT00'`, caught by itself: a
  subtransaction that is always rolled back, role and claims included, while PL/pgSQL variables
  keep what was measured. The database is unchanged after every cell, pass or fail, in psql, in
  PGlite and inside someone's open transaction. Measured: 20,000 such blocks do not wear a PGlite
  session (its error budget is about uncaught errors).
- Superuser steps re-raise as `RLT01`, the identity check (`current_user`, `row_security`) as
  `RLT02`: never 42501, so never "blocked".
- No runtime function is ever CALLED as the persona (the role is reset right after the persona's
  statement), so a schema that revoked EXECUTE from PUBLIC does not break the file.
- The classifier's three message patterns are exported from `classify.ts` and embedded (`\b`
  becomes `\y`); `tests/export/runtime.integration.test.ts` compares SQL and TypeScript on a table
  of messages.

### 4. All failures in one run (deviation from the letter of the brief)

A block that raised would stop psql at the first failing cell. Instead a failing cell raises a
WARNING at once and is recorded in the custom setting `rls_leak_tester.report`; the LAST
statement raises one exception that lists every failed cell (`[status] cell id (persona as role:
OPERATION on table, scope): leaked keys ...; missing keys ...; details`). psql exits with 3. A
setting rather than a temporary table, so that nothing outlives a failed run; the runtime
functions are dropped before the verdict.

What fails: `leak`, `escape`, `overblock` (brief: "any mismatch") and, by default, `inconclusive`
(a proof that could not measure a cell is not a proof). `inconclusive: "warn"` lists such cells
without failing, which is how the lab treats them. With no passing cell at all the verdict is
`NOT PROVEN` and the file fails.

### 5. The workflow

`postgres:18-alpine` (PGlite is PostgreSQL 18; an official 18 image exists), `ubuntu-24.04`,
`actions/checkout` pinned to the commit of v6.1.0 (read with `git ls-remote` on 2026-09-20),
`permissions: contents: read`, `persist-credentials: false`, no secret (the password is the
throwaway service container's), container health check plus a bounded `pg_isready` loop, `PGTZ=UTC`
(the runner pins UTC before schema and seed). Two `psql --no-psqlrc -v ON_ERROR_STOP=1` steps:
ONE invocation with `--file` for the setup file, the schema and the seed, then one for the test
file. Not verified: a run on GitHub's runners (no account here); the steps were reproduced with
Docker locally.

One session for setup, schema and seed is not a style choice. `setupDatabase` loads them over
one connection ("settings stay in force from the schema script into the seed script"), so a
schema that ends with `set search_path = app, public` has a seed that says `insert into notes`.
One `psql` per file (the first version of this workflow) gave every file a new session: ISOLATED
in the lab, `relation "notes" does not exist` in the step "Load the seed". `psql` runs several
`--file` options in order over one connection, and with `ON_ERROR_STOP` it ends at the first
error of any of them with exit status 3 without reaching the next file;
`scripts/verify-export-postgres.sh` checks exactly that before anything else. The test file keeps
a session of its own: it starts with the runner's `RESET_SESSION`, as the probes do.

### 6. The preflight decides what a green run may be believed about (review fixes)

A CI check is exported once and then runs against databases that are NOT the exported one: that
is its purpose. Three ways in which the first version said something false there, each found by
running a good export against a regressed or reloaded database, in PGlite and on
`postgres:18-alpine`:

- **A table added to an exposed schema later** (the brief's canonical failure: a table left
  without RLS). The file had no cell for it and printed ISOLATED while the runner said LEAKING.
  Now `check_tables` lists the ordinary and partitioned tables of `exposedSchemasOf(scenario)`
  exactly as the runner's introspection does and records a `[setup]` line for every table that
  is not in `MatrixResult.tables` of the exported run: `the table public.invoices is not covered
by this file ... export the check again`. It cannot judge the table (no expectations, no ground
  truth), so it refuses to be green. The file header and the lab's dialog say so as well.
- **An UPDATE grant without SELECT added later.** Only the blind UPDATE sees such a grant, and
  its constants were the columns the role held UPDATE on in the exported run: none, so the shape
  was skipped and the file stayed green. The export now plans the blind UPDATE with
  `planBlindUpdate(context, true)`: granted columns first, then the writable columns the role
  does not hold, same preference, same cap (`BLIND_UPDATE_CANDIDATES`). The runtime treats "no
  UPDATE privilege on this column" (a statement denial on a CONSTANT) as nothing: neither
  refused nor failed, on to the next candidate. That keeps the runner's result on the exported
  database (fixture `export-column-grants`: a 23505 on the one granted column stays inconclusive
  beside two denied constants; with the denial counted as "refused" the cell would pass, which
  the agreement test catches) and measures as soon as a migration grants the column. The runner
  itself is unchanged: `alsoUngranted` defaults to `false`, the golden snapshots are
  byte-identical.
- **Keys that no second load reproduces** (`id uuid primary key default gen_random_uuid()` and a
  seed without ids, the usual Supabase seed). The seed check failed, but the cells ran anyway and
  printed leaks that do not exist, and exporting again never helps. Now a table whose seed check
  fails is `stale`: every cell block first asks `ready(table, cell)` and ends without probing;
  the `[setup]` line says how many cells were not run. Preflight lines are counted apart from
  failed cells (`Setup problems: n; cells not run because of them: m`); any of them fails the
  run. The cause is named before the download and in the failure: `volatile-keys.ts` flags a
  probed table when a key column has a default that is not `nextval(...)` AND a key value of the
  ground truth is nowhere in the scenario's SQL (case-insensitive). That is evidence, not proof
  (a seed may compute explicit keys), so the sentences say "most likely". A pure function cannot
  load the seed twice; all four templates declare `default gen_random_uuid()` and seed explicit
  ids, and none of them is flagged. `CiExport.warnings` carries the sentence; the lab's dialog
  shows it as an alert and replaces the outcome sentence (minimal edits in
  `src/lib/lab/export-ci.ts` and `src/components/lab/export/export-ci-check.tsx`).

## PGlite against real Postgres

`scripts/verify-export-postgres.sh` runs 22 folders against PostgreSQL 18.4
(`postgres:18-alpine`): 8 template variants, 8 fixtures (session state, column grants and
volatile keys among them) and 6 `cross-*` folders, the CI use case itself: the test file of a
good scenario beside the schema and seed of its regressed twin (the four templates fixed against
leaky, the write-only grant, the added table). The exit status and the exact set of failing
cells equal the matrix runner's on PGlite, 64 failing cells of one fixture included; where the
preflight must speak, the expected line is the `[setup]` line. The same 22 folders behave the
same on 17.11 (`POSTGRES_IMAGE=postgres:17-alpine`). Differences that matter:

- **`lc_messages`.** A 42501 is classified by its English text. PGlite has only `C`; a real server
  may not. The file sets `lc_messages = 'C'` itself (needs a superuser, as the whole file does).
- **Roles are cluster-wide** in real Postgres and per instance in PGlite. One CI job has one
  database, so the setup file creates them unconditionally, like the shim in the lab; the
  verification script drops them between scenarios. Loading the setup file twice fails on
  `create role`, deliberately: it is the runner's shim, not an idempotent variant of it.
- **Sessions.** Each `psql` invocation is a new session; PGlite has one. Setup, schema and seed
  share one (decision 5); the test file starts with the runner's `RESET_SESSION`, so both start
  equal. The tests emulate the workflow's two sessions with `DISCARD ALL` before the first file
  and before the test file, and nothing in between.
- **Default privileges** apply to objects the granting role creates later: setup, schema and seed
  must be loaded by the same superuser, which the workflow does.
- PGlite's `exec` runs the whole file as one implicit transaction, psql statement by statement.
  The report setting is visible to later statements either way.

## Known limits

- The file knows the tables, personas, roles, expectations and seed rows of the exported run.
  New tables and changed rows fail the preflight (decision 6); a new persona or role is simply
  not there. A table that was EMPTY or had no primary key at export time has only comments, and
  rows added to it later are not noticed.
- The volatile-key warning is a heuristic (decision 6). Without it the failure still says both
  possible causes.
- The file must run as a superuser (role switches to arbitrary roles, `lc_messages`).
- A per-row statement binds at most "key columns + 2" parameters; the runtime is generated for
  the largest need of the file.
- The runner's known limit holds here too: an identity ALWAYS key advances its sequence during a
  rolled-back insert probe.
- A cell id with spaces (a quoted table name) is printed as it is; the message stays readable but
  is not machine-splittable on spaces.

## Verification

`npx vitest run src/lib/export src/lib/runner tests/export tests/self-isolation tests/golden
tests/runner src/lib/lab/export-ci.test.ts`: 33 files, 534 tests (every template fixed green and
leaky red with exactly the declared cells, database dumps equal before and after, byte-identical
output, cell-by-cell agreement with the runner on nine fixtures, hostile names and labels, YAML
parsed and checked with zod, and `tests/export/regressions.integration.test.ts`: a good export
against a regressed database for the four templates, the write-only grant and the added table,
plus volatile keys and session state); the golden snapshots are unchanged; coverage of
`src/lib/export` 100 percent lines and branches. `sh scripts/verify-export-postgres.sh` green on
`postgres:18-alpine` (18.4) and `postgres:17-alpine` (17.11), 22 folders each;
`sh scripts/self-isolation/verify-postgres.sh` green on 18.4. `e2e/lab-export.spec.ts` (5 tests,
one of them the warning in the dialog with an axe scan) green in dev mode.
