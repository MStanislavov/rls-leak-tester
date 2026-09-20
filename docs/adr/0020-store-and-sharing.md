# Scenario store, sharing and sign-in: port, Supabase schema, API routes

Status: draft (Phase 7, library and server side; the Share dialog, sign-in button and `/s/[slug]`
follow in the UI slice)

## Context

Brief 3.10, 4.5 (uses 1 and 4), 4.6, 4.7, 4.8 and rules.yaml SEC-001, SEC-002, SEC-004, ARCH-002,
ARCH-003, REDIS-002, TEST-001 ask for a `ScenarioStore` port with a `localStorage` adapter (the
default) and a Supabase adapter (only when configured), a `scenarios` table whose RLS is
exemplary because it becomes a template, thin API routes, GitHub sign-in through Supabase Auth,
write rate limits and a read-through cache by slug. Verified against the installed toolchain:
`@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.116.0, zod 4.6.5, Next.js 16, PGlite, and the
Redis layer of `0017-redis-design.md`.

## Decisions

### Port (`src/lib/store/types.ts`)

`ScenarioStore { kind, list, get, getBySlug, save, remove }`, `StoredScenario`,
`StoredScenarioSummary`, `Visibility`. Every failure of either adapter is one class,
`StoreError { code, issues, retryAfterSeconds }`; the codes are a closed list
(`STORE_ERROR_CODES`) and the same strings travel in the JSON error body of the API.

### Local adapter (`local.ts`)

- Keys: `rls-leak-tester:v1:index` (`{ v: 1, ids }`) and `rls-leak-tester:v1:scenario:<id>`
  (`{ v: 1, id, updatedAt, scenario }`). The version is in the key and in the value.
- Every read parses the envelope with zod and the scenario with `parseScenario`. An entry that is
  not JSON, has the wrong shape, holds an invalid scenario, carries another id, is missing or is
  absurdly large is skipped and reported (`problems()`, `onProblem`), never thrown. A damaged or
  lost index is rebuilt from the storage keys when the storage can enumerate them (`key`,
  `length`; real `localStorage` can, the contract's three-method `Pick` cannot).
- `save` without an id creates `<slug of the title>-<10 random chars>`; with an id it replaces or
  creates that entry (upsert). A slug is the local id; visibility is always `private`.
- `QuotaExceededError` (also Firefox's name and the legacy codes 22 and 1014) becomes
  `quota_exceeded`; any other storage failure `storage_unavailable`. When the index write fails
  after the entry write, the entry is taken back.
- The storage is resolved on first use, so constructing the store on the server is harmless.

### Schema and RLS (`supabase/migrations/20260920000000_scenarios.sql`)

- Table as the brief lists it; `owner` defaults to `auth.uid()` and references `auth.users`
  with `on delete cascade`. Check constraints: slug format and length (3 to 64,
  `^[a-z0-9]+(-[a-z0-9]+)*$`), title 1 to 120, visibility, payload is a JSON object, payload
  text at most 1 572 864 bytes. `updated_at` is set by a trigger (its function has
  `search_path = ''`).
- `ENABLE` and `FORCE ROW LEVEL SECURITY`.
- Explicit grants, written for Supabase's new regime and also correct under the legacy one: the
  migration first REVOKES everything on the table from `public`, `anon`, `authenticated`,
  `service_role`, then grants `select` to `anon` and `select, insert, update, delete` to
  `authenticated`. `service_role` gets nothing: the application never uses it, so a leaked
  service key cannot read private scenarios through the API. The test suite runs under both
  default-grant regimes of the shim and ends in the same place.
- Policies: `scenarios_owner_all` (`FOR ALL TO authenticated`, `USING` and `WITH CHECK`
  `owner = (select auth.uid())`) and `scenarios_public_read` (`FOR SELECT TO anon,
