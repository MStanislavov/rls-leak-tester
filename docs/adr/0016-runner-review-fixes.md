# ADR (draft): wrong verdicts found by three reviews of the core library, and how they were closed

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-20
- Phase: 3 (core library), review round
- Amends: the draft ADR on the runner design (decisions 1, 3, 4, 5, 6, 8, 9), the draft ADR on
  golden tests

## Context

Three independent reviewers (RLS semantics, robustness and determinism, spec conformance) ran the
matrix runner against scenarios of their own and reproduced eighteen findings, thirteen of them
blockers: a scenario that leaks was called ISOLATED, or a correct one LEAKING. Several findings
share a root cause. Each was first turned into a failing test (21 tests, all red before the
change), then fixed. The regressions live in `tests/runner/false-isolated.integration.test.ts`,
`tests/runner/session-state.integration.test.ts` and
`tests/engine/error-budget.integration.test.ts`; unit tests sit beside the modules.

One existing test asserted the bug: `tests/runner/fallback-escape.integration.test.ts` expected
`pass` for `using (true) with check (own)` on UPDATE. By hand, as Alice,
`update strict set user_id = ALICE where id = 3 returning id` returns Bob's row. The expectation
is now `leak`, with the reason in the test.

## Decisions

### 1. UPDATE reach has three steps, not one

`set col = col returning pk` reads columns, so it needs SELECT rights and runs under the SELECT
policies. It cannot see two real things:

- **Takeover.** With USING wider than WITH CHECK (`using (tenant) with check (own)`) the no-op on a
  colleague's row raises 42501, and `set user_id = <me>` on the same row goes through. A per-row
  42501 that says `new row violates row-level security policy` means USING let the persona at
  the row. For such a row outside the expected keys the runner now tries `pullMoves`: owner and
  tenant column set to the persona's values, both at once, then each alone. A success is reach,
  so a `leak`. A value that does not fit the column type (SQLSTATE class 22) is not a finding;
  any other error makes the cell inconclusive.
- **Blind update.** `update t set col = (select col from <source row>)`, no WHERE, no RETURNING:
  it reads no column of the table, so no SELECT right is needed and no SELECT policy applies
  (measured: `for update to anon using (true)` without a SELECT policy, the no-op reaches 0 rows,
  this shape 2 of 2). The superuser reads every key with `tableoid || ctid` before and after, a
  changed row version is a touched row. This is a use of `ctid` as "was it rewritten in this
  transaction", keyed by primary key; rows are still never identified by it (brief 3.5 step 6).
  Up to three columns are tried (the next one only after a constraint error: one value for all
  rows collides on a unique column), then the takeover variants without WHERE. With no statement
  through, a 42501 among the answers means refused; only constraint errors means inconclusive.
  The blind shape is skipped when the visible one already reached every row, and when the role
  holds UPDATE on no column.

`chooseUpdateColumn` now wants UPDATE **and SELECT** on the column (`has_column_privilege` for
both): with a column-level SELECT grant that leaves one column out, `set secret = secret` raised
"permission denied for table", which was read as blocked for every row.

### 2. A 42501 is "blocked" only when it is about the probed rows

`isBlocked` still follows the brief (42501 is blocked) with one carve-out, measured on PostgreSQL
18.3: `permission denied for schema|type|sequence|language|database|tablespace|foreign-data
wrapper|foreign server|large object|parameter ...` and `query would be affected by row-level
security policy` are inconclusive. They say that the probe's own SQL could not be run (a cast
named a type in a schema without USAGE; `row_security = off` was left in the session), not that a
row is protected. Table, view and column privileges, `permission denied for function` (a policy
calls a function the role may not execute: the role really is locked out), policy violations and a
42501 with any other text (a trigger's own refusal) stay blocked. The messages are compared in
English; PGlite has no other `lc_messages`.

A missing privilege is about the statement, so it is no longer repeated row by row. Only a row's
own doing (a policy violation, a constraint, a trigger) starts the per-row fallback.

### 3. Values of seeded rows never appear in a probe: the source row

Insert clones and the blind update need a seeded row's values. Writing them as literals had two
defects: `'done'::private.status` needs USAGE on the type's schema (finding: a forged insert
reported as blocked), and the value of a `default now()` column differs in every run (finding:
result JSON not byte-identical on the most common Supabase column). Now the superuser, inside the
probe transaction, runs `create temporary table rls_leak_tester_source on commit drop as select *
from t where <key>` and `grant select` on it to the persona's role, and the persona runs
`insert into t (cols) select <fresh key>, col, ... from pg_temp.rls_leak_tester_source`. The
statement text is the same in every run and names no type except the fresh key's (`uuid`,
`smallint`, `integer`, `bigint`). `readRowProbe`, `insertProbe` and `cloneValues` are gone. A
failure of a superuser statement is rethrown without its SQLSTATE (`SuperuserStepError`), so it
can never be read as blocked. If the role may not use temporary schemas
(`revoke temporary on database`), the insert fails with "permission denied for schema pg_temp_N",
which is inconclusive by decision 2.

Escape and takeover probes still cast the moved value by type name (`'2'::integer`): the value is
what the user has to read in the result. A type in a private schema makes those sub-probes
inconclusive, not blocked.

### 4. SELECT behind an unreadable key

`select pk` raising 42501 is a block only if the role can read nothing. With a column-level grant
that leaves the key out the role still reads every row through another column. `count(*)` needs
SELECT on any one column: 0 visible rows and all rows identify the rows; anything between is
`inconclusive` with the reason and the advice to grant SELECT on the key.

### 5. Own and tenant are decided by Postgres

