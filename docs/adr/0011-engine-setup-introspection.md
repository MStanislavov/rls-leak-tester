# ADR (draft): the SqlEngine port, the PGlite adapters, setup, introspection and ground truth

- Status: draft, to be numbered by the orchestrator
- Date: 2026-09-19
- Phase: 3, task A2
- Versions: `@electric-sql/pglite` 0.5.8 (PostgreSQL 18.3), TypeScript 6.0.3, Vitest 5.0.1, Node v26.8.1

## Context

The matrix runner is pure TypeScript over a small `SqlEngine` port (brief 3.5). This slice delivers
the port, its two adapters (Node and Web Worker), the setup pipeline, catalog introspection and the
ground-truth snapshot. Everything below was run and read on this machine; where something was not
run it says so.

## Decisions

### 1. The port lives in `src/lib/runner/types.ts`, not in `src/lib/engine`

Brief 4.2 puts the port in `src/lib/engine`. The runner classifies a probe with
`error instanceof SqlError`, which is a VALUE import, and SEC-004 forbids the runner every value
import from `src/lib/engine`. So the port and its error classes live in the pure directory and the
adapters import them. `src/lib/engine/port.ts` re-exports the module where the brief expects it.

### 2. `query` returns `{ rows, affectedRows }`, not bare rows

The task text says `query(sql, params) -> rows`. The second shape of the scope-escape probe (ADR
0002: an UPDATE without `WHERE` and without `RETURNING`) returns no rows, and "it did not fail" is
not "it moved rows": the runner needs the affected row count. Rows are objects keyed by column
name; a repeated column name keeps the last value.

Errors: `SqlError` always carries a SQLSTATE in `code`. A failure WITHOUT a SQLSTATE (WASM abort,
closed handle, failed boot) is an `EngineError`, never a `SqlError`, so it can never be read as a
verdict from Postgres. `EngineTimeoutError` and `EngineTerminatedError` extend `EngineError` and
carry `databaseLost = true`.

### 3. One engine implementation, two transports

`createProtocolEngine(transport)` is the only implementation of the port. The browser transport is
`PgliteWorkerClient`; the Node transport calls the worker's request handler in-process
(`createLoopbackTransport`). Node tests therefore run the same handler, the same cell
normalisation and the same transaction logic the browser runs. A separate direct PGlite adapter
for Node was rejected because two code paths are how "identical in Node and in the worker" rots.

Cells are `string | number | boolean | null` on both paths: `bigint`, dates, `bytea`, arrays and
JSON arrive as text (the existing `toCell`). Pinned by a test: `9007199254740993::int8` arrives as
`"9007199254740993"`.

The protocol grew by two requests: `query` (one statement, scalar parameters) and `close`.

### 4. Transactions over the message protocol: `BEGIN` on the one connection, plus a client lock

PGlite has one connection, so `BEGIN` sent through `exec` leaves it inside the transaction for the
requests that follow (ADR 0002; re-proven in `handler.test.ts`). No session id and no batch script
is needed, and the callback can decide its next statement from the previous result, which a batch
could not. What keeps OTHER callers out is a lock in `createProtocolEngine`: a call on the engine
waits until the open transaction has ended, the same semantics as `db.query` inside
`db.transaction`. Measured: a query issued during an open transaction ran after the rollback and
did not see the transaction's table.

A lost database ends the transaction with it. The handle is closed and **no `ROLLBACK` is sent**,
because that request would boot a new, empty worker. `tx.rollback()` in a `finally` is therefore
safe after a timeout.

### 5. Timeouts

Every call through the worker engine has the client's exec timeout, `DEFAULT_EXEC_TIMEOUT_MS`,
which `tests/engine/thresholds.test.ts` pins to `thresholds.runner.probe_timeout_ms` in
`rules.yaml`. On expiry the worker is terminated, the call rejects with `EngineTimeoutError`, and
the SAME engine object then answers from a new, EMPTY database: the caller replays
`setupDatabase`. `setupDatabase` passes a lost-database error through unchanged instead of blaming
the statement.

The first call on every new worker is preceded by `init` with the client's longer init timeout
(30 s), because booting Postgres takes longer than a probe may. A failed boot is retried by the
next call. The run ceiling (`run_ceiling_ms`) is the runner host's job and is not implemented here.

The Node engine has no timeout (ADR 0002: no cancel API, a running query blocks the thread).

### 6. Setup order deviates from brief 3.5 on purpose

