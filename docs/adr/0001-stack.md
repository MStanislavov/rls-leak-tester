# ADR 0001: Stack and scaffold

- Status: accepted
- Date: 2026-09-19
- Phase: 0 (preflight), with the project scaffold pulled forward from Phase 2

## Context

RLS Leak Tester runs a persona x table x operation matrix against a real Postgres inside the
browser, so the stack has to carry a WASM database in a Web Worker, a small server surface for the
optional AI and sharing features, and a quality gate. The build brief fixes the main choices
(Next.js App Router, strict TypeScript, Tailwind with shadcn/ui, CodeMirror 6, PGlite, zod, the
Vercel AI SDK with the Anthropic provider, ioredis, Supabase JS, Vitest, Playwright, ESLint,
Prettier, SonarQube, npm) and asks for the latest stable versions at build time, recorded here.

The brief places the scaffold in Phase 2, after the two spikes. Spike B ("PGlite inside Next.js")
needs a real Next.js app to run in, so the scaffold was pulled forward and done together with
Phase 0. Governance (rules.yaml, hooks, Husky wiring, boundary lint rules, `src/lib/config`,
Docker Compose) stays in Phase 2. All dependencies the whole build needs were installed in this
step so that later agents, which work in parallel, never have to run `npm install`.

## Environment (verified on 2026-09-19)

| Tool    | Version                                         | How it was checked    |
| ------- | ----------------------------------------------- | --------------------- |
| macOS   | 26.5.1, arm64                                   | `sw_vers`, `uname -m` |
| Node.js | v26.8.1                                         | `node -v`             |
| npm     | 11.19.0                                         | `npm -v`              |
| Docker  | 29.5.2 (client and server; the daemon answered) | `docker info`         |
| git     | 2.54.0                                          | `git --version`       |
| pnpm    | not installed; npm is the package manager       |                       |

## Decision

Scaffolded with `create-next-app@16.3.5`:

```
npx create-next-app@latest postgres-rls-leak-tester --ts --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-npm --disable-git --skip-install --no-react-compiler --yes
```

into a temporary directory, then moved into the repository (the repository already held `.git`,
`.gitignore` and local files). The existing `.gitignore` entries were kept and the Next.js ones
merged in. shadcn/ui was initialised with
`npx shadcn@latest init -t next -b radix -p nova -y --no-monorepo --css-variables --no-rtl`.

### Exact installed versions (from `package-lock.json`, lockfileVersion 3)

Runtime dependencies:

| Package                      | Version |
| ---------------------------- | ------- |
| `next`                       | 16.3.5  |
| `react`                      | 19.2.8  |
| `react-dom`                  | 19.2.8  |
| `@electric-sql/pglite`       | 0.5.8   |
| `zod`                        | 4.6.5   |
| `ai`                         | 7.0.107 |
| `@ai-sdk/anthropic`          | 4.0.58  |
| `@ai-sdk/react`              | 4.0.110 |
| `ioredis`                    | 6.0.0   |
| `@supabase/supabase-js`      | 2.116.0 |
| `@supabase/ssr`              | 0.12.7  |
| `codemirror`                 | 6.0.2   |
| `@codemirror/state`          | 6.7.5   |
| `@codemirror/view`           | 6.43.12 |
| `@codemirror/commands`       | 6.11.1  |
| `@codemirror/language`       | 6.12.4  |
| `@codemirror/lang-sql`       | 6.10.0  |
| `@codemirror/theme-one-dark` | 6.1.3   |
| `next-themes`                | 0.4.6   |
| `lucide-react`               | 1.47.0  |
| `yaml`                       | 2.9.1   |
| `geist`                      | 1.7.2   |
| `radix-ui`                   | 1.6.7   |
| `class-variance-authority`   | 0.7.1   |
| `cn`                         | 0.3.0   |
| `sonner`                     | 2.0.8   |
| `tw-animate-css`             | 1.4.0   |

Development dependencies:

