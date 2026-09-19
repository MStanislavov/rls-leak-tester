@AGENTS.md

<!-- The line above imports the Next.js agent rules. `next dev` owns the managed block inside
AGENTS.md: keep the import, never edit that block. -->

# RLS Leak Tester: working in this repository

A Next.js app that answers one question with evidence: do these Postgres row-level security
policies keep users and tenants apart? The user pastes a schema and personas; the app runs a
persona x table x operation matrix against PGlite (a real Postgres 18) inside a Web Worker in
their browser, shows which rows leaked, and exports the same checks as a CI job.

**Core principle (rules.yaml P1): deterministic verdicts, the AI only explains.** Every pass, leak
and verdict comes from executing SQL and comparing row sets. The LLM never decides a verdict, and
a proposed fix is called verified only after the matrix was re-run with it and the cells pass.

`rules.yaml` is binding. It holds the principles (P1..P9), the rules by id (ARCH, CODE, SEC, RUN,
TEST, REDIS, AI, QUAL, GIT, DOCS), the thresholds, every exclusion with its reason, the forbidden
actions (FA-1..FA-7) and the definition of done. When this file and `rules.yaml` disagree,
`rules.yaml` wins; fix this file. Decisions and measured facts are in `docs/adr/`; the state of the
build is in `docs/PROGRESS.md`. Read both before a larger change.

## Commands

