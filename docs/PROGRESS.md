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