| Package                  | Version |
| ------------------------ | ------- |
| `typescript`             | 6.0.3   |
| `@types/node`            | 26.6.2  |
| `@types/react`           | 19.3.0  |
| `@types/react-dom`       | 19.3.0  |
| `tailwindcss`            | 4.3.3   |
| `@tailwindcss/postcss`   | 4.3.3   |
| `eslint`                 | 9.39.5  |
| `eslint-config-next`     | 16.3.5  |
| `eslint-config-prettier` | 10.1.8  |
| `prettier`               | 3.9.8   |
| `vitest`                 | 5.0.1   |
| `@vitest/coverage-v8`    | 5.0.1   |
| `jsdom`                  | 30.1.0  |
| `@testing-library/react` | 16.3.3  |
| `@testing-library/dom`   | 10.4.2  |
| `@playwright/test`       | 1.63.0  |
| `@axe-core/playwright`   | 4.13.0  |
| `husky`                  | 9.1.7   |
| `lint-staged`            | 17.5.1  |
| `@sonar/scan`            | 5.0.0   |
| `tsx`                    | 4.23.13 |

Notable transitive versions: `vite` 8.3.0, `esbuild` 0.28.2, `typescript-eslint` 8.70.0. PGlite
0.5.8 reports `PostgreSQL 18.3` (checked with `select version()` in Node 26). Playwright 1.63.0
downloaded Chromium build 1243 (Chrome Headless Shell 153.0.8010.12).

### Where reality differed from the brief

1. **TypeScript 6.0.3, not 7.0.2.** `latest` on npm is 7.0.2, but `typescript-eslint` 8.70.0
   (pulled in by `eslint-config-next`) declares `typescript >=4.8.4 <6.1.0`. 6.0.3 is the newest
   release the lint toolchain accepts. `next build`, `next typegen` and `tsc --noEmit` all pass
   with it.
2. **ESLint 9.39.5, not 10.11.0.** npm prints a deprecation notice for the 9.x line, but
   `eslint-plugin-import` 2.32.0, `eslint-plugin-jsx-a11y` 6.10.2 and `eslint-plugin-react` 7.37.5
   (all dependencies of `eslint-config-next` 16.3.5) cap their peer range at ESLint 9.
   `create-next-app` itself pins `^9`. Move to 10 when `eslint-config-next` does.
3. **`engines.node` is `>=22.22.2`, not `>=20`.** The brief asked for `>=20`, but Node 20 is past
   end of life and the installed packages refuse it: `ai`, `@ai-sdk/*` and `@supabase/supabase-js`
   need `>=22`, `vitest` needs `^22.12.0 || ^24.0.0 || >=26.0.0`, `@sonar/scan` `>=22.12.0`,
   `lint-staged` `>=22.22.1`, `jsdom` `^22.22.2 || ^24.15.0 || >=26.0.0`. Declaring `>=20` would
   be untrue. Use the current 22.x or 24.x LTS in CI and on Vercel; Node 26 is what this machine
   runs and everything below was verified on it.
4. **npm 11.19 blocks dependency install scripts by default** and records decisions in the
   `allowScripts` field of `package.json`. Three packages ship install scripts: `esbuild`,
   `unrs-resolver` and `fsevents`. All three work without them (their platform binaries arrive as
   optional dependencies; verified by running `tsx`, Vitest, ESLint and `require("fsevents")`), so
   they are recorded as denied. Older npm versions ignore the field and run the scripts, which is
   also fine.
5. **`npm run typecheck` is `next typegen && tsc --noEmit`.** Next.js 16 generates the global
   `LayoutProps` / `PageProps` helper types into `.next/types`. On a clean clone plain
   `tsc --noEmit` fails with `Cannot find name 'LayoutProps'`; `next typegen` creates the types
   without a full build.
6. **The Vitest config is `vitest.config.mts`.** With `vitest.config.ts` Vite 8 warns that ESM
   syntax in a file loaded as CommonJS will stop working once its native config loader becomes the
   default. The `.mts` extension removes the warning without making the whole package
   `"type": "module"`.