| Command                         | What it does                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run dev`                   | Dev server (Turbopack). Works with zero environment variables (P4)                         |
| `npm run lint`                  | ESLint, flat config, `--max-warnings 0`; boundary messages carry their rule id             |
| `npm run typecheck`             | `next typegen && tsc --noEmit`. Never plain `tsc`: the route types come first              |
| `npm run rules`                 | `scripts/rules-check.mjs`, full mode: validates rules.yaml and runs its checks             |
| `npm run rules:fast -- <files>` | The same checks for a few files (what the hooks and lint-staged run)                       |
| `npm test`                      | Vitest, unit and integration (`src/**/*.test.ts(x)`, `tests/**/*.test.ts`)                 |
| `npm run test:coverage`         | The same with the 80 percent line and branch thresholds on `src/lib/**`                    |
| `npm run e2e`                   | Production build, then Playwright with the strict CSP                                      |
| `npm run e2e:dev`               | Playwright against `next dev`                                                              |
| `npm run format`                | Prettier over the repository; `format:check` only checks                                   |
| `npm run quality`               | The full local gate including SonarQube. Arrives in Phase 8; until then run the list below |
| `docker compose up -d redis`    | Local Redis for the contract suite; `sonarqube` is the second service                      |

## Running the gate

In this order, each one green before the next: `npm run format:check`, `npm run lint`,
`npm run typecheck`, `npm run rules`, `npm run test:coverage`, `npm run e2e`. From Phase 8 on
`npm run quality` runs all of it plus the Sonar scan and the quality gate "RLS Leak Tester". Say
that something passed only if you just ran it and read the output (P2, FA-7). A red gate is fixed
in the code, never by loosening a test, a lint rule, a threshold or an exclusion (QUAL-002, FA-6).

## Architecture map

```
src/app/              routes and API handlers, thin (ARCH-003: a route.ts has at most 80 lines)
src/components/       UI (shadcn/ui, CodeMirror)
src/lib/scenario/     PURE  types, zod schemas, templates, defaults
src/lib/runner/       PURE  matrix runner, probe builders, outcome classifier
src/lib/checks/       PURE  static checks RLS001..RLS009
src/lib/export/       PURE  SQL test and CI workflow generators
src/lib/engine/       SqlEngine port, PGlite adapter, worker client, Supabase shim
src/lib/redis/        ports with two adapters each (Redis, in-memory): limiter, cache, lock
src/lib/ai/           model config, prompt, schema, route logic
src/lib/store/        ScenarioStore port: localStorage and Supabase adapters
src/lib/security/     CSP and header builders (pure)
src/lib/config/       the only reader of process.env: env.ts, server.ts, public.ts, runtime.ts
src/proxy.ts          per-request nonce CSP (the Next.js 16 name for middleware)
supabase/migrations/  SQL-first schema and policies of the optional store
tests/                fixtures and integration suites; unit tests sit beside the code
e2e/                  Playwright
scripts/              rules check, hooks, spikes, sonar bootstrap
```

Boundaries, enforced by ESLint and the rules check, not by intention:

- ARCH-001: the four PURE directories load no React, `next/*`, `@/app`, `@/components`,
  `ioredis`, `@supabase/*`, `ai`, `@ai-sdk/*`, `node:fs`, `node:http`, `node:http2`, `node:dns`
  and friends, nothing from `@/lib/redis`, `@/lib/ai`, `@/lib/store` or `@/lib/config` (except
  the pure parser `@/lib/config/env`), by alias or relative path, through `import`, `import()` or
  `require()`, and use no `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `sendBeacon`.
  This covers their test files, `.cjs` files and type-only imports too: a test that needs the file
  system or a DOM lives in `tests/`. Pure code takes values and ports as parameters.
- ARCH-002: only `src/lib/config` reads `process.env`, and nothing else under `src/` touches the
  `process` object at all (an alias such as `const p = process` is an error). Server code calls
  `getServerConfig()`, client code `getPublicConfig()`, `src/proxy.ts` uses `runtime.ts`, pure
  code takes parameters.
- ARCH-004: `src/lib/**` never imports from `src/app` or `src/components`.
- SEC-004 is an allow-list: PGlite, a Postgres driver or `src/lib/engine` is value-imported only
  by `src/lib/engine`, a module whose first statement is `"use client"`, and tests. Never by a
  route handler, `src/app/api`, `src/lib/ai`, `src/lib/redis`, `src/lib/store`, or any file with
  a `"use server"` directive, and not by `src/lib/runner` either: server code may import the
  runner, so the runner takes the `SqlEngine` port as a parameter (`import type`) and a
  `"use client"` module or the worker under `src/lib/engine` passes the engine in. Runner tests
  may use PGlite. User SQL never runs on a server (P3, FA-4).
- SEC-002: a non-test file under `src/` that reads `.json()`, `.formData()`, `.text()`,
  `.arrayBuffer()`, `.blob()`, `.bytes()`, `JSON.parse(`, `localStorage.getItem(`, a header
  (`.headers.get(`, `headers().get(`), a cookie, or `formData.get(` / `searchParams.get(` (in a
  route also `searchParams` or `params`) must parse with zod or an imported `parse*` /
  `validate*` function from `src/lib`. A Server Function is such a boundary too: a file with a
  `"use server"` directive whose async functions take arguments must validate them, whatever the
  TypeScript signature says.
- TEST-001 has two layers: the rules check reads test files for real URLs, and
  `tests/setup/network-guard.setup.ts` (a Vitest setup file) blocks every connection that is not
  loopback and fails the test that tried one, even if the error was swallowed. Only
  `RUN_LIVE_AI_TESTS=1`, set by whoever starts the run, lifts it: the guard reads the switch once
  at install time, and a test, a setup file, `vitest.config.mts` or an npm script that sets it
  fails the rules check. Never remove the setup file from `vitest.config.mts`.
- The six ESLint-only rules are pinned by `tests/eslint/boundaries.test.ts`. Flat config replaces
  rule options instead of merging them, so a governed rule (`no-restricted-imports`,
  `no-restricted-syntax`, `no-restricted-globals`, `react/no-danger`, the two TypeScript rules) is
  named only in the `rules/*` blocks of `eslint.config.mjs`: add a selector to the shared lists
  there, never a new block for a sub-path. A governed rule outside those blocks, or set to
  `"warn"` or `"off"`, fails the rules check (QUAL-002); so does deleting or skipping that suite,
  `tests/setup/network-guard.test.ts` or `tests/hooks/governance.test.ts`, narrowing
  `test.include`, or giving `npm test` a file filter.
- Fixed places the rules check looks for: the Redis key builder `src/lib/redis/keys.ts`
  (`rlsleak:{env}:{purpose}:{id}`, every write with a TTL, client use only in
  `src/lib/redis/adapters/`, REDIS-001); the model id only in `src/lib/ai/model.ts` (AI-001); the
  bypass-guard suite named `*bypass-guard*.test.ts` under `src/lib/runner` or `tests/` (RUN-001);
  `src/proxy.ts` calls `buildDocumentCsp(` and `next.config.ts` calls
  `buildStaticSecurityHeaders(` (SEC-005).
- Numbers are not scattered: probe timeout and run ceiling, explain payload cap, cache and lock
  TTLs, rate limits, coverage and gate conditions are `thresholds` in `rules.yaml`. Code and tests
  use those values; changing one means changing `rules.yaml` and writing an ADR.
- QUAL-001: every lint, coverage and Sonar exclusion is listed in `rules.yaml` with a reason, and
  the check compares both directions. Touch `eslint.config.mjs` ignores, a rule set to `"off"`,
  `vitest.config.mts` excludes or `sonar-project.properties` and you update `rules.yaml` in the
  same change. An inline suppression needs its reason in the same comment (`-- why`);
  `@ts-ignore` and `@ts-nocheck` are forbidden.

## Traps (each one cost time once; details in docs/adr/0002 and 0003)

1. **Three ways RLS silently does not apply**: a superuser, a table owner without
   `FORCE ROW LEVEL SECURITY`, a role with `BYPASSRLS` (Supabase's `service_role`). PGlite's
   default user is a superuser, so a probe that forgets the role passes every leaky scenario.
2. **Switching role**: `SET LOCAL ROLE` takes no parameter. Use
   `select set_config('role', $1, true)` and `set_config('request.jwt.claims', $1, true)` inside
   the transaction, and always roll back (RUN-001, P5). The claims setting is `''`, not `NULL`,
   after first use: guard casts with `nullif(..., '')`.
3. **`db.query` inside `db.transaction` deadlocks.** It never resolves until the transaction
   ends. Inside the callback use the `tx` handle only; `tx.rollback()` in `finally`.
4. **PGlite does not enforce `statement_timeout`** and a running query blocks its thread; there is
   no cancel API. The only timeout is `worker.terminate()` from the main thread. A new worker is
   an empty database: replay schema and seed, mark the probe `inconclusive`. Never call the
   worker's `init` without a timeout, a failed WASM load hangs `PGlite.create()`.
5. **The nonce CSP forces every route to render dynamically** (the root layout awaits
   `connection()`). A route that opts back into static rendering ships scripts without a nonce
   and does not hydrate. `experimental.turbopackScopeHoisting: false` in `next.config.ts` is
   load-bearing: without it PGlite breaks in the production build only. A worker obeys the CSP of
   its own script response, so worker needs go into the asset policy as well.
6. **Routes that touch Redis, the AI module or the store declare
   `export const runtime = "nodejs"`** (REDIS-002). `ioredis` needs TCP.
7. **The `WITH CHECK` subtlety**: without `WITH CHECK`, `USING` is applied to the new row. With
   `WITH CHECK (true)` a user can move rows into another tenant, but a targeted
   `UPDATE ... WHERE pk = x` can still look blocked because the SELECT policy is applied to the
   new row. The scope-escape probe must try both shapes: targeted, then without `WHERE` and
   without `RETURNING`. SQLSTATE `42501` means a policy violation or a missing grant; the code is
   `error.code`.
8. **Supabase default grants have two regimes**: the legacy blanket grants to `anon`,
   `authenticated`, `service_role`, and explicit grants (new projects since 2026-05-30, every
   project from 2026-10-30). A scenario chooses one: the `autoExposeNewTables` option of
   `supabaseDefaultGrantsSql` in `src/lib/engine/supabase-shim.ts`. Apply the default grants
   BEFORE the user's schema, or a user's `REVOKE` is undone and a leak is reported that does not
   exist.
9. **Never call a fix verified without a re-run** (AI-002, FA-5), and never call a check green
   without having just run it (P2).
10. **`next typegen` before `tsc`**: use `npm run typecheck`. Vitest config is `vitest.config.mts`.
    `it.each` titles with `%j` throw on a `bigint`.
11. **No `server-only` package**: `src/lib/config/server.ts` throws when a `window` exists. Test
    fixtures that look like credentials are assembled at run time so SEC-003 does not trip.

## Guard rails in this checkout

- `.claude/settings.json` allows the routine commands and denies pushing, history rewriting,
  `git commit --amend`, `--no-verify` and `-n` (also inside a cluster such as `-nm`), forced
  `git add`, `tag`, `branch`, `checkout` and `switch` (`-f`, `--force`), deployment CLIs and the
  real env files (GIT-002, SEC-003). A commit message that contains ` -n` or ` -f` is refused as
  well: reword it.
  Bash rules match command text only; they are a seat belt, the forbidden actions still apply.
- PreToolUse `scripts/hooks/pre-edit.sh` blocks edits of `.env` and `.env.*` (except
  `.env.example`) and of `package-lock.json`. Change dependencies through npm.
- PostToolUse `scripts/hooks/post-edit.sh` formats the file you edited (so it may change under
  you), lints it and runs the fast rules check. Exit 2 with a report means: fix that file now.
- Git hooks (Husky): pre-commit runs lint-staged (`prettier --write`,
  `eslint --fix --max-warnings 0`, `node scripts/rules-check.mjs --` on the staged files);
  commit-msg enforces Conventional Commits
  through `scripts/hooks/commit-msg.mjs` (GIT-001): `type(scope)!: subject` with the types feat,
  fix, docs, style, refactor, perf, test, build, ci, chore, revert. Commit per phase on `main`.
- A deviation from the build brief gets an ADR under `docs/adr/` (DOCS-001).

## Skills and the reviewer agent

Skills live in `.claude/skills/<name>/SKILL.md` (written in Phase 9):

- `quality-gate`: before calling work done, or when any stage of the gate is red.
- `add-template`: when adding a scenario template (leaky and fixed variant, expectations, golden
  tests, docs entry).
- `add-static-check`: when adding an `RLSxxx` static check (semantics from the official docs
  first, a positive and a negative fixture, docs entry).
- `debug-probe`: when one matrix cell disagrees with the expectation and you must decide whether
  the policy, the expectation or the runner is wrong.
- `sonar-triage`: when the SonarQube gate fails or issues and hotspots need a decision.
- `release`: when cutting a version (changelog, full gate, tag, the owner's deployment checklist).
  It never deploys.

Agent `security-reviewer` (`.claude/agents/security-reviewer.md`, read-only tools): run it on any
change that touches `src/lib/ai`, `src/app/api`, `src/proxy.ts`, headers or the CSP, the SQL
execution in `src/lib/engine` and `src/lib/runner`, `src/lib/redis`, `src/lib/store` or
`supabase/migrations`. Give it the changed files; act on every blocker and major finding.

## Forbidden actions (rules.yaml FA-1..FA-7)

- FA-1: deploy anything, run the Vercel or Supabase CLI against a real project, configure DNS,
  create or log into an external account, spend money. Prepare the instructions; the owner acts.
- FA-2: push, add a remote, force anything in git, rewrite history (amend included).
- FA-3: read, create or print `.env`, `.env.local`, `.env.sonar` or any secret; make real model or
  network calls from tests. Only `.env.example`, with empty values, is committed.
- FA-4: execute user-supplied SQL on any server built for production.
- FA-5: let the LLM decide a verdict, or present an unverified fix as verified.
- FA-6: weaken a test, a lint rule, a coverage threshold or the quality gate, or add an exclusion
  without a written reason in `rules.yaml`.
- FA-7: claim that a check passed without having just run it.