`row.owner === persona.sub` compared claim text with `column::text`. An upper-case uuid (macOS
`uuidgen`) or `1` against a `numeric(4,1)` column seeded `1.0` matched nothing, and a correct
policy came out LEAKING. `runMatrix` now asks the database as the superuser
(`select pk from t where col = $1::text::<column type>`), once per persona and table, and hands
the result to the pure planner as `ScopeMembership`. When Postgres cannot compare (the claim does
not fit the type, the type has no `=`) the text comparison remains as the fallback.

Scope `tenant` for a persona that has a `sub` but no `tenantClaimPath` is now `skipped` with a
reason that names the field, instead of expecting zero rows. A path that is set and leads to
nothing still means "this user has no tenant": zero rows.

### 6. Insert classes are split by side

Under scope `own`, Alice's own row in another tenant and a stranger's row are both class `other`.
The representative was the first row, Alice's, so the forged insert was never tried. A class now
gets a representative for each side of the expected keys. The cell may hold two sub-probes of one
kind; `expected` and `sourceKey` tell them apart.

### 7. Scope `own` also moves the tenant column (reverses deviation 4 of the runner ADR)

Brief 3.5 says "the tenant (or owner) column". The default scope is `own` whenever an owner column
exists, so with the old rule the headline leak of template 1 (move an own row into another
tenant) was found only with an explicit `tenant` scope. For scope `own`, a table with a tenant
column and a persona with a tenant claim, a second pair of escape sub-probes moves the tenant
column to a value that belongs neither to the expected rows nor to the persona's tenant.
Consequence, seen on a reviewer's fixture: `for all using (own) with check (own)` on a table with
`org_id` is an `escape` for a persona that declares its org. That is the finding working as the
brief defines it: the policy lets Alice file her row under Bob's organisation. A persona without
a tenant claim does not get this pair, because its rows may live in any tenant.

### 8. Nothing measured is never a pass

Reach cells of a table without seeded rows were `pass` with a remark, and a pasted schema without
seed data, RLS disabled, came out ISOLATED. They are `skipped` now (`EMPTY_TABLE_REMARK`), no SQL
runs, and the verdict is NOT PROVEN.

### 9. The session is pinned, in setup and in every probe

The engine has one connection. `setupDatabase` now sets `time zone 'UTC'` first, refuses a script
that leaves a transaction open (`SAVEPOINT` outside a block raises 25P01; inside one it succeeds:
`SetupError` with SQLSTATE 25001 on the last `BEGIN`, where psql would have discarded the script
on disconnect and the runner's first ROLLBACK did), and after the seed runs
`reset session authorization`, `reset role`, `reset all`, UTC again. Every probe transaction adds
one statement after role and claims: the legacy `request.jwt.claim.sub|role|email` and
`request.jwt.claim` emptied (Supabase's `auth.*` functions read them first; current PostgREST does
not set them), `row_security = on`, `TimeZone = UTC`, all transaction-local. `WHOAMI_PROBE` also
returns `row_security`, and the executor refuses to probe unless it is `on`. Known consequence: a
`set search_path` in the scenario SQL does not reach `expectedRowsSql`; qualify names there.

The blind DELETE compares the superuser's reads before and after the statement instead of the
ground truth with what remained.

### 10. An error budget per database session

Measured on PGlite 0.5.8, one failing statement per rolled-back transaction until 54001:

| SQLSTATE                  | Errors survived | SQLSTATE           | Errors survived            |
| ------------------------- | --------------- | ------------------ | -------------------------- |
| 42501 missing privilege   | 3046            | 22012              | 1871 (1701 through `exec`) |
| 42501 WITH CHECK          | 2976            | 22P02              | 1845                       |
| 23503                     | 2974            | 42703              | 1845                       |
| 23505                     | 2977            | 42P01              | 1794                       |
| P0001 raised in a trigger | 2964            | 42601 syntax error | 370                        |
| 25P01                     | 2569            |                    |                            |

After that ROLLBACK fails as well and every statement answers 25P02. The reviewer's figure (2,977)
is the cheapest kind; a syntax error costs eight times as much. `error-budget.ts` wraps the engine
of a run: an error is charged 1 unit (42501, class 23, class P0), 8 (42601) or 2 (anything else);
at 1,000 units the database is rebuilt before the next cell, at 2,000 no further statement is
sent (`EngineWedgedError`, the cell is inconclusive, rebuild). 54001, and 25P02 on the first
statement of a transaction, become `EngineWedgedError` too: the backstop for an error kind the
table does not know. `tests/engine/error-budget.integration.test.ts` holds the default budget
against the real PGlite for four kinds of error.

Not done, on purpose: "do not return ISOLATED when cells went inconclusive because of an engine
failure". Brief 3.5 says inconclusive cells do not change the verdict; they are counted beside it.

## Consequences for other parts

- **CI export (brief 3.8).** It must share the new builders: `sourceCopyProbe` and
  `sourceGrantProbe` before an insert clone and before `updateBlindProbe`, `rowVersionsProbe`
  around it, `pullRowProbe` / `pullBlindProbe`, `selectCountProbe`, and the third statement of
  `identityProbes` plus `set time zone 'UTC'` in its preamble, or its proof differs from the
  runner's.
- **UI.** A cell can show two sub-probes of the same kind (insert sides, owner and tenant move).
  `EMPTY_TABLE_REMARK` is now the reason of a skipped cell. Transcripts are longer.
- **Result JSON.** No field was added or removed; `MATRIX_RESULT_VERSION` stays 1.

## Verification

`npx vitest run src/lib/runner tests/runner tests/engine tests/golden`, plus the reviewers' own
scratch scripts re-run against the fixed runner: every reproduced wrong verdict is gone.
