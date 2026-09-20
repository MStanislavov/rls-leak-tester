# ADR draft: store, runner, export and landing page polish after the Phase 4-7 review

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-20
- Phase: 8 (task M)
- Changes: ADR 0012 (result shape), 0019 (final exception of the CI export), 0020 (store and
  sharing), 0021 (self template), 0022 (lab workbench), 0026 (sharing UI), 0027 (site shell)

Eight findings of the review, each fixed test first. Where a number or a file is named below it
was measured or run in this change, not remembered.

## 1. The slug cache could bring a private or deleted scenario back

### Context

`getBySlug` reads through a cache (`SCENARIO_CACHE_TTL_SECONDS`, 60 s). Every write already
invalidated AFTER the database write, but a delete alone does not close the race: a reader that
loaded the row before the write and fills the cache after the writer's delete puts the old row
back for a whole TTL. For a scenario the owner just made private, or deleted, that is a privacy
bug, not a staleness nuisance.

The `Cache` port has `get`, `set` (always with a TTL) and `delete`: no compare-and-set, and
`src/lib/redis` was not to change.

### Decision

A "changed" marker per slug (`keys.build("scenario", "<slug>.changed")`; the dot makes the key
builder hash the id, so it can never collide with a slug's own key).

- Writer, after the database accepted the write: `set(marker)` FIRST, then `delete(entry)`. Each
  step fails open on `RedisUnavailableError` and both are always attempted.
- Reader, on a miss: nothing is cached while the marker exists; otherwise `set(entry)` and then
  the marker is read ONCE MORE, and the entry is deleted again when the marker appeared.

Why it is enough: let the marker be set at Tm and the entry deleted at Td (Tm < Td). A stale
reader stores at Ts. If Ts < Td the writer's delete removes it. If Ts > Td then its second look
happens after Ts > Tm and finds the marker, so the reader removes its own entry. The old row can
live for the few milliseconds between the reader's `set` and its own `delete`, never for a TTL.

The marker's TTL is `SCENARIO_CACHE_TTL_SECONDS` itself: no new threshold, and far longer than
a load takes. The price: for 60 s after a write the slug is served from the database.

Rejected: versioning the key by `updated_at` (the reader would need the current version, which
is the database read the cache exists to avoid; the wire timestamp has millisecond precision, so
two writes can share one); a tombstone in the entry's own key (check-then-set is not atomic, the
stale `set` overwrites the tombstone).

Tests (`tests/api/scenarios.test.ts`): a fake Supabase that holds an answer back
(`beforeAnswer`) and a cache wrapper that lets the write overtake the reader inside its `set`;
both interleavings, for "switch to private" and for "delete". Without the two marker lines all
four fail (checked by removing them).

## 2. `get_scenario_by_slug` handed out the owner's user id

### Context

The function returned `setof public.scenarios`, so an anonymous caller with the anon key got the
`auth.users` id of the owner of any unlisted row through PostgREST.

### Decision

The function `returns table (id, slug, title, payload, visibility, updated_at, is_owner)`;
`is_owner` is `coalesce(owner = auth.uid(), false)`. No deployed database exists, so the one
migration was edited in place. `select owner from get_scenario_by_slug(..)` is 42703 now
(test in `tests/store/migration.test.ts`, both grant regimes).

Server: `findBySlug` returns a `SharedScenarioRow` (`isOwner`, no `owner`); the shared cache
stores neither. `ownedByMe` comes from `is_owner` on a miss; on a cache hit a signed-in caller
costs one `select owner ... where id =` (the existing `ownerOf`, no payload), an anonymous
caller nothing. The fake Supabase answers 42703 for a column the function does not have.

Not changed, and reported as an open point: `owner` of a PUBLIC row is still readable through
the table itself (`grant select` to anon plus the public read policy). Closing that needs
column-level grants, which change the fourth template's matrix and the static checks.

## 3. `created_at` / `updated_at` were the client's on INSERT

`scenarios_touch_updated_at` (BEFORE UPDATE) became `scenarios_set_timestamps`, BEFORE INSERT OR
UPDATE: an INSERT gets `now()` for both columns, an UPDATE keeps `old.created_at` and sets
`updated_at`. Tests: a forged INSERT and a forged `created_at` in an UPDATE.

Consequences, all run: `node scripts/self-isolation/sync-template.mjs` rewrote
`own-scenarios-migrations.ts`, `--check` is clean; `npx vitest run tests/self-isolation
tests/templates tests/golden tests/store`: 14 files, 379 tests passed BEFORE any snapshot was
touched. **The own-template golden snapshots did not change** (byte-identical, `git status`
shows none of them): a result holds keys, statements and policies, never a timestamp, and the
policies are the same. The seed of the fourth template still names `created_at`/`updated_at`;
the trigger overrides them, which no cell observes. `scripts/self-isolation/verify-postgres.sh`
on postgres:18-alpine (18.4): `ISOLATED. 20 of 20 checked cells passed`, exit 0.

