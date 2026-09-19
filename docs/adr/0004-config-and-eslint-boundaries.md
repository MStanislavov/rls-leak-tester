# ADR 0004: Typed configuration, ESLint boundaries and the local services

- Status: accepted
- Date: 2026-09-19
- Phase: 2 (governance), task G1
- Versions: Next.js 16.3.5, ESLint 9.39.5 (flat config), eslint-config-next 16.3.5, zod 4.6.5,
  Vitest 5.0.1, Docker 29.5.2, `redis:7-alpine`, `sonarqube:community` (26.9.0.129388, arm64)

## Context

Sections 4.2, 4.3, 4.5 and 4.8 of the brief ask for one typed reader of the environment, for
boundaries that are enforced rather than hoped for, and for Redis and SonarQube through Docker
Compose. This ADR records what was built and every place where the toolchain forced a choice.
Everything below was observed on this machine.

## Decisions

### `src/lib/config` has three entry points, not one barrel

| Module       | Reads                                       | May be imported from                   |
| ------------ | ------------------------------------------- | -------------------------------------- |
| `env.ts`     | nothing; pure functions over an `EnvRecord` | anywhere                               |
| `server.ts`  | all of `process.env`, secrets included      | server code only                       |
| `public.ts`  | the four `NEXT_PUBLIC_*` variables          | anywhere, Client Components included   |
| `runtime.ts` | `process.env.NODE_ENV` only, no imports     | anywhere, `src/proxy.ts` in particular |

A barrel (`index.ts`) would pull `server.ts` into every client bundle that wants the app name, so
there is none. `public.ts` spells each variable as a literal `process.env.NEXT_PUBLIC_X` member
expression, because Next.js only inlines that exact form
(`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`).

Parsing is lazy and happens once (`once()`); a failed parse is not cached. Empty and
whitespace-only values count as unset, so an unchanged copy of `.env.example` behaves exactly like
no file at all (a unit test reads `.env.example` and asserts this, and also that the file and the
schema list the same variables).

Errors are `ConfigError`s built from the variable name and a fixed sentence per rule. zod 4 does
not copy the input into its issues, and every schema carries its own `error` text, so a rejected
`REDIS_URL` can never print its password. Tests assert this on the message, the JSON form and the
stack.

### The client guard is a runtime check, because `server-only` is not installed

The Next.js 16 docs state that Next handles `import "server-only"` internally and that installing
the package is optional. That holds for `next build`, but Vitest resolves imports through Node and
fails on a package that is not in `node_modules`; an alias in `vitest.config.mts` would fix it, and
that file belongs to another task. `server.ts` therefore throws at module evaluation when a
`window` global exists. No secret can reach a browser even without the guard, since Next.js only
inlines `NEXT_PUBLIC_*`; the guard exists to make the mistake loud. Follow-up (optional): add
`import "server-only"` plus a Vitest alias to `next/dist/compiled/server-only/empty.js` for a
build-time error on top of the runtime one.

### Derived values

- `explainEnabled` is `key present AND (NODE_ENV is not production OR REDIS_URL present)`.
  `NODE_ENV`, not the Vercel environment, decides: a Vercel preview deployment runs with
  `NODE_ENV=production`, is reachable from the internet, and must not expose an unmetered model
  endpoint either.
- The Redis key segment `{env}` is `test` under `NODE_ENV=test`, else Vercel's own `VERCEL_ENV`
  (`production`, `preview`, `development`) when present, else `production` or `development` from
  `NODE_ENV`. `VERCEL_ENV` and `VERCEL_GIT_COMMIT_SHA` are platform variables; `.env.example`
  mentions them in a comment only.
- `runLiveAiTests` is true only when `RUN_LIVE_AI_TESTS` is on **and** an API key is present.
- `anthropicModel` is an optional override. The default model id is not defined here (AI-001
  keeps it in `src/lib/ai/model.ts`).
- `supabaseEnabled` needs both the URL and the anon key; one without the other is "off".

### `src/proxy.ts` goes through `runtime.ts`

`isDevelopment()` keeps the old meaning exactly (`NODE_ENV === "development"`), so
`NODE_ENV=test` still gets the strict CSP. `!isProduction()` would have changed that.

### ESLint: composed option lists, because flat config replaces rather than merges