authenticated`, `visibility = 'public'`). There is deliberately no policy for `unlisted`.
- `get_scenario_by_slug(text)`: `SECURITY DEFINER`, `STABLE`, `search_path = ''`, every name
  qualified, returns `setof public.scenarios` for the exact slug when the row is public or
  unlisted or the caller's own. `EXECUTE` is revoked from `PUBLIC` (and from the API roles, which
  a legacy project grants by default privileges) and granted to `anon`, `authenticated`.
  Because of `FORCE`, the function's owner must get past RLS: verified in supabase/postgres
  (`migrations/db/migrations/10000000000000_demote-postgres.sql`:
  `ALTER ROLE postgres NOSUPERUSER CREATEDB CREATEROLE LOGIN REPLICATION BYPASSRLS`); PGlite's
  user is a superuser.
- Table-level grants, not column-level ones, on purpose: the file becomes the fourth template and
  the runner's insert probe clones whole rows. Changing `owner` is stopped by `WITH CHECK`,
  which the tests prove in both shapes (targeted, and without `WHERE`).

### Routes (decision on brief 4.6)

The brief lists `GET|POST|PATCH|DELETE /api/scenarios` and `GET /api/scenarios/[slug]`. A row has
two handles, and the port addresses rows by id, so the routes are:

| Route                           | Methods                  | Who                                 |
| ------------------------------- | ------------------------ | ----------------------------------- |
| `/api/scenarios`                | `GET`, `POST`            | signed in (list own, create)        |
| `/api/scenarios/[id]`           | `GET`, `PATCH`, `DELETE` | `GET`: own or public; writes: owner |
| `/api/scenarios/by-slug/[slug]` | `GET`                    | anybody: public, unlisted, or own   |
| `/auth/callback`                | `GET`                    | OAuth return leg                    |
| `/auth/signout`                 | `POST`                   | form target, 303                    |

The static segment `by-slug` wins over `[id]`, and an id is a uuid, so the two cannot collide.
All scenario routes answer `503 { error: { code: "not_configured", message } }` without
Supabase. Success bodies: `{ scenarios: [...] }`, `{ scenario: {...} }`, `204` for `DELETE`.
The owner's uuid never goes on the wire; `ownedByMe` does.

### Server (`src/lib/store/server/**`)

- One Supabase client per request from the cookies (`createServerClient`, `getAll`/`setAll`),
  with the anon key and the visitor's JWT. There is no service-role client.
- The session is verified with `auth.getUser()`; `getSession()` is not used on the server. An
  outage of Supabase Auth is `503`, not "signed out".
- Order of a write: configured (503), not cross-site (`Sec-Fetch-Site`, 403), per-IP limit (429),
  `getUser()` (401), per-user limit (429), body (400, 413), database. The IP check runs before
  the session is looked at, so a flood of forged cookies is limited before it costs a call to
  Supabase Auth; the limiter failing is `503` (fail closed, as `/api/explain`).
- Body: media type, `Content-Length`, bytes counted while reading (cap 1 MiB), strict UTF-8,
  JSON, `z.strictObject`, then `parseScenario`. A `slug`, `id` or `owner` in the body is refused.
- The slug is made on the server: `<slug of the title>-<16 chars of [a-z2-7]>` (80 random bits;
  an unlisted slug is a capability). A unique violation retries with a fresh suffix, five times.
- Writes filter by `owner` explicitly and RLS decides again. A write that reached no row asks
  `ownerOf(id)` afterwards: visible to the caller but not theirs is `403`, otherwise `404`
  (existence of a private row is not revealed).
- Database errors are mapped by SQLSTATE (`42501` forbidden, `23514` invalid, else unavailable);
  the database's text is never forwarded. A stored payload that fails `parseScenario` is
  `422 corrupt`.
- `statusOfStoreError` in `http.ts` is the one place where a code becomes an HTTP status.
- Read-through cache by slug (`readThrough`, TTL 60 s from rules.yaml): only `public` and
  `unlisted` rows are cached, a private row never is, a cached value is validated (zod and
  `parseScenario`) and a bad one is a miss, `ownedByMe` is computed per request. Every write
  through the API deletes the entry of its slug; a cache that is down does not fail a request.
- One JSON log line per request: action, status, duration, error code. No field can hold a
  scenario, SQL, a user id or an address.

### Sign-in

- Browser (`auth-client.ts`): `getAuthClient()` returns a no-op client (`enabled: false`) without
  the public variables. With them, `@supabase/ssr` is loaded by `import()` on first use, so pages
  that never sign in ship none of it. What it reports comes from the browser's session and
  decides what is shown; the server decides what is allowed.
- `GET /auth/callback` exchanges the PKCE code. `next` is resolved against the site origin
  (`NEXT_PUBLIC_SITE_URL`, else the request's origin) and accepted only when the result stays
  there; the `Location` is built from the parsed URL, never from the raw text. Failures come back
  as `?auth_error=not_configured|missing_code|provider_error|exchange_failed` on the same site.
- `src/proxy.ts` adds the project's `https://` origin to `connect-src` only when Supabase is
  configured (session refresh and sign-out of the browser client). Without it the header is
  byte-identical to before.
- `/api/explain` gets `resolveUserId: resolveRequestUserId`; it never throws and is `undefined`
  without Supabase, so the per-IP limit is unaffected.

### Thresholds (rules.yaml `thresholds.store`, new)

`scenario_body_max_bytes 1048576`, `scenario_payload_db_max_bytes 1572864` (the text form of
jsonb adds a space after every `:` and `,`), `list_max_rows 200`, `slug_suffix_length 16`,
`slug_max_attempts 5`. The strict schema in `scripts/rules-check/schema.mjs` got the matching
`store` object (upper bounds, so a later edit can tighten but not loosen silently).
`tests/store/policy.test.ts` compares rules.yaml, `policy.ts` and the check constraints of the
migration. The write rate limits already existed (`rate_limits.scenario_writes`).

## Deviations

- Route layout differs from the literal list in 4.6 (see the table above).
- An extra error code `corrupt` (422) and a `problems()` method on the local store, both beyond
  the contract, to report damaged data instead of throwing or hiding it.
- zod 4 fact that cost a bug: a bare `z.unknown()` object key is REQUIRED. The callback's `next`
  is `z.unknown().optional()`.

## Known limits

- The anon key is public, so a signed-in user can call PostgREST directly. RLS and the check
  constraints hold there (that is their job), but the API's rate limit, the slug generator and
  `parseScenario` do not apply: such a row can carry a vanity slug or a payload the app then
  reports as `corrupt`, and a direct change is seen by the slug cache after at most 60 s.
  There is no per-user row quota in the database.
- `GET /api/scenarios/by-slug/[slug]` is not rate limited (the brief limits writes and explain);
  misses are not cached, so random slugs cost one RPC each.
- A reader that loaded a row just before a write can re-fill the cache with the old row after the
  invalidation; it lives for at most the 60 s TTL.
- `buildDocumentCsp` accepts `https://` sources only, so a local Supabase stack on
  `http://127.0.0.1:54321` gets no `connect-src` entry.
- With `NEXT_PUBLIC_SITE_URL` set, the callback always lands on that origin; preview deployments
  should leave it unset or set it per environment.
- Nothing here ran against a real Supabase project (FA-1). The SQL is proven in PGlite on the
  shim; PostgREST behaviour (`rpc().select().limit()`, error codes of a fetch failure) is taken
  from the installed type definitions and sources.

## Owner's checklist (not done by the build)

1. Apply `supabase/migrations/20260920000000_scenarios.sql` to the project.
2. Auth, Providers: enable GitHub (client id and secret of a GitHub OAuth app whose callback is
   `https://<project>.supabase.co/auth/v1/callback`).
3. Auth, URL configuration: site URL, and `https://<site>/auth/callback` in the redirect
   allow-list (plus `http://localhost:3000/auth/callback` for development).
4. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`.
   `SUPABASE_SERVICE_ROLE_KEY` is not needed.

## Evidence

- `npx vitest run tests/store tests/api`: all files pass; `tests/store/migration.test.ts` runs 29
  role-switched cases under each of the two default-grant regimes.
- Mutation checks done by hand on the migration, each restored afterwards: `WITH CHECK (true)`
  fails 4 tests; adding `unlisted` to the read policy fails 6; dropping `FORCE` and the function
  revoke fails 4; removing the visibility test in the function fails 2.
- Coverage of `src/lib/store/**` from those suites: 99 % lines, 91 % branches.
- Dev server with zero variables: every scenario route 503 `not_configured`,
  `/auth/callback?next=//evil.example` redirects to `/lab?auth_error=not_configured` on the same
  origin, `connect-src 'self'` unchanged.
