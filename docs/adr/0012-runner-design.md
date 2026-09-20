# ADR: design of the matrix runner

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-19
- Phase: 3 (core library), slice B1
- Builds on: ADR 0002 (RLS inside PGlite), the draft ADRs on the scenario model and on engine,
  setup and introspection
- Amended by: the draft ADR "wrong verdicts found by three reviews" (`0016-runner-review-fixes.md`).
  Decisions 1, 3, 4, 5, 6, 8 and 9 below carry a note where that ADR changed them.

## Context

Brief 3.5 describes the runner in one page. Building it against PGlite 0.5.8 (PostgreSQL 18.3)
forced a number of decisions the brief leaves open, and a few places where reality disagrees with
the brief. They are recorded here because the UI, the CI export and the golden tests build on
them. Everything below was run; the tests named at the end pin it.

## Shape

`src/lib/runner` stays pure (ARCH-001, SEC-004). `runMatrix(scenario, { createEngine, supabase })`
takes a **factory** for the database, not a database:

| Module             | Role                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probes.ts`        | Pure builders. A `Probe` is `{ sql, params, inlined }`: the parameterised statement the runner executes and the same statement with literals, for display and for the export |
| `named-params.ts`  | `:sub` / `:claims` to `$n`, lexer-aware                                                                                                                                      |
| `expected-rows.ts` | Wraps `expectedRowsSql` into the probe that reads the expected keys                                                                                                          |
| `plan.ts`          | Pure planning: expected keys per scope, update column, escape plan, insert classes, fresh keys                                                                               |
| `roles.ts`         | Pure catalog reading: the three RLS bypasses, applicable policies                                                                                                            |
| `executor.ts`      | The one place where a probe meets the database: role, claims, identity check, rollback                                                                                       |
| `cells.ts`         | One cell per operation; hands evidence to the classifier                                                                                                                     |
| `classify.ts`      | leaked / missing, SQLSTATE table, cell status, verdict                                                                                                                       |
| `run-matrix.ts`    | Build, loop, rebuild after a lost database, result                                                                                                                           |
| `error-budget.ts`  | Wraps the engine of a run: charges SQL errors, replaces a PGlite session before it wears out (added by the review-fixes ADR)                                                 |

## Decisions

### 1. Every probe is its own transaction, and the executor proves who it is

`begin; select set_config('role', $1, true); select set_config('request.jwt.claims', $1, true);
<pinned settings>; select current_user, row_security; <probe>; rollback` (the pinned settings and
the `row_security` check were added by the review-fixes ADR, decision 9). `SET LOCAL ROLE` takes no parameter (ADR 0002), so
`set_config('role', ...)` is used; a missing role raises `22023` instead of silently staying the
superuser. The `current_user` check is the bypass guard inside the executor: when the answer is
not the persona's role nothing is probed and the cell is `inconclusive`. A regression that loses
the role switch therefore yields NOT PROVEN, not a wrong verdict
(`tests/runner/runner.bypass-guard.test.ts` swaps in such an executor, with and without the check).

The recorded SQL of a cell is the **transcript** of what the session sent, literals inlined. It
cannot drift from what ran. `statement` holds the bare probe statement for the export.

Only the per-row fallback shares a transaction: each row runs inside a savepoint that is always
rolled back. Read-backs run after `reset role` inside the probe transaction (the session user is
the superuser); afterwards the session becomes the persona again and re-checks.

### 2. Bypassing personas are probed and flagged, not refused

A persona may legitimately be a bypassing role (`service_role`). The runner probes as that role,
reports what it really reaches, and sets `rlsBypass` on the cell (`superuser`, `bypassrls`,
`table-owner`, `rls-disabled`) and on the persona. Ownership follows role membership while every
hop inherits, as Postgres does; role attributes are not inherited. With expectation `all` such a
cell passes; with `own` it is a leak, which is the truth about that role.

### 3. DELETE reach has a second shape (addition to the brief)

`delete ... returning pk` needs SELECT rights, so Postgres applies the SELECT policies too. With
`for select using (own)` and `for delete using (true)` the RETURNING shape deletes the own rows
and a plain `delete from t` deletes **all** of them (measured: 1 row against 3). The runner runs
both; what only the WHERE-less statement reached is read back as the superuser and reported in
`blindKeys`, as part of `actualKeys`. UPDATE has no such NO-OP shape (`set col = col` reads the
column, so SELECT policies apply: measured). **Amended:** that left a role that can overwrite
every row unseen, so UPDATE now has a blind shape with a constant from a source row, and a
takeover step (review-fixes ADR, decision 1).

### 4. Scope escape moves the column that defines the scope (deviation from the brief)

**Amended:** scope `own` additionally moves the tenant column for a persona with a tenant claim
(review-fixes ADR, decision 7). The reasoning below still holds for a persona without one.

The brief says "the tenant (or owner) column". Moving the tenant column of a row under scope `own`
would report an escape although the row stays with its owner. So: `own` moves the owner column,
`tenant` the tenant column, `custom` the tenant column, else the owner column; `all` and `none`
have nothing to escape from and are skipped. The row is the first one that is expected AND
reachable; the foreign value is the first value, in code-unit order, that only rows outside the
expected keys carry. Both shapes of ADR 0002 claim 6 run; either success is an `escape`. A shape
that does not apply is `skipped` with its reason and never changes a passing cell.

### 5. Insert: classes, expectation, fresh keys (deviation from the brief)

Classes are `own`, `same-tenant`, `other`; for `custom` they are `in-scope` / `out-of-scope` of the
expected rows. One rule for every scope: the insert must be allowed exactly when the cloned row is
inside the persona's expected keys for the insert cell. Out of scope and allowed is an `escape`,
in scope and blocked an `overblock`. The insert has no RETURNING, which would put the new row
under the SELECT policies as well.

Fresh keys are deterministic, and an **explicit value is preferred over a default**, against the
brief's order: a sequence-backed default also needs USAGE on the sequence, so an insert could look
blocked although a client that names the key gets through; and `nextval` is not transactional, so
using the default would change the database (sequence position) after a rolled-back run. uuid: a
fixed literal no seeded row uses. smallint / integer / bigint: max + 1000, or max + 1 near the end
of the range. Identity ALWAYS and generated columns are left out. Another type with a default
takes the default. Otherwise the class is skipped. With a composite key exactly one column is
replaced, never the owner or tenant column; a key made only of those is skipped. **Known limit:**
an identity ALWAYS key, or a non-integer, non-uuid key with a sequence default, still advances its
sequence during a run.

**Amended:** a class gets one representative per side of the expected keys, and the clone reads
its values from a temporary source row instead of literals (review-fixes ADR, decisions 3 and 6).
The time zone is pinned for the whole session and in every probe (decision 9).

### 6. UPDATE reach and column privileges

**Amended:** "granted" now means UPDATE and SELECT (review-fixes ADR, decision 1).

`set col = col returning pk`. The column is, in this order: writable and granted and neither key
nor owner/tenant column; granted non-key; granted key; and with no UPDATE grant at all the first
writable column, so that the `42501` is observed and recorded. "Granted" comes from
`has_column_privilege` (table-level or column-level), one query per role and table. Generated and
identity ALWAYS columns are never named.

### 7. `expectedRowsSql`

Wrapped as `select <pk>::text from (<query>) as expected_rows(<pk columns>)`: the alias list maps
the query's first columns to the key **by position**. `:claims` becomes `$n::jsonb`, `:sub` stays
untyped so Postgres infers uuid, integer or text. Parameters are numbered by first appearance
(an unused `$1` could not be typed). A positional `$1` in the user's text is refused. Exactly one
statement; it runs in a rolled-back transaction. Any failure makes the cell `inconclusive` with
`expectedRowsSql failed: <message>`.

### 8. Classification precedence

`leak` > `escape` > `inconclusive` > `overblock` > `pass`. A proven leak stays a leak when another
row or sub-probe was inconclusive. An inconclusive part hides an overblock. `42501` is blocked
(**amended:** unless it is not about the probed rows, review-fixes ADR, decision 2); every other
SQLSTATE and every engine failure is inconclusive. A reach cell of a table without seeded rows is
`skipped`, not `pass` (decision 8). ISOLATED needs at least one cell
that is `pass` or `overblock`; with none (no cells, or only skipped and inconclusive ones) the
verdict is NOT PROVEN.

### 9. Lost database

A timeout, a terminated worker or a worn-out session (`EngineError.databaseLost`; the last one was
added by the review-fixes ADR, decision 10) ends the cell as `inconclusive`. The
engine is closed, the factory builds a new one, setup, introspection and ground truth are
replayed, and the run continues. `timings.rebuilds` counts them. The run ceiling is the host's:
it aborts through `signal` (checked before every cell), which rejects with `MatrixAbortedError`.
`statement_timeout` is not set: PGlite does not enforce it (ADR 0002).

### 10. Supabase claims

In `supabase` mode the `role` claim is added when the persona leaves it out, because a Supabase
JWT always carries it and `auth.role()` reads it. The claims JSON is `stableStringify`, recorded
per persona in the result.

## Consequences

- The export embeds `CellResult.statement` / `SubProbeResult.statement` (or calls the builders of
  `probes.ts`) and `expectedKeys`; it needs `rowsWithValueProbe` for the bulk escape shape and
  should implement the WHERE-less DELETE as well. Since the review fixes it also needs the source
  row, the blind UPDATE, the takeover and the pinned settings (listed in that ADR).
- `MatrixRun.catalog` is what the static checks read; no second introspection is needed.
- Result JSON carries no clock and no randomness as long as the keys and scope columns of the seed
  do not (a seed that uses `gen_random_uuid()` or `now()` for THOSE is not deterministic by
  itself). Any other column may: no value of a seeded row is written into a probe any more.

## Verification

`npx vitest run src/lib/runner tests/runner`: unit tests beside every module; integration suites
`reach`, `fallback-escape`, `insert`, `custom-scope`, `run-matrix` (determinism, unchanged database
including sequence positions, rebuild after a simulated timeout, abort, SetupError, column
privileges) and `runner.bypass-guard` against real PGlite.