## 4. A failed `expectedRowsSql` did not say which statement failed

`ProbeFailure` gained an OPTIONAL `statement`. It is set only for this failure: the wrapped
query that ran, literals inlined (`probe.inlined`), or the user's text when no query could be
built (two statements, `$1`). The drawer shows it under the SQLSTATE with a copy button
(`cell-drawer-error-statement`). The cell's own `statement` stays empty: no probe ran, and the
CI export embeds that field (`tests/export/runner-contract.test.ts` pins it).

Result JSON: only cells with this failure gain `error.statement`. No golden snapshot holds
such a cell (`grep "expectedRowsSql failed" tests/golden/__snapshots__`: nothing), so none
changed. `/api/explain` validates `error` with a strict object; it is offered on leak, escape
and overblock only, and this failure is always `inconclusive`, so the new key never reaches it.

## 5. A timed-out probe read "Inconclusive ... 1 missing"

The status stays `inconclusive` (counts, filters and the verdict are unchanged). The views give
it its own words: `cellTimeout(cell)` is `"reach"`, `"sub-probe"` or `null`;
`cellStatusView(cell)` answers label "Timed out" and a meaning of its own; the grid cell shows
the hourglass icon plus "Timed out" (`data-timed-out`), and no leaked/missing note when the
reach probe timed out, because nothing was measured. The drawer badge, its explanation and the
badge of the sub-probe that timed out say the same. Icon and word, never colour alone.

A result keeps only SQLSTATE and message of a failure, so the timeout is recognised by
`isTimeoutFailure`: `sqlState === null` and the message of `EngineTimeoutError`
(`ENGINE_TIMEOUT_MESSAGE`, defined beside the class and pinned by a test). User SQL cannot
forge it: every error Postgres raises has a SQLSTATE. Rejected: a `timedOut` flag in the result,
which would have changed the strict `/api/explain` schema for sub-probes and would be absent
from results that were stored or shared earlier.

## 6. The final exception of the CI export

Headline and counts, one first line as before:

    <tool>: LEAKING. Of N checked cells: a leaked or escaped, b overblocked, c inconclusive, p passed; w warnings.
    <tool>: NOT PROVEN, no leak or escape was measured. Of N ...   (setup problem or inconclusive)
    <tool>: OVERBLOCKING, no leak or escape was measured. Of N ... (overblock only)

The counts are taken from the status every reported line starts with. `Setup problems: n; cells
not run because of them: m.` is unchanged. The header no longer says "the database is unchanged
afterwards": rows, roles and settings are as before, but a probe INSERT that draws its key from a
sequence (serial, `nextval()`, GENERATED ALWAYS AS IDENTITY, whose column the runner must leave
out of the clone) advances it, and a rollback does not take that back.

## 7. The comparators could not read a cell id with a space

`failedCells(error, cellIds)` (tests/export/helpers.ts) finds the id among the ids of the run,
longest first, instead of cutting the line at the first space; a label with parentheses is no
longer a problem either. New: `tests/export/helpers.test.ts`, the fixture `HOSTILE_TEXT_LEAKY`
(table `Odd "Table`, role `"app user"`) in the runner-agrees suite, so a spaced quoted name is
compared with failing cells for the first time. `scripts/verify-export-postgres.sh` had the same
cut in `sed`; it now maps each reported line to the expected line it begins with (awk), reads
role names line by line, and verifies both hostile fixtures on real Postgres.

## 8. The landing page shipped zod

Measured in the production build before the fix: the layout's client chunk pulled a 395,991
byte chunk (95,848 bytes gzip) that is zod, through
`auth-controls.tsx > lib/lab/share-auth.ts > lib/store/server/auth.ts > zod`. The header renders
`AuthControls` only with Supabase configured, but a client reference is bundled either way.

`src/lib/store/auth-errors.ts` holds the error codes and `parseAuthErrorCode` without zod; the
callback's `z.enum` is built from the same list (a test compares them). Guards:
`tests/site/landing-client-graph.test.ts` walks the static imports of every "use client" module
under the layout and the page and names any chain that ends in zod; `e2e/site.spec.ts` has the
marker `zoderror` beside the others (it fails on the old build, passes on the new one, and the
positive control finds it in `/lab`). `turbopackScopeHoisting: false` is untouched; the whole
Playwright suite passed in prod mode on port 3210 (59 tests).