Brief 3.5 runs the default grants (step 4) after schema and seed (step 3). Implemented, in
`supabase` mode: shim, default grants per exposed schema, schema SQL, seed SQL. ADR 0002 gave the
reason (a `REVOKE` in the user's SQL must survive). A negative control in this slice, grants moved
after the schema and then restored, turned two tests red and so found a second reason: an exposed
schema other than `public` must exist before the user's SQL creates tables in it. The pipeline
creates it (`create schema if not exists`) before granting.

`options.supabaseGrants`: `legacy` maps to `autoExposeNewTables: true`, `explicit` to `false`;
default `legacy`. `postgres` mode applies no shim and no grant. Measured with the same schema: the
RLS-disabled table is readable by `anon` under `legacy` and answers `42501` under `explicit` until
the user's SQL grants it.

The user's SQL runs statement by statement through `splitSqlStatements` from `@/lib/scenario`
(the task text called it `splitStatements`; the real export name is used). Each statement commits
on its own, as in psql. Measured: after a failure in statement 2 of 3, table 1 exists and table 3
does not. A script that wants one transaction writes `BEGIN; ... COMMIT;`, which works across
statements because there is one connection. `SetupError` carries phase (`shim`, `grants`,
`schema`, `seed`), statement index, statement text, line, column, SQLSTATE (or `null` for an
engine failure), message, detail, hint and Postgres' 1-based position INTO THE STATEMENT.

### 7. The Supabase shim stays in `src/lib/engine` and is passed into `setupDatabase`

`setupDatabase` is pure and may not value-import `src/lib/engine`, where the shim lives. Moving the
shim into `src/lib/runner` was considered and rejected for now: `scripts/spikes/pglite-rls.mjs`
loads `src/lib/engine/supabase-shim.ts` through plain Node type stripping, a re-export through the
`@/` alias does not resolve there, and a relative re-export with a `.ts` extension is TS5097 under
this `tsconfig.json`. The script is outside this task's ownership and was green before and after
(13 claims). So `setupDatabase(engine, scenario, supabase)` takes a `SupabaseSetupSql` value and
`src/lib/engine/supabase-setup-sql.ts` exports the ready constant `SUPABASE_SETUP_SQL`.

**Consequence for the export slice:** `src/lib/export` is pure too and will need the same SQL for
the CI proof. It can take a `SupabaseSetupSql` parameter the same way, or the orchestrator moves
the shim to a pure directory and updates the one import in the spike script. Not decided here.

### 8. Introspection

`introspect(engine, exposedSchemas)` runs twelve catalog queries, sequentially, as the superuser.
No identifier is interpolated: the schemas travel as one JSON text parameter. Every list is ordered
in SQL with `collate "C"`, so the order does not depend on the database locale. Facts measured on
PostgreSQL 18.3, several of which differ from what older notes say:

- `attgenerated` is `s` or `v`: virtual generated columns are new in 18, and `pg_attrdef` holds
  the generation expression for both. `default` is therefore never a generation expression.
- `polroles = {0}` means PUBLIC, and Postgres collapses `to app, public` to it. Oid 0 is mapped to
  the name `PUBLIC`, never dropped (RLS003 depends on it).
- A NULL `relacl` means the built-in default; `acldefault('r', relowner)` spells out the owner's
  privileges. On 18.3 the list includes `MAINTAIN` (observed; which release added it was not
  checked here).
- `select distinct ... order by 1 collate "C"` is rejected (`collations are not supported by type
integer`); the view reference query uses `GROUP BY`.
- `proconfig` is a `text[]` with elements like `search_path=public, pg_temp`.

Beyond the task list the catalog carries role memberships (`memberOf`, `inherit`), because a
persona that is a member of the table owner's role reaches the owner's RLS bypass, and materialized
views with a flag. Roles are all non-`pg_*` roles: `introspect` does not know the personas.

### 9. Ground truth

Keys are the JSON array of the key columns' `::text` values in KEY order (`["10","<uuid>"]`).
`primaryKeySelectList` and `keyOfRow` are exported so that probes build the same key after
`SELECT` and after `RETURNING`; a test proves the round trip. A table without a primary key is
`skipped` with a reason and there is no `ctid` fallback. A configured owner or tenant column that
the catalog does not know makes the table `skipped` with a reason before any SQL is built: a typo
must not produce a wrong verdict, and the name never reaches the SQL text. Rows are sorted by
serialised key in code-unit order.

## What is NOT done or NOT verified

- **RUN-001 is only half met.** `tests/engine/engine-role-switch.bypass-guard.test.ts` satisfies
  the rule's file check, which let work in `src/lib/runner` proceed. It proves the engine half: the
  transaction-local role switch filters, the control without the switch does not, and the owner and
  `BYPASSRLS` bypasses are real on this engine. It does NOT prove that every probe the runner
  builds uses the switch, nor that a persona with a bypassing role is detected. The runner slice
  owes that suite; a green RUN-001 must not be read as that proof.
- `createPgliteWorkerEngine` in `worker/create-worker.ts` is browser-only and no test here runs
  it. Its two parts are unit-tested with a scripted worker; the real worker path needs the lab
  wiring and an e2e test. `npm run e2e` was not run in this slice.
- The run ceiling is not implemented (runner host).
- Whether `functions` should exclude functions owned by an extension was not examined; no
  extension is loaded.

## A testing trap found on the way

With Vitest 5 fake timers, `vi.advanceTimersByTimeAsync(0)` does not fire a zero-delay timer that
was created during an earlier zero-length advance. A scripted worker that answers on
`setTimeout(..., 0)` delivered its first answer and never its second, which looked exactly like a
deadlock in the engine. Isolated before anything was changed: the client alone worked, the pending
timer count stayed at 2 across rounds, and rounds of 1 ms delivered everything. The helper in
`worker-engine.test.ts` advances by 1 ms.

## Verification (commands run, output read)

| Command                                                                  | Result                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `npx vitest run src/lib/engine src/lib/runner tests/engine --coverage`   | 13 files, 139 tests passed; engine + runner lines 97.05 %, branches 97.11 % |
| `npx vitest run tests/spikes tests/eslint tests/rules-check`             | 7 files, 311 tests passed                                                   |
| `npx eslint --max-warnings 0 src/lib/engine src/lib/runner tests/engine` | exit 0                                                                      |
| `npm run typecheck`                                                      | exit 0, no `error TS`                                                       |
| `npm run rules`                                                          | `rules-check (full): ok, 15 script rules, 190 files`                        |
| `npx prettier --check src/lib/engine src/lib/runner tests/engine`        | all files formatted                                                         |
| `node scripts/spikes/pglite-rls.mjs`                                     | exit 0, all 13 claims hold, before and after this slice                     |
| Negative control: grants after the schema                                | 2 of 8 setup tests fail; restored, 8 of 8 pass                              |
