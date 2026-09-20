# Changelog

All notable changes to RLS Leak Tester are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

The first version. Nothing has been tagged, published or deployed yet; the release date replaces
"Unreleased" when it is.

### Added

- **The lab (`/lab`)**: CodeMirror editors for schema and seed SQL, personas (database role plus
  JWT claims and a tenant claim path), tables with suggested owner and tenant columns, and an
  expectation per persona, table and operation (`none`, `own`, `tenant`, `all`, `custom` with its
  own query) with visible defaults. Run with progress and Cancel, keyboard-navigable result matrix
  with icon and text per cell, details drawer with the probe transcript, dark and light themes.
- **In-browser Postgres**: PGlite (PostgreSQL 18, WebAssembly) in a Web Worker, loaded only on
  `/lab` and `/s/[slug]`. A fresh database per run, a probe timeout of 5 seconds and a run ceiling
  of 60 seconds enforced by terminating and rebuilding the worker.
- **Matrix runner**: `SELECT`, `UPDATE` and `DELETE` reach, two shapes of the `UPDATE` scope
  escape, and `INSERT` per scope class. Every probe runs under the persona's role and claims in a
  rolled-back transaction, never as a superuser, a table owner or a `BYPASSRLS` role. Cell statuses
  `pass`, `leak`, `escape`, `overblock`, `inconclusive` (timeouts labelled as such) and `skipped`;
  verdicts `ISOLATED`, `LEAKING` and `NOT PROVEN`; byte-identical result JSON for the same
  scenario. Setup errors are shown with SQLSTATE and message next to the failing statement.
- **Supabase mode**: a shim with the roles `anon`, `authenticated` and `service_role`, the `auth`
  schema with `auth.uid()`, `auth.role()`, `auth.jwt()` and `auth.email()`, and a choice between
  Supabase's legacy default grants and the explicit-grants regime. Plain Postgres mode with custom
  roles.
- **Static checks `RLS001` to `RLS009`** from the catalog, each with severity, object, explanation
  and a documentation link.
- **Templates**, each in a leaky and a fixed variant with explicit expectations: multi-tenant SaaS,
  team workspace, todos with sharing, and the application's own `scenarios` table.
- **CI export**: `rls-isolation.test.sql` (plain SQL built from the runner's own probe builders,
  one rolled-back block per cell, one final exception listing every failed cell), the setup, schema
  and seed files it loads, and a GitHub Actions workflow with a Postgres service.
- **Explain with a verified fix** (optional, `ANTHROPIC_API_KEY`): a minimal, capped and validated
  slice of one failing cell is sent to the model, the structured answer streams into the UI, and a
  proposed fix is applied to a copy and re-run. "Verified fix" appears only when the failing cells
  pass and nothing regressed; proposals outside a policy, grant and RLS statement allow-list are
  never re-run or applied.
- **Redis layer** (optional, `REDIS_URL`): rate limiter (atomic Lua sliding window), explanation
  cache, single-flight lock and shared-scenario cache behind ports with a Redis and an in-memory
  adapter each. Fail closed with `503` when a configured Redis is unreachable; `/api/explain`
  stays disabled in production without `REDIS_URL`.
- **Saving and sharing**: local save in `localStorage`, JSON import and export; optional Supabase
  store with GitHub sign-in, `public`, `unlisted` and `private` visibility, the read-only page
  `/s/[slug]` with "Fork to my lab", and a migration with forced RLS, explicit grants and a
  `SECURITY DEFINER` lookup for unlisted slugs.
- **API**: `POST /api/explain`, the `/api/scenarios` routes, `/auth/callback`, `/auth/signout` and
  `GET /api/health` (feature flags as booleans only), all on the Node.js runtime.
- **Security**: Content-Security-Policy with a per-request nonce (`'wasm-unsafe-eval'`, no
  `'unsafe-eval'`), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `X-Frame-Options`, `Strict-Transport-Security`; nothing is rendered as HTML; rate-limit identity
  from the last `X-Forwarded-For` hop under a one-trusted-proxy assumption; logs without SQL,
  claims or addresses.
- **Landing page and `/docs`**: how it works, probe semantics, statuses, static checks, threat
  model, privacy and limits. The landing page loads no PGlite asset.
- **Quality system**: `rules.yaml` with its checker (`npm run rules`), ESLint architecture
  boundaries, Vitest unit and integration suites with golden snapshots, bypass guards and an 80
  percent line and branch threshold, Playwright end-to-end tests with accessibility scans against
  the production build, the self-isolation proof, the local SonarQube quality gate "RLS Leak
  Tester" and the single gate command `npm run quality`, GitHub Actions CI and Dependabot.
- **Documents**: `README.md`, `SECURITY.md`, `docs/DEPLOY.md`, the decision records under
  `docs/adr/`, `docs/PROGRESS.md` and `docs/sonar-triage.md`.
