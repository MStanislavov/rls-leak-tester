# Progress log

One entry per phase: what was done, what was verified and how, open issues. Newest entry last.

## Phase 0: preflight, plus the scaffold pulled forward from Phase 2 (2026-09-19)

### Prerequisites recorded

| Item    | Value                                                                                  | Check                 |
| ------- | -------------------------------------------------------------------------------------- | --------------------- |
| Node.js | v26.8.1                                                                                | `node -v`             |
| npm     | 11.19.0                                                                                | `npm -v`              |
| Machine | macOS 26.5.1, arm64                                                                    | `sw_vers`, `uname -m` |
| Docker  | 29.5.2 installed; the daemon is started by the orchestrator and answered `docker info` | `docker info`         |
| pnpm    | not installed, npm is used                                                             |                       |
| git     | 2.54.0, repository already initialised on `main`                                       | `git --version`       |

### Done

- Next.js 16.3.5 scaffold (App Router, TypeScript, Tailwind 4, ESLint flat config, `src/`, alias
  `@/*`), created non-interactively in a temporary directory and moved in. `.gitignore` merged:
  every earlier entry kept.
- `package.json`: name, version 0.1.0, MIT, the one-line description, `engines.node >=22.22.2`,
  scripts `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:coverage`, `e2e`, `format`,
  `format:check`.
- Every dependency the build plan needs is installed (list with exact versions in
  `docs/adr/0001-stack.md`), so later phases do not run `npm install`.
- Strict TypeScript (6.0.3) with extra safety flags, Prettier with `eslint-config-prettier`,
  Vitest config with the 80 percent line and branch thresholds on `src/lib/**`.
- shadcn/ui (radix base, style `radix-nova`) with button, card, tabs, dialog, sheet, select, input,
  label, textarea, badge, tooltip, dropdown-menu, separator, scroll-area, table, alert, switch and
  sonner. The shadcn stylesheet was ejected into `src/app/shadcn-tailwind.css`.
- Playwright 1.63.0 with Chromium (build 1243) downloaded. No config yet: Spike B owns it.
- Neutral placeholder home page; metadata title `RLS Leak Tester` and the product description.
- `.env.example` with every variable from section 4.8, all empty. `LICENSE` (MIT).
- `docs/adr/0001-stack.md` records the versions and nine places where reality differed from the
  brief (TypeScript 6 instead of 7, ESLint 9 instead of 10, the Node engine floor, npm's install
  script gate, `next typegen` in `typecheck`, `vitest.config.mts`, shadcn 4 changes, local Geist
  fonts, the generated `AGENTS.md`).

### Verified (commands run on Node v26.8.1, output read)

| Command                                    | Result                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `rm -rf node_modules && npm ci`            | exit 0, 623 packages added from the lockfile, no install-script warnings                 |
| `npm run lint`                             | exit 0, no findings                                                                      |
| `npm run typecheck`                        | exit 0 (`next typegen` then `tsc --noEmit`)                                              |
| `npm run build`                            | exit 0, Turbopack, routes `/` and `/_not-found` prerendered                              |
| `npm test`                                 | exit 0, "No test files found, exiting with code 0"                                       |
| `npm run test:coverage`                    | exit 0 with no tests (0/0)                                                               |
| `npm run format:check`                     | exit 0, "All matched files use Prettier code style!"                                     |
| `next start` then `curl /`                 | HTTP 200, `<title>RLS Leak Tester</title>`, the description meta tag, Geist font applied |
| `next dev` then `curl /`                   | HTTP 200, `AGENTS.md` and `CLAUDE.md` unchanged afterwards                               |
| PGlite in Node: `select version()`         | `PostgreSQL 18.3 (PGlite 0.5.8)`                                                         |
| `npx tsx -e ...`, `require("ioredis")`     | both run on Node 26                                                                      |
| `npx shadcn@latest add checkbox --dry-run` | resolves after the eject, needs no new dependency                                        |

The coverage thresholds were proven live, not assumed: a throwaway module with one covered branch
under `src/lib/` made `vitest run --coverage` exit 1 with "Coverage for lines (37.5%) does not meet
global threshold (80%)" and the same for branches. The same run proved the `@` alias resolves. The
throwaway files were deleted afterwards.

### Open issues

- `npm audit` right after the install: 2 findings (1 moderate, 1 high), one chain, `adm-zip`
  `<=0.6.0` through the development-only `@sonar/scan`, "no fix available". A later re-run,
  including `npm audit --omit=dev`, could not complete because the registry audit endpoint answered
  503 (maintenance). Re-run in Phase 8.
