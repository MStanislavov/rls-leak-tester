# ADR draft: golden tests and the reconciliation of runner, templates and static checks

- Status: proposed
- Date: 2026-09-19
- Phase: 3 (task C, integration of the core library)

## Context

The runner, the static checks and the templates were written in parallel by three agents, each
proven against its own fixtures. The templates declare, as data, what the runner and the checks
must report (`expectedVerdict`, `expectedFailures`, `expectedStaticChecks`). Brief 5.1 asks for
golden tests that hold the real runner to those declarations and lock the result JSON, and the
task rule was: when two parties disagree, reproduce the cell by hand in PGlite, fix the real
culprit, never the expectation or the snapshot.

## Decisions

1. **Three suites under `tests/golden/`.**
   - `templates.golden.test.ts`: every variant once through `runMatrix` and `runStaticChecks`
     on a real PGlite. It asserts the verdict, the exact set of failing cells
     (persona, table, operation, status) against the declaration, the exact static findings, that
     every other cell is `pass` (no overblock, inconclusive or skipped cell, no inconclusive
     sub-probe, in leaky variants too), that the matrix is complete and explicit
     (personas x tables x 4, no orphan expectation, no missing schema, no skipped table), that
     only the `service_role` persona carries an RLS bypass flag, and for fixed variants zero
     leak/escape and no high or critical finding. The full `MatrixResult` and the findings are
     file snapshots (`tests/golden/__snapshots__/<scenario>.result.json` / `.findings.json`), and
     a second, independent run must give byte-identical JSON strings.
   - `replay.golden.test.ts`: the by-hand reproduction, automated. Every declared failing cell is
     reproduced without the runner from the transcript it recorded (`cell.sql`, split into
     statements, run one by one in a fresh database, rolled back). The rows that come back must
     be the cell's `actualKeys` and `leakedKeys`; for an escape the recorded sub-probe must go
     through and touch exactly `movedKeys.length` rows; the `whoami` statement must show the
     persona's role, not the session superuser. The same cells of the fixed variant replay
     clean, and the escaping statement is refused with 42501. This proves policy, runner and
     transcript at once, and it is the first consumer of "the exact probe SQL" of brief 3.5.
   - `unchanged.golden.test.ts`: P5 on the templates. Rows, sequences, policies and roles dump
     identically before the first probe and after the last one, for all six variants.
     `dumpDatabase` moved from `tests/runner/run-matrix.integration.test.ts` to
     `tests/runner/helpers.ts` so both suites share it.
2. **The snapshot byte form** is `JSON.stringify(value, null, 2)` plus a final newline. Snapshots
   are data owned by Vitest (`.prettierignore` already lists `**/__snapshots__/`). They contain
   Postgres error messages, so a PGlite upgrade that rewords a message changes them: review the
   diff, then `npx vitest run tests/golden -u`. Never update them to make a behaviour change
   green without reading the diff (QUAL-002). The comparison was proven live: a tampered
   snapshot fails the suite (it is not rewritten).

## Disagreements and their resolution

| #   | Parties                                | What disagreed                                                                                                                                                                                                                                                             | Culprit                                                    | Resolution                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | runner vs template declarations        | Nothing. On the very first run, before any snapshot existed, all six variants gave the declared verdict and exactly the declared failing cells (3 escapes, 3 leaks, 4 leaks; 0 in the fixed variants), 304 cells in total, and the declared static findings.               | none                                                       | No expectation, policy or runner code was changed. The agreement is not circular: the templates were proven before the runner existed by a hand-written matrix (`tests/templates/templates-matrix.integration.test.ts`), and `replay.golden.test.ts` now reproduces each failing cell from its SQL alone.                                                                                        |
| 2   | static checks vs the database (RLS008) | Under Supabase `explicit` grants a view over an RLS table was reported as reachable although no API role holds any privilege on it. Reproduced in PGlite: `create view public.notes_view ...` with `supabaseGrants: "explicit"` gave RLS008 with evidence "assumed".       | the catalog (`src/lib/runner/introspect.ts`), not the rule | `TABLE_PRIVILEGES_SQL` listed only `relkind in ('r','p')`, so `reachability()` in `src/lib/checks/object-checks.ts` always fell back to "assumed". The query now includes `'v'` and `'m'`. Two integration fixtures were added first and seen failing (explicit grants: granted to `anon` gives the finding with `reachable by: anon`; not granted gives none), plus an introspection assertion. |
| 3   | my assumption vs PostgreSQL 18.3       | I expected `ALTER DEFAULT PRIVILEGES ... ON TABLES` to skip materialized views. Measured: under the legacy grants a table, a view and a materialized view all get `anon, authenticated, service_role`; under explicit grants only the owner holds privileges on all three. | the assumption                                             | The new introspection test asserts the measured behaviour.                                                                                                                                                                                                                                                                                                                                       |

## Smells in the fixed variants

Cells: none. All 152 cells of the three fixed variants are `pass`; no overblock, no inconclusive,
no skipped cell, no inconclusive sub-probe. The golden suite asserts this, so a new smell is a red
test, not a note.

Sub-probes with status `skipped` exist and are structural, not defects. They are all scope-escape
probes (both shapes) of UPDATE cells:

