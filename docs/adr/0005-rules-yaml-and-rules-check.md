# ADR 0005: `rules.yaml` and the rules check

- Status: accepted
- Date: 2026-09-19
- Phase: 2 (governance), task G2
- Versions: Node.js 26.8.1 (the project requires 22.22.2 or newer), yaml 2.9.1, zod 4.6.5,
  Vitest 5.0.1, Next.js 16.3.5

## Context

Section 6.1 of the brief asks for one machine-readable rule file and a script that validates it and
executes the rules marked `script:`. The rule ids and meanings were fixed up front in a contract
shared with the ESLint side (ADR 0004). This ADR records what the brief left open, where the
script goes further than the contract, and one place where the toolchain differs from the brief.

## Decisions

### Layout

| Path                             | Role                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `rules.yaml`                     | principles, 24 rules, thresholds, exclusions, FA-1..7, DOD-1..12 |
| `scripts/rules-check.mjs`        | the command line: arguments, output, exit code                   |
| `scripts/rules-check/schema.mjs` | zod schema of `rules.yaml` plus the semantic checks              |
| `scripts/rules-check/checks.mjs` | every check as a pure function, and the registry                 |
| `scripts/rules-check/text.mjs`   | comment-aware source scanning, imports, brackets, paths          |
| `scripts/rules-check/repo.mjs`   | the only module that touches the disk and git                    |
| `scripts/rules-check/run.mjs`    | full and fast mode, the link between `rules.yaml` and the checks |
| `tests/rules-check/`             | 130 tests: a violating and a clean fixture per script rule       |

Plain `.mjs` with JSDoc types, no build step and no type stripping, so the pre-commit hook pays
only Node's start-up: fast mode takes about 90 ms wall time for seven files, full mode about 170 ms
for the whole repository (measured with `time`).

### The checks are text heuristics, made honest by a small scanner

There is no parser dependency (the task allows `yaml` and `zod` only). `scanSource` separates code
from comments while respecting string, template and regular expression literals and keeps line
numbers. That is what lets a check ignore a rule id in a comment and read `".next/**"` as a string
rather than the start of a block comment. Known limits: JSX text that contains `//` is read as a
comment on that line, and a violation assembled at run time (string concatenation, computed
member names) is not seen. ESLint, the type checker, the tests and review cover those; the script
is one layer, not the only one.

### Reality versus the brief: the Node.js runtime export

`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/runtime.md`
(Next.js 16.3.5): `'nodejs'` is the default and `'edge'` is deprecated. The brief's concern
("routes that use Redis run on the Node.js runtime, not Edge") can therefore no longer happen by
accident. REDIS-002 keeps the explicit `export const runtime = "nodejs"` because the shared
contract asks for it and because it documents the TCP dependency; the script also fails a route
that says anything other than `"nodejs"`. The export is incompatible with `cacheComponents`
(`migrating-to-cache-components.md`); this project does not enable that flag.

### Vocabulary that the brief's shape did not have

- `enforced_by` accepts the brief's values plus `vitest`, `playwright` and `settings`, because the
  contract names tests, end-to-end tests and the `.claude/settings.json` deny list as enforcers.
  It is always written as a list.
- RUN-001 has area `security`: the brief's area list has no `runner`, and a probe that runs as a
  superuser is a false "isolated" verdict, which is a security failure.
- Every exclusion has a `tool`. Compared in both directions with the tool's own configuration:
  `eslint`, `eslint-rule-off`, `vitest`, `vitest-coverage`, `sonar`, `sonar-coverage`, `sonar-cpd`,
  `sonar-test`, `sonar-issue`, `rules-check`. Documented only: `coverage-scope` (what
  `coverage.include` leaves out) and `rule-scope` (where a single rule does not apply).

### Thresholds the brief left open

The brief gives no number for these, so `rules.yaml` fixes them and later phases read them from
there: run ceiling 60 000 ms, single-flight lock TTL 30 000 ms, scenario cache TTL 60 s, explain
rate limit 5 per IP and 10 per user per 60 s, scenario writes 20 per IP and 30 per user per 60 s,
route handler length 80 lines (from the contract). The numbers the brief does give are floors in
the schema: coverage below 80, duplication above 3, a rating other than A, hotspots below 100,
a probe timeout above 5 000 ms, a payload cap above 30 KB or a cache TTL above seven days fail
validation. `rules.yaml` cannot be edited into a weaker gate (QUAL-002).

### Path conventions that the checks rely on