- Husky and lint-staged are installed but not wired (`prepare` script and `.husky/` belong to
  Phase 2 governance).
- `src/app/favicon.ico` is still the `create-next-app` default.
- The Phase 2 `CLAUDE.md` must keep the `@AGENTS.md` import line that `create-next-app` wrote.

## Phase 1: the two spikes (2026-09-19)

Both assumptions that carry the product are proven, by the authors and then by an independent
reviewer agent (two rounds: round 1 found five gaps, all closed and re-verified in round 2).

### Spike A: RLS inside PGlite (ADR 0002) — proven

- PGlite 0.5.8 is PostgreSQL 18.3. Roles, grants, ENABLE/FORCE RLS, policies, role switching and
  `request.jwt.claims` all work; a non-superuser role is really filtered while the superuser, a
  `BYPASSRLS` role and a table owner (without FORCE) are not.
- Real Supabase shim in `src/lib/engine/supabase-shim.ts` (roles, `auth.uid/role/jwt/email`,
  default grants), proven with a leaky and a correct policy.
- Findings later phases must honour: `SET LOCAL ROLE` cannot be parameterised (use
  `set_config('role', $1, true)`); always use `tx` inside `db.transaction`; SQLSTATE is `error.code`;
  42501 covers both policy violations and missing grants; apply default grants BEFORE the user's
  schema; the scope-escape probe needs two shapes (with and without `WHERE pk`); Supabase's blanket
  default grants are the legacy regime (explicit grants are enforced for all projects from
  2026-10-30), so scenarios need an option; `statement_timeout` is NOT enforced by PGlite.

### Spike B: PGlite inside Next.js (ADR 0003) — proven in dev and in production

- PGlite runs in a Web Worker on `/lab` under Turbopack in `next dev` and `next build && next start`;
  no `/public/pglite` fallback needed. `experimental.turbopackScopeHoisting: false` is load-bearing.