When two flat-config blocks set the same rule for a file, the later options replace the earlier
ones. `no-restricted-imports` and `no-restricted-syntax` are used by several rules with nested
scopes (everywhere ⊃ `src` ⊃ `src/lib` ⊃ the pure directories), so `eslint.config.mjs` builds
their options from shared lists and each narrower block carries everything the wider ones ban.

| Rule id  | ESLint rule(s)                                                           | Scope                                        |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| SEC-001  | `react/no-danger`, `no-restricted-syntax`                                | every linted file                            |
| ARCH-002 | `no-restricted-syntax`, `no-restricted-imports` (`process`)              | `src/**` except `src/lib/config/**`          |
| ARCH-004 | `no-restricted-imports` (`@/app`, `@/components`, relative equivalents)  | `src/lib/**`                                 |
| CODE-001 | `@typescript-eslint/no-explicit-any`                                     | `src/lib/**`                                 |
| CODE-002 | `@typescript-eslint/no-non-null-assertion`                               | `src/lib/**`                                 |
| ARCH-001 | `no-restricted-imports`, `no-restricted-globals`, `no-restricted-syntax` | `src/lib/{runner,checks,export,scenario}/**` |

Details that are easy to get wrong:

- No plugin was installed. `react` and `@typescript-eslint` come registered with
  `eslint-config-next`, for the extensions `js,jsx,mjs,ts,tsx,mts,cts`; the rule blocks use the same
  set, since naming a plugin rule for a file without that plugin is a configuration error.
- `react/no-danger` only sees JSX on DOM elements. Three selectors add the custom-component prop
  and the props object handed to `createElement`.
- `process.env` is matched as `process.env`, `process["env"]`, `globalThis.process.env` and
  `const { env } = process`; importing the `process` module is banned in the same scope, which
  closes `import { env } from "node:process"`.
- The pure directories also ban dynamic `import()` of the same modules and
  `globalThis|window|self.fetch` (and the other three globals), which `no-restricted-imports` and
  `no-restricted-globals` do not see. Inside an esquery selector an unescaped `/` ends the
  regular expression (checked with esquery 1.7.0: `Unterminated group`), so the selector is built
  with escaped slashes.
- The bans cover type-only imports and test files in those directories. A test that needs the file
  system or a DOM belongs in `tests/`.
- Beyond the contract list, the bare spellings (`fs`, `http`, ...) and `fs/promises` are banned
  together with their `node:` forms.
- The relative-path pattern is `^(\.\./)+(app|components)(/|$)`. A future directory named
  `src/lib/**/app` or `.../components` would be caught by it; the layout of section 4.2 has none.

Each rule was proven with scratch files (one per scope, deleted afterwards): 56 errors, each on the
expected line with the expected rule id, and none on the allowed counterparts (`process.env` inside
`src/lib/config`, `scripts/` and `tests/`; `react` and `node:fs` in a non-pure `src/lib` directory;
`zod`, PGlite and `@/lib/utils` in a pure one).

### Docker Compose

- Redis runs with `--save "" --appendonly no` and a tmpfs on `/data` (the image declares that
  volume), so nothing persists and no anonymous volume is left behind. Verified in the running
  container: `CONFIG GET save` is empty, `appendonly` is `no`, the healthcheck reached `healthy`,
  and `ioredis` on the host answered `PONG`.
- SonarQube's fourth declared volume, `/opt/sonarqube/temp`, is a named volume and not a tmpfs:
  Docker mounts tmpfs `noexec` (checked: `rw,nosuid,nodev,noexec`), and Elasticsearch unpacks native
  code there.
- The SonarQube healthcheck uses `curl`, which the image ships (`/usr/bin/curl`, checked), against
  `/api/system/status`, and accepts only `UP`. SonarQube itself was not started in this task; the
  bootstrap task proves the healthcheck.
- Both ports bind to `127.0.0.1` only.

## Consequences

- Code outside `src/lib/config` gets configuration as values: server code calls
  `getServerConfig()`, client code `getPublicConfig()`, pure code takes parameters.
- Validation runs on first use, not at process start. To fail at boot, as section 4.8 words it, a
  `src/instrumentation.ts` whose `register()` calls `getServerConfig()` is needed; that file is
  outside this task's ownership and is listed as an open issue.
- Root config files (`next.config.ts`, `playwright.config.ts`, `vitest.config.mts`), `scripts/`,
  `tests/` and `e2e/` are outside `src/` and may read `process.env`; `rules.yaml` lists that as a
  reasoned exclusion.