| Reason recorded by the runner                                                  | Where                                                                                                  | Why it is right                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No row is inside scope "none": there is nothing to move.`                     | `anon` everywhere; signed-in users on read-only tables (`invoices`, `tenants`, `memberships`, `teams`) | An escape moves a row the persona may legitimately update. With scope `none` any updatable row is already a `leak` of the UPDATE reach probe, which ran and passed. |
| `Every row is inside scope "all": there is nowhere to escape to.`              | the `service_role` persona                                                                             | No value of the scope column lies outside scope `all`. These cells also carry `rlsBypass: "bypassrls"`, so they prove nothing about policies and say so.            |
| `The persona can update no row inside its scope, so there is nothing to move.` | `dave` on `documents` (team-workspace)                                                                 | Dave belongs to no team, his custom scope is empty by design (the template needs a signed-in user for whom the uncorrelated subquery finds nothing).                |

Counts per fixed variant: multi-tenant-saas 12 of 15 UPDATE cells skip the escape, team-workspace
15 of 18, todos-sharing 2 of 5. The remaining 3 + 3 + 3 cells run both shapes and are blocked.

Insert classes that are absent (not skipped) because the seed has no such row: Carol has no
same-tenant colleague in multi-tenant-saas, Dave owns no document in team-workspace, so
"insert-own is allowed" is never probed for Dave. This follows brief 3.5 ("for each scope class
present in the ground truth") and is covered for Alice, Bob and Carol.

## Measurements (Node v26.8.1, macOS arm64, PGlite 0.5.8, 7 runs each)

Wall time of one full `runMatrix` including the creation of a fresh PGlite:

| Variant                 | Cells | Median ms | Min | Max (first run) | Setup median ms | Slowest cell ms |
| ----------------------- | ----- | --------- | --- | --------------- | --------------- | --------------- |
| multi-tenant-saas-leaky | 60    | 460       | 450 | 671             | 390             | 3.2             |
| multi-tenant-saas-fixed | 60    | 446       | 443 | 472             | 382             | 3.0             |
| team-workspace-leaky    | 72    | 471       | 456 | 481             | 389             | 3.5             |
| team-workspace-fixed    | 72    | 463       | 453 | 475             | 381             | 4.2             |
| todos-sharing-leaky     | 20    | 408       | 400 | 416             | 382             | 3.5             |
| todos-sharing-fixed     | 20    | 405       | 397 | 412             | 379             | 2.4             |

About 380 ms of every run is the fresh database plus shim, schema, seed, introspection and ground
truth; a cell costs about 1 ms. Both are far below `thresholds.runner.probe_timeout_ms` (5000) and
`run_ceiling_ms` (60000). The browser worker will be slower (WASM start); measure there in Phase 5.

## Consequences and known limits

- `Catalog.tablePrivileges` now also holds rows for views and materialized views. Consumers that
  iterate it per table (`table-checks.ts`) filter by table name and are unaffected; a relation
  name is unique per schema across tables and views.
- The "assumed" branch of RLS008 stays for hand-built catalogs without privilege rows (unit
  tests); the real introspection always lists at least the owner's implicit privileges.
- RLS008 reachability still looks at direct grants to `PUBLIC` and the application roles only,
  not at privileges inherited through role membership.
- Determinism is proven per process pair on one machine. The snapshots pin the SQL text, the key
  order and the Postgres messages; they do not pin timings, which live outside `MatrixResult`.
- The fourth template (the app's own `scenarios` table) arrives in Phase 7 and must be added to
  the golden suites by extending `TEMPLATES`; the suites iterate `templateVariants()` and
  `TEMPLATES`, so no test code changes, only new snapshots.

## Snapshot update after the review fixes (2026-09-20)

All six `*.result.json` snapshots were regenerated once, after the fixes of the draft ADR "wrong
verdicts found by three reviews". Before `-u` the old and the new results were compared cell by
cell with a script (status, reason, expected, actual, blind, leaked and missing keys, per-row
flag, error, and for every sub-probe kind, expectation, outcome, status, source key, moved keys,
reason and error): **no cell differs in any of them**, in any of the 304 cells. Verdicts, counts,
tables and personas are identical. The `*.findings.json` snapshots did not change. What changed is
recorded SQL text only, and each change exists because the behaviour before was wrong:

| What changed in the snapshots                                                                                                                                                                                                          | Cells                                              | Why the old text was wrong                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every transcript has one more statement after the claims (legacy `request.jwt.claim.*` emptied, `row_security = on`, `TimeZone = UTC`), and the whoami statement also returns `row_security`                                           | all cells that ran                                 | A pg_dump header (`SET row_security = off`) turned every leak into a 42501 that was read as blocked; a seed that signed in through `request.jwt.claim.sub` lent its user to every persona; timestamptz text followed the host's time zone |
| Insert sub-probes: `insert ... select <fresh key>, cols from pg_temp."rls_leak_tester_source"` after the superuser's `create temporary table ... as select` and `grant select`, instead of `insert ... values (<literals with casts>)` | every insert sub-probe                             | A cast to a type in a schema without USAGE raised a 42501 that was read as blocked; a `default now()` value made the result differ between two runs                                                                                       |
| UPDATE cells: a second transaction with the blind shape (source row, row versions before, `update t set col = (select col from source)` in a savepoint, row versions after), when the no-op did not already reach every row            | update cells of roles that hold UPDATE on a column | Without it a role with an UPDATE policy and no SELECT policy could overwrite every row and the cell passed                                                                                                                                |
| DELETE cells: the blind shape reads the keys as the superuser BEFORE the statement too, and is skipped when the RETURNING shape already reached every row                                                                              | delete cells                                       | `ground truth minus remaining` reported false leaks when the table no longer matched the ground truth                                                                                                                                     |

No template cell ever used the row-by-row fallback (0 occurrences before and after), so the change
that a missing privilege is no longer repeated per row does not show in the snapshots.

`tests/golden/replay.golden.test.ts`: the `WHOAMI` constant follows the new statement, and the
replay now also asserts `row_security = on`. Nothing else in the golden suites changed; in
particular the assertions "exactly the declared failing cells, every other cell `pass`" held
before and after without an edit.