- Strict production CSP through `src/proxy.ts` with a per-request nonce:
  `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, no `unsafe-eval`.
  Consequence: every route must render dynamically (root layout awaits `connection()`).
- The only working query timeout is `worker.terminate()` from the main thread; a new worker is an
  empty database, so the runner must replay setup after a timeout.
- `/` requests no PGlite asset.

### Verified

| Command             | Result                                                       |
| ------------------- | ------------------------------------------------------------ |
| `npm run lint`      | exit 0                                                       |
| `npm run typecheck` | exit 0                                                       |
| `npm test`          | 5 files, 93 tests passed (orchestrator re-run)               |
| `npm run e2e:dev`   | 6/6 passed (independent reviewer)                            |
| `npm run e2e`       | production build, 6/6 passed, zero CSP violations (reviewer) |
| `curl -sI` on prod  | CSP header present and strict on `/` and `/lab` (reviewer)   |

### Open issues

- `npm audit`: high-severity `adm-zip` advisory via dev-only `@sonar/scan`; revisit in Phase 8.
- `src/proxy.ts` and `next.config.ts` read `process.env.NODE_ENV`; the Phase 2 rule "only
  `src/lib/config` reads `process.env`" must handle these two files explicitly.

## Phase 2: governance (2026-09-19)

### Done

- `src/lib/config`: the only reader of `process.env`; zod-validated, lazy, never prints values;
  feature flags (`explainEnabled` is false in production without `REDIS_URL`); edge-safe
  `runtime.ts` for `src/proxy.ts`. 100 percent covered.
- ESLint boundaries as errors with rule ids in the messages (ARCH-001, ARCH-002, ARCH-004,
  CODE-001, CODE-002, SEC-001), `eslint --max-warnings 0`.
- `docker-compose.yml`: `redis:7-alpine` (no persistence, healthcheck) and `sonarqube:community`
  (native arm64, named volumes). Redis start and healthcheck proven; SonarQube starts in Phase 8.
- `rules.yaml` (principles, 24 rules, thresholds, exclusions with reasons, forbidden actions,
  definition of done) and `scripts/rules-check.mjs` (schema validation, 15 script rules, full and
  fast mode), with a violating and a clean fixture per script rule.
- A Vitest network guard (`tests/setup/network-guard.setup.ts`) blocks non-loopback connections in
  tests unless `RUN_LIVE_AI_TESTS=1` (TEST-001).
- `CLAUDE.md`, `.claude/settings.json` (allow/deny lists, pre-edit and post-edit hooks in
  `scripts/hooks/`), `.claude/agents/security-reviewer.md` (read-only), Husky with lint-staged and a
  conventional-commit `commit-msg` hook. Hooks were exercised with piped payloads and with three
  real headless `claude -p` sessions.
- ADRs 0004 to 0008.

### Verified (orchestrator re-run after the last change)

| Command                 | Result                                                          |
| ----------------------- | --------------------------------------------------------------- |
| `npm run format:check`  | exit 0                                                          |
| `npm run lint`          | exit 0, zero warnings                                           |
| `npm run typecheck`     | exit 0                                                          |
| `npm run rules`         | `rules-check (full): ok, 15 script rules, 111 files`            |
| `npm run test:coverage` | 20 files, 632 tests passed; lines 96.13, branches 98.14 percent |

Independent mutation testing (three review rounds): 24 deliberate violations caught by the named
enforcer.

### Open issues (accepted or scheduled)

- Scheduled with Phase 3: SEC-002 must also treat `params` / `searchParams` in pages as input;
  ARCH-001 / ARCH-004 must resolve relative imports that pass through an intermediate directory and
  the computed-member spellings of the network globals.
- Accepted as known limits (the rules guard against accidents, review guards against intent):
  abbreviated git long options in the permission deny list, package.json script pinning beyond the
  test scripts, Vitest config keys that skip tests, network access from worker threads or child
  processes started by a test, a Pages Router directory (the project is App Router only).
- Still open from Phase 1: `npm audit` advisory via dev-only `@sonar/scan` (Phase 8); boot-time
  config validation through `src/instrumentation.ts` (Phase 6, with the first server route).

## Phase 3: the core library (2026-09-20)

### Done

- `src/lib/scenario`: types, strict zod 4 schemas (`parseScenario`), defaults, column heuristics,
  claims helpers, a psql-faithful SQL statement splitter, identifier/literal quoting, stable
  serialisation (ADR 0010).
- `src/lib/engine` + `src/lib/runner/{setup,introspect,ground-truth}`: `SqlEngine` port, PGlite
  adapter for Node and the worker, setup pipeline (shim, grants BEFORE the user's schema,
  statement-by-statement errors with SQLSTATE and line), catalog introspection, ground truth
  (ADR 0011).
- `src/lib/runner`: probe builders shared with the future export, the matrix runner (SELECT /
  UPDATE / DELETE reach with per-row fallback, two scope-escape shapes, INSERT classes, custom
  scope), classifier, verdict (`ISOLATED` / `LEAKING` / `NOT PROVEN`), deterministic result JSON,
  progress + cancellation, engine rebuild after a timeout (ADRs 0012, 0016).
- `src/lib/checks`: RLS001..RLS009 with documentation links, a positive and a negative fixture per
  rule (ADR 0013).
- Three templates in a leaky and a fixed variant with explicit expectations and declared expected
  failures (ADR 0014).
- Golden tests: exact failing cells per leaky variant, `ISOLATED` for fixed variants, full JSON
  snapshots, byte-identical second run, replay of every failing cell without the runner, database
  dump identical before and after a run (ADR 0015). Runner output and template declarations agreed
  on the first run: 6 variants, 304 cells, 0 disagreements.
- Three independent lens reviews (RLS semantics, robustness/determinism, spec conformance) found 18
  reproduced defects (13 blockers, 5 majors; 12 root causes), among them ways to get a false
  `ISOLATED`. Every one was first written as a failing test, then fixed (ADR 0016).
- Governance follow-up: SEC-002 covers `params` / `searchParams` in pages, a resolver-based ESLint
  boundary rule, computed-member spellings of the network globals, accepted limits (ADR 0009).

### Verified (orchestrator re-run)

| Command                             | Result                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| `npm run format:check`              | exit 0                                                           |
| `npm run lint`                      | exit 0, zero warnings                                            |
| `npm run typecheck`                 | exit 0                                                           |
| `npm run rules`                     | `ok, 15 script rules, 289 files`                                 |
| `REDIS_URL=… npm run test:coverage` | 89 files, 1845 tests passed; lines 98.96, branches 96.95 percent |

Full matrix run in Node (median of 7, fresh PGlite each): 405 to 471 ms per template variant, of
which about 380 ms is setup; a cell takes about 1 ms.

## Phase 6, server side (built alongside Phase 3, 2026-09-20)

- `src/lib/redis`: ports `RateLimiter`, `Cache`, `Lock` with a Redis and an in-memory adapter each,
  one Lua sliding-window limiter, the single key builder (`rlsleak:{env}:{purpose}:{id}`, every
  write with a TTL), fail-fast lazy client, `RedisUnavailableError`, single-flight and read-through
  helpers. One contract suite: 135 tests hermetic, 169 against real Redis (ADR 0017).
- `src/lib/ai` + `/api/explain` + `/api/health` + `src/instrumentation.ts`: validated 30 KB payload
  without seed data, untrusted-data prompt, rate limit, cache, single-flight, streamed structured
  output, fail-closed 503, model id only in `model.ts`; all tests use a mocked model (ADR 0018).
- Not verified: a live Anthropic stream (no key here, by design). The lab UI for Explain and the
  verified-fix loop follow in Phase 5/6 UI work.

## Phases 4 to 7: export, lab UI, explain UI, sharing (2026-09-20)

### Done

- **Phase 4, CI export** (`src/lib/export`, ADR 0019): `generateCiExport` emits
  `rls-isolation.test.sql` (plain SQL, one block per cell, the runner's own probe builders, every
  probe in a rolled-back subtransaction, one final exception listing all failed cells),
  `rls-isolation.yml` (Postgres 18 service, `psql -v ON_ERROR_STOP=1`, `contents: read`) and, as a
  documented deviation, the setup / schema / seed files it loads. Tested by executing the output:
  fixed variants pass, leaky variants fail on exactly the declared cells, in PGlite and against real
  Postgres 18.4 and 17.11 in Docker (`scripts/verify-export-postgres.sh`).
- **Phase 5, lab UI** (ADRs 0022, 0025, 0027): app shell, landing page, `/docs`, the `/lab`
  workbench (CodeMirror editors, personas, tables and expectations with visible defaults, Run with
  progress and Cancel through the Web Worker engine with probe timeout and run ceiling, verdict
  banner, ARIA grid matrix with icon + text cells and keyboard navigation, details drawer with the
  probe transcript, static findings, setup errors with SQLSTATE next to the statement, local save,
  import/export JSON, Export CI check dialog, themes).
- **Phase 6, client side** (ADR 0023): Explain on failing cells only, "what leaves your browser"
  preview, streamed answer, and the verified-fix loop: a proposal is applied to a copy, the matrix
  is re-run, and "Verified fix" appears only when the target cells pass and nothing regressed.
- **Phase 7, sharing** (ADRs 0020, 0021, 0026): `ScenarioStore` port with localStorage and remote
  adapters, `supabase/migrations` with FORCE RLS, explicit grants and a pinned-`search_path`
  `SECURITY DEFINER` lookup for unlisted slugs, `/api/scenarios` routes with server-side `getUser()`
  checks, rate limits and a read-through cache, GitHub sign-in plumbing, `/s/[slug]` read-only page
  with Fork, Share disabled with an explanation when Supabase is not configured. The fourth template
  is the app's own `scenarios` table (drift-guarded against the migration) and the self-isolation
  proof executes its exported test in PGlite and in real Postgres.
- One review round (security, UX/accessibility conformance, export-vs-runner drift): 7 major
  findings reproduced and fixed with a failing test first (ADR 0024): rate-limit identity taken from
  a client-controlled `X-Forwarded-For` hop; "Verified fix" obtainable by masking seed data with a
  trigger (proposals are now restricted to policy / grant / RLS statements before any re-run);
  volatile seed keys, later-added UPDATE grants, later-added tables and cross-session state in the
  export; a screen-reader verdict announcement that hid "cancelled" and "stale".

### Verified (orchestrator re-run on the final tree)

| Command                             | Result                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| `npm run format:check`              | exit 0                                                            |
| `npm run lint`                      | exit 0, zero warnings                                             |
| `npm run typecheck`                 | exit 0                                                            |
| `npm run rules`                     | `ok, 15 script rules, 463 files`                                  |
| `REDIS_URL=… npm run test:coverage` | 125 files, 2517 tests passed; lines 99.06, branches 96.17 percent |
| `npm run e2e` (production build)    | every route dynamic; 59 Playwright tests passed                   |
| `npm run e2e:dev`                   | 59 passed (final-gate agent)                                      |

A load-dependent flake was removed: suites that boot real PGlite exceeded Vitest's default hook
timeout when every worker booted WASM at once; `vitest.config.mts` now sets watchdog timeouts.

### Open (minor review findings, scheduled with Phase 8/9)

- Store privacy polish: invalidate the slug cache on visibility change; `get_scenario_by_slug`
  should not return the owner id to anonymous callers; server-side timestamps on insert.
- A failed custom `expectedRowsSql` should show its statement; timed-out cells need their own label;
  wording of the export's final message and "database unchanged" note (identity sequences advance).
- The landing page ships a zod chunk (96 KB gzip) it does not need.
- Not verifiable here: the exported workflow on GitHub's runners, a live Anthropic stream, a real
  Supabase project (all account-bound).
