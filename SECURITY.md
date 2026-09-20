# Security policy

## Supported versions

| Version                     | Supported                 |
| --------------------------- | ------------------------- |
| `0.1.x` (the `main` branch) | yes, fixes land on `main` |
| anything older, or any fork | no                        |

There is one line of development. A fix is released by merging it to `main`; a deployment picks it
up with its next build.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting on the repository:

<https://github.com/MStanislavov/rls-leak-tester/security/advisories/new>

(the repository's **Security** tab, then **Report a vulnerability**). Do not open a public issue
for something exploitable, and please do not test against a deployment you do not own; a local
`npm run dev` reproduces everything, including the API routes.

Helpful in a report: the commit, the route or module, a scenario JSON or request that reproduces
it, and what you expected instead. A wrong verdict counts as a security bug here: a scenario that
reports `ISOLATED` although a persona can reach a row outside its expected set is the most serious
class of defect this project can have.

This is a small open-source project maintained by one person: reports are read as soon as
possible, and there is no bounty programme.

## Threat model

### What runs where

- **User SQL executes only in the user's own browser tab.** Schema, seed and probe SQL run in
  PGlite, a Postgres compiled to WebAssembly, inside a Web Worker. **The server never executes user
  SQL**: nothing this project deploys loads a Postgres engine or accepts SQL to run (rules.yaml
  principle P3). The exported CI proof runs in the user's own CI against their own Postgres
  service.
- The server side is small: `POST /api/explain` (forwards a validated slice to the model),
  the `/api/scenarios` routes and `/auth/*` (only with Supabase configured), and `GET /api/health`
  (build id and feature flags as booleans, never a value).
- With zero configuration there is no server-side state at all: scenarios live in the browser's
  `localStorage`.

### Opening someone else's scenario

A shared scenario (`/s/<slug>`) runs **its author's SQL in your tab**. It runs in sandboxed
WebAssembly in a worker: no network access, no access to the page, its storage or your files. What
it can do is burn CPU. Every probe therefore has a timeout (5 seconds) and a run a ceiling (60
seconds); PGlite cannot cancel a query, so on a timeout the worker is terminated, a new one is
started, setup is replayed and the probe is marked inconclusive. The page stays responsive.
Scenario JSON is validated with zod on every load (file import, local storage, share, cache), and
scenario text, query results and error messages are rendered as text, never as HTML; the code base
contains no `dangerouslySetInnerHTML` and no `innerHTML` (rule SEC-001, enforced by ESLint and the
rules check).

### What leaves the browser

Nothing while editing or running. Only on request:

- **Explain**, offered on failing cells only, sends the minimum for that one cell: the table's DDL
  rendered from the catalog, all policies on that table, the grants of the persona's role, the role
  and claims, the operation, capped samples of expected and actual keys, and the static findings on
  that table. It never sends `schemaSql`, `seedSql`, a whole scenario or the insert probes (they
  inline seed values); the request schema is strict and refuses such fields with `400`. The payload
  is capped at 30 720 bytes, counted while reading. The UI shows the exact payload before sending.
  The slice is forwarded to Anthropic's API. Personas' claims are plain JSON the user typed; the
  docs tell users never to paste a real token or production rows.
- **Share** stores the scenario (schema and seed SQL included) in the deployment's Supabase
  project so that others can open it.
- **Server logs** hold one JSON line per request: outcome, status, duration, model id, a SHA-256 of
  the normalised request, sizes and an error class name. No field can hold SQL, claims, keys, a
  user id or a client address. The AI SDK's default error logging is switched off because its error
  objects carry the request body.

### Prompt injection

- All SQL and every string in an Explain request is **untrusted data**. The system prompt says
  that the engine already proved the failure, that the model never declares a verdict, and that
  text inside the single `<untrusted_data>` block is never an instruction. The request is embedded
  as JSON with `<` and `>` escaped, so no string inside it can close the block.
- **The model never decides a verdict.** Verdicts and cell statuses come only from executed SQL and
  compared row sets. Nothing the model returns is parsed for a status.
- A proposed fix is a proposal. The client applies it to a **copy** of the scenario and re-runs the
  matrix; "Verified fix" appears only if the previously failing cells pass and nothing else
  regressed. Otherwise the UI says "Proposed fix did not pass" and lists the cells.
- Because a successful injection could try to fake that verification (for example a trigger that
  rewrites the seed until "everyone reads everything" is the expected result), **proposals are
  restricted to an allow-list before any re-run**: `CREATE`, `ALTER` and `DROP POLICY`, `GRANT`,
  `REVOKE`, and `ALTER TABLE ... ENABLE | FORCE ROW LEVEL SECURITY` matched as a whole statement.
  Anything else (functions, triggers, `DISABLE ROW LEVEL SECURITY`, column or owner changes, a
  comment inside an `ALTER TABLE`) means the proposal is never re-run, never verified and cannot be
  applied. Statements are split the way Postgres lexes them, so a hidden second statement is a
  syntax error, which counts as "did not pass" (ADR 0024).
- The model's output is validated against a strict schema on the server before it is cached and
  again in the client. An invalid or truncated answer is never cached.

### Rate limiting and fail-closed behaviour

- `/api/explain`: 5 requests per minute per address and 10 per signed-in user. Scenario writes: 20
  per address and 30 per user. The limiter is a sliding window in one Lua script, so check and
  increment are atomic across instances. A refused request gets `429` with `Retry-After` and
  `RateLimit-*` headers. A cache hit still costs one unit.
- Identical questions are answered from a 7 day cache keyed by a SHA-256 over the normalised
  request, the model id and the prompt version; a single-flight lock makes concurrent identical
  requests produce one model call. Output tokens are capped per call.
- **Production refuses to enable `/api/explain` without `REDIS_URL`** (`503 not_configured`),
  because the in-memory limiter is per process and an unmetered model endpoint is a cost risk.
- **Redis configured but unreachable: fail closed.** `/api/explain` and scenario writes answer
  `503` before any model call or database write. There is no silent fallback to the in-memory
  adapters. The one exception is the read-through cache for shared scenarios, which fails open
  because it is an optimisation: the row is then loaded from the store.
- Writes additionally refuse cross-site requests (`Sec-Fetch-Site`), bodies over 1 MiB, and bodies
  that name a `slug`, `id` or `owner`. The per-address limit runs before the session check, so
  forged cookies are limited before they cost a call to Supabase Auth.
- Rate-limit subjects are stored in Redis only as truncated SHA-256 digests. Every Redis key has a
  TTL and lives under `rlsleak:{env}:{purpose}:{id}`.

### The trusted-proxy assumption

An anonymous caller is identified by address. The app reads the **last** hop of `X-Forwarded-For`,
the one written by the proxy directly in front of it; the first hop is text the caller controls
and is never read (`src/lib/security/client-address.ts`). This is correct if and only if **exactly
one trusted proxy stands in front of the app and sets or appends `X-Forwarded-For`**: Vercel (which
overwrites the header and forwards no outside hops), or one reverse proxy or load balancer of the
operator's.

- More proxies in front (a CDN before Vercel): all users behind one CDN edge share a bucket.
  Strict, never a bypass.
- No proxy: **`next start` exposed directly to the internet is not a supported public
  deployment.** The header is then whatever the caller sends and the per-address limit can be
  dodged; a route handler has no socket to ask instead.
- `X-Real-IP` is read only when `X-Forwarded-For` is absent. `X-Vercel-Forwarded-For` is not read.

### Sharing and sign-in (only with Supabase configured)

- The session is verified on the server with `auth.getUser()` on every scenario route; row-level
  security is the second line of defence, not the first. There is no service-role client, and the
  migration grants `service_role` nothing, so a leaked service key reads no private scenario
  through the API.
- `public.scenarios` has `ENABLE` and `FORCE ROW LEVEL SECURITY` and explicit grants: owners have
  full access to their own rows, anyone can select `public` rows, and there is deliberately no
  policy for `unlisted`. An unlisted scenario is fetched by exact slug through a `SECURITY DEFINER`
  function with `search_path = ''` that returns explicit columns and never the owner's id. Slugs
  carry 80 random bits and are generated on the server. These policies ship as the app's fourth
  template and are proven by their own exported test, in PGlite and against real Postgres in CI.
- The OAuth return leg accepts a `next` target only when it resolves to the site's own origin.
- Database errors are mapped by SQLSTATE; the database's message text is never forwarded.

### Headers and Content-Security-Policy

Every response carries, in production:

- `Content-Security-Policy` with a per-request nonce: `default-src 'self'`; a `script-src` of
  exactly `'self'`, the nonce and `'wasm-unsafe-eval'` (no `'unsafe-eval'`, no `'unsafe-inline'`);
  `worker-src 'self' blob:`; `connect-src 'self'` plus the configured Supabase origin and nothing
  else; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`;
  `upgrade-insecure-requests`. `style-src` allows `'unsafe-inline'` because React and the toast
  library write inline styles; inline styles cannot execute code. Files under `/_next/static/` get
  a nonce-free policy of the same strictness, which is the one that governs the PGlite worker.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, a `Permissions-Policy` that switches off camera, microphone,
  geolocation, payment, USB and the motion sensors, and `Strict-Transport-Security` with a two
  year max-age.
- No third-party script, font, analytics or tracker is loaded. Fonts are bundled.

The end-to-end suite runs against a production build with this policy active and fails on any CSP
violation.

### Secrets

- No secret is committed: only `.env.example` with empty values. `.env`, `.env.*` and `*.pem` are
  git-ignored; the local SonarQube credentials live in a git-ignored `.env.sonar` with mode 600 and
  are never printed by the scripts.
- `src/lib/config` is the only reader of `process.env` (lint rule ARCH-002). It validates every
  variable with zod at boot; an error names the variable, never its value. The server
  configuration module throws when it is evaluated in a browser, and Next.js only inlines
  `NEXT_PUBLIC_*` variables.
- `ANTHROPIC_API_KEY` and `REDIS_URL` are server only. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is public by
  design. `SUPABASE_SERVICE_ROLE_KEY` is not used and should not be set.
- Tests make no network calls: a guard blocks every non-loopback connection unless
  `RUN_LIVE_AI_TESTS=1`, and the model is mocked.

## Known limits

- One IPv6 caller usually controls a whole /64 and can rotate inside it; addresses are not grouped
  by /64, so the per-address limit is weaker for IPv6 than for IPv4.
- Checking address and user is two limiter calls: a request refused per user has already used one
  unit of the address budget.
- `GET /api/scenarios/by-slug/[slug]` is not rate limited, and misses are not cached.
- The Supabase anon key is public, so a signed-in user can call PostgREST directly. Row-level
  security and the check constraints hold there, but the API's rate limit, slug generator and
  scenario validation do not apply (such a row can carry a vanity slug or a payload the app reports
  as corrupt), and there is no per-user row quota in the database.
- The owner id of a **public** scenario is readable through the table itself (`select` for `anon`
  plus the public-read policy). Closing that needs column-level grants.
- The server may cache a model answer whose SQL the client then refuses as outside the allow-list.
  That is harmless (the client shows it as not tested) but wastes a cache entry.
- A local Supabase stack on `http://` gets no `connect-src` entry: the policy builder accepts
  `https://` origins only.
- `npm audit` reports `adm-zip` advisories through the development-only `@sonar/scan`; it never
  reaches the production bundle. Reasoning and follow-up are in `docs/sonar-triage.md`.
- Not verified by the build, because each needs an account: a live Anthropic stream and its
  refusal fallback, a real Supabase project (PostgREST and Auth behaviour), and
  `redis.call('TIME')` inside Lua on a managed Redis. `docs/DEPLOY.md` has the checks for the owner.