7. **shadcn/ui 4.21 changes.** `init` now offers three component bases (`base`, `radix`, `aria`);
   `radix` was chosen (style `radix-nova`, unified `radix-ui` package) because it is the long-proven
   accessible base and its `asChild` API is the one most documentation describes. `init` also adds
   `shadcn` itself as a runtime dependency (for `@import "shadcn/tailwind.css"`) and writes
   `src/lib/utils.ts` as `export { cn } from "cn"`, where `cn` is shadcn's own replacement for
   `clsx` + `tailwind-merge` (same npm maintainer as `shadcn`, repository `shadcn-ui/cn`). To keep
   the CLI and its 33 dependencies out of the production tree, `npx shadcn eject` was run: the
   stylesheet now lives in `src/app/shadcn-tailwind.css` and `shadcn` is no longer a dependency.
   `npx shadcn@latest add <component>` still works through `components.json`.
8. **Fonts come from the `geist` package, not `next/font/google`.** The generated layout fetched
   Geist from Google Fonts at build time, which makes `next build` depend on the network. The
   `geist` package ships the same fonts as local files. `init` had also left a self-referencing
   `--font-sans: var(--font-sans)` in `globals.css`; it now points at `--font-geist-sans`.
9. **`create-next-app` writes `AGENTS.md` and a one-line `CLAUDE.md` (`@AGENTS.md`).** `next dev`
   re-adds the managed block when it detects a coding agent
   (`node_modules/next/dist/server/lib/generate-agent-files.js`), so both files are kept. The
   Phase 2 `CLAUDE.md` must keep the `@AGENTS.md` import line. `AGENTS.md` is in `.prettierignore`
   because Next.js compares the block byte for byte.

### Configuration choices

- `tsconfig.json`: `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`; `target` raised from ES2017 to
  ES2022 (type-checking only, SWC does the real transpile) so `bigint` literals from PGlite type
  check. The generated shadcn components pass under these flags.
- ESLint flat config: `eslint-config-next/core-web-vitals`, `eslint-config-next/typescript`, then
  `eslint-config-prettier/flat` last. Boundary rules (section 4.3) are added in Phase 2.
- Prettier: double quotes, semicolons, trailing commas, width 100. It honours `.gitignore`, and
  `.prettierignore` adds the lockfile, `AGENTS.md`, snapshots and generated output.
- Vitest: `node` environment; `src/**/*.test.{ts,tsx}` and `tests/**/*.test.ts`; `e2e/` excluded;
  alias `@` to `src`; coverage provider v8 with `text`, `lcov`, `json-summary`; coverage scope
  `src/lib/**`; thresholds 80 percent lines and branches; `passWithNoTests` so an empty suite exits 0. A component test opts into a DOM per file with `// @vitest-environment jsdom`
  (`jsdom` and Testing Library are installed for that).
- Playwright is installed with Chromium only. `playwright.config.ts` and `e2e/` belong to Spike B.
- Husky and lint-staged are installed but not wired; the hook and the `prepare` script belong to
  the Phase 2 governance step.

## Consequences

- Every later phase can import any planned library without touching `package.json`, which keeps
  parallel agents from colliding on the lockfile.
- Contributors need Node 22.22.2 or newer. Node 20 is not supported.
- TypeScript and ESLint are each one major version behind `latest` until `eslint-config-next`
  supports the newer ones. Dependabot will surface that.
- `@types/node` is 26.x to match the local runtime, while CI and Vercel may run 22.x or 24.x; avoid
  Node APIs newer than 22 in server code.
- `npm audit` reported two findings right after the install, both from one chain: `adm-zip`
  (`<=0.6.0`, high, "no fix available") through the development-only `@sonar/scan`. It never
  reaches the production bundle. If it is still unfixed in Phase 8, the scan can run from the
  `sonarsource/sonar-scanner-cli` container instead and `@sonar/scan` can be dropped.
- The ejected `src/app/shadcn-tailwind.css` no longer updates with the shadcn CLI; it is vendored
  code and should be excluded from Sonar duplication and CSS rules in Phase 8.
- `src/app/favicon.ico` is still the `create-next-app` default and should be replaced with the
  product's own icon when the landing page is built.