A rule such as "one key builder" needs a path to be checkable. These are now part of the rules and
are spelled out in the `check` hints: the key builder is `src/lib/redis/keys.ts`; Redis writes
live in `src/lib/redis/adapters/`; the model id lives in `src/lib/ai/model.ts`; a bypass-guard
suite has `bypass-guard` in its file name and sits in `src/lib/runner/` or `tests/`; policies are
built in `src/lib/security/csp.ts`.

### Where the script goes further than the contract

All additions are supersets; none relaxes a contract rule.

- SEC-001 also fails `innerHTML =`, `outerHTML =`, `insertAdjacentHTML(` and `document.write(`.
- SEC-002 applies to every product file under `src/`, not only `route.ts`: route logic is planned
  to live in `src/lib/ai`, so a check on the handler alone would pass vacuously forever.
  `JSON.parse(` and `localStorage.getItem(` are inputs too; `params` counts in a route.
- SEC-003 also knows Supabase secret keys, GitHub and SonarQube tokens and private key blocks. A
  Redis URL is not a secret when its password is a placeholder (`<password>`, `${VAR}`) or its
  host is loopback or reserved by RFC 2606 / RFC 6761, so documentation can show the shape.
  Messages name the kind of secret and never repeat it.
- SEC-004 also covers every `route.ts` and the project's own `@/lib/engine`; type-only imports
  and test files are allowed.
- SEC-005 also checks that `src/proxy.ts` calls `buildDocumentCsp(`, that `next.config.*` calls
  `buildStaticSecurityHeaders(`, and that neither writes an `'unsafe-*'` source itself.
- REDIS-001 also fails a value import of `ioredis` outside `src/lib/redis`.
- REDIS-002 treats all of `@/lib/store` as Redis-using: a route only ever reaches the server store.
- QUAL-001 also covers rules switched `"off"` in `eslint.config.mjs`, the script's own skip list,
  and inline suppressions: `eslint-disable`, `@ts-expect-error`, coverage ignore hints and Sonar
  suppressions need a reason in the same comment (`-- why`; the hint pattern in
  `node_modules/ast-v8-to-istanbul/dist/index.mjs` ends in a lookahead, so text after the hint is
  accepted), `@ts-ignore` and `@ts-nocheck` are forbidden.
- RUN-001 also fails a bypass-guard suite with `.skip`, `.todo` or `.only`, or without a test.

### `rules.yaml` cannot switch a check off quietly

The script runs the rules marked `script:scripts/rules-check.mjs`, as the brief says. If a rule
the script implements loses that mark, or a rule claims the mark without an implementation, that
is a `RULES-SCHEMA` violation. If the rule list cannot be read at all, every implemented check
runs. A `script:` enforcer must point at a file that exists.

### Environment files and git

The script never opens `.env`, `.env.local`, `.env.sonar` or any other `.env.*` except
`.env.example`; they are judged by name only, through `git ls-files --cached` (full mode) or for
the given paths (fast mode, which is how a staged `.env.local` is caught in the hook). Full mode
walks the tree, never follows a symbolic link, and leaves out what git ignores
(`git ls-files --cached --others --exclude-standard`); without git it falls back to the skip list.

### No exclusion for `public/pglite/**`

ADR 0003 proved that the `/public/pglite/` fallback is not needed, so there is nothing to exclude.
`.prettierignore` still names the directory; it is exempt from QUAL-001 because formatting is not
a quality measurement. The Sonar exclusions of section 5.2 are listed as planned and are compared
with `sonar-project.properties` from the moment that file exists.

## Verification

| Command                            | Result                                                      |
| ---------------------------------- | ----------------------------------------------------------- |
| `npm run rules`                    | exit 0, `rules-check (full): ok, 14 script rules, 89 files` |
| `npx vitest run tests/rules-check` | 5 files, 130 tests passed                                   |
| `npm run lint`                     | exit 0                                                      |
| `npm run typecheck`                | exit 0                                                      |
| fast mode, 7 files + 2 bad paths   | exit 0, 20 ms inside the script, 89 ms wall                 |

One of the tests runs the real script against this repository and expects exit 0, so a change
that breaks a rule fails `npm test` as well as `npm run rules`.

## Consequences

- Phase 6 (Redis, AI) and phase 3 (runner) must use the path conventions above; the violation
  messages say where code has to move.
- Phase 8 must list every `sonar-project.properties` exclusion in `rules.yaml`, or the rules check
  fails, in both directions.
- Husky, lint-staged and the Claude Code hooks call `node scripts/rules-check.mjs -- <files>`
  (`npm run rules:fast -- <files>`); an empty file list is valid and exits 0.
