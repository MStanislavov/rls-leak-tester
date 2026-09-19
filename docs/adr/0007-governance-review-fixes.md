# ADR 0007: Closing the gaps of the Phase 2 governance review

- Status: accepted
- Date: 2026-09-19
- Phase: 2 (governance), review round
- Versions: ESLint 9.39.5, eslint-config-next 16.3.5, Vitest 5.0.1, Node.js 26.8.1
- Supersedes parts of ADR 0004 (the ESLint block names and scopes) and ADR 0005 (SEC-002, SEC-004,
  TEST-001, the number of script rules)

## Context

An independent reviewer found seven places where a rule of `rules.yaml` could be broken without
any tool noticing. Each one was reproduced before it was changed and again afterwards. Everything
below was run on this machine.

## Decisions

### 1. The ESLint rules have a standing regression suite

`tests/eslint/boundaries.test.ts` loads the real `eslint.config.mjs` through ESLint's Node API
(`new ESLint({ cwd })`, `lintText(code, { filePath })`; the paths need not exist) and lints one
violating snippet per rule, scope and import form, plus an allowed counterpart. It asserts
severity 2, the ESLint rule id, and that the message names the `rules.yaml` id. A last block
reads `calculateConfigForFile` and expects severity 2 for every governed rule per scope.

ESLint prefixes its own text to a `no-restricted-imports` and `no-restricted-globals` message
(`'x' import is restricted from being used. ARCH-001: …`), so the suite asserts that the message
contains `ARCH-001: `, not that it starts with it. `@typescript-eslint/no-explicit-any` and
`no-non-null-assertion` have fixed messages; for CODE-001 and CODE-002 the ESLint rule id and the
severity are the assertion. `typescript-eslint/recommended` already makes `no-explicit-any` an
error everywhere, so CODE-001 has no "allowed outside src/lib" counterpart; CODE-002 has one.

Mutation check, each run against the suite and then reverted:

| Change to `eslint.config.mjs`            | Result of the suite |
| ---------------------------------------- | ------------------- |
| `no-explicit-any` set to `"warn"`        | 15 of 71 fail       |
| `PURE_DIRS` shrunk to `["checks"]`       | 17 of 71 fail       |
| the whole `rules/arch-001` block deleted | 22 of 71 fail       |
| `cjs` removed from the extension list    | 14 of 71 fail       |

`npm run lint` is now `eslint --max-warnings 0`, lint-staged and `scripts/hooks/post-edit.sh` use
the same flag, and the rules check has a new script rule, QUAL-002: none of the six governed ESLint
rule names may be `"off"`, `"warn"`, `0` or `1` in `eslint.config.*` (listing it as an exclusion is
no way out any more), and every ESLint command in `package.json` scripts and lint-staged carries
`--max-warnings 0`. The script now runs 15 rules.

### 2. ARCH-001 covers the project's own impure modules, HTTP/2 and DNS

Brief 4.3 says "or anything that touches the network". Added to the pure directories:
`@/lib/redis`, `@/lib/ai`, `@/lib/store` (and below), every module of `@/lib/config` except the
pure parser `env`, the relative forms of all of these, `http2`, `dns` (bare and `node:`), every
subpath of a banned module (`dns/promises`, `react/jsx-runtime`, …), and `navigator.sendBeacon`.
The same list applies to `import()` and, new, to `require()`.

`no-restricted-imports` cannot resolve a path, so the relative patterns are
`^(\.\./)+(redis|ai|store)(/|$)` and `^(\.\./)+config($|/(?!env…))`. A directory with one of those
names inside a pure directory, imported from one level further down with `../`, would be reported
as well. Section 4.2 has no such directory; if one appears, import it through its alias.

ARCH-004 and ARCH-002 also gained `import()` and `require()` selectors (the UI layers from
`src/lib`, the `process` module from `src/`), because `no-restricted-imports` sees neither.

### 3. `.cjs` is covered

`eslint-config-next` registers the `react` plugin for `js,jsx,mjs,ts,tsx,mts,cts` only (checked by
printing the `files` of its blocks), and naming a plugin rule for a file without the plugin is a
configuration error. The boundary rules are core rules, so their blocks now use
`{js,jsx,mjs,cjs,ts,tsx,mts,cts}`; `react/no-danger` and the two TypeScript rules sit in blocks of
their own with the old extension set (`rules/sec-001-react`, `rules/code-001-code-002`). The
ARCH-002 `ignores` pattern changed with it, and so did its entry under `exclusions`.

### 4. SEC-004 is an allow-list and knows Server Functions

A value import of a Postgres engine or of `src/lib/engine` is accepted only in `src/lib/engine`,
in `src/lib/runner`, in a module whose first statement is `"use client"`, and in tests. It is
always refused in a route handler, in `src/app/api`, `src/lib/{ai,redis,store}`, and in any file
with a `"use server"` directive at file or function level, wherever the file lives. Type-only
imports stay allowed, which is what `src/app/lab/rls-proof.ts` uses.

Consequence for later phases: a lab component or hook that value-imports the engine starts with
`"use client"`, also when Next.js would not need the directive because a parent already has it. A
Server Component or `src/proxy.ts` that imports the engine fails.

### 5. TEST-001 has a run-time layer

`tests/setup/network-guard.ts` (no side effect on import) and `tests/setup/network-guard.setup.ts`
(registered as `test.setupFiles` in `vitest.config.mts`). The guard checks `fetch`, `WebSocket`,
`EventSource` and `XMLHttpRequest` by URL and patches `net.Socket.prototype.connect` underneath,
which is where `node:http`, `node:https`, `node:http2`, `node:tls`, the built-in `fetch`, `ioredis`
and any driver end up. `net.connect()` hands `socket.connect()` its arguments as one normalised
array; the guard reads that form too. Loopback is `localhost`, `*.localhost`, `127.0.0.0/8`,
`0.0.0.0` and `::1`; Unix sockets pass. `RUN_LIVE_AI_TESTS=1` (or `true`) lifts the guard.

A blocked attempt throws and is recorded, and an `afterEach` fails the test when a record exists,
because a fail-closed path in product code swallows exactly this kind of error. Proof: the suite
starts a child Vitest run over `tests/setup/fixtures/swallowed-call.fixture.ts` and expects the
test that swallowed a blocked `fetch` to fail with the TEST-001 message, and the loopback test next
to it to pass. Vitest 5 writes the JSON report to `<root>/.vitest/json/output.json` unless
`--outputFile` is given, and a child whose root is the fixture directory leaves a
`node_modules/.vite` cache there. The child therefore runs from the repository root, with
`--outputFile` and Vite's `cacheDir` in the system's temporary directory, so it leaves nothing
behind and does not overwrite the timing cache of the run that started it.

Every remote address in these tests is under `.invalid` (RFC 6761) and assembled at run time.
Known limit: UDP (`node:dgram`) and the resolver calls of `node:dns` are not intercepted.

The static layer stays and became a little less blind: it follows a URL constant of the same file
(`fetch(BASE)`, `fetch(BASE + "/v1")`, ``fetch(`${BASE}/v1`)``), sees `new URL("…")` as an
argument, and knows `http.request(` and `https.get(`. A new repository check fails a
`vitest.config.*` whose `setupFiles` lacks the guard, a missing setup file, and a setup file that
stopped calling `installNetworkGuard(` or `failOnBlockedAttempts(`. `TEST-001` is now enforced by
the script and by `vitest`.

While adding `setupFiles` to `parseVitestConfig`, a latent bug showed: the coverage block was
blanked with spaces only, so every line number after it was too small. Newlines are kept now.

### 6. SEC-002 knows more ways to read input

`.text()`, `.arrayBuffer()`, `.blob()`, `.bytes()`, `.headers.get(`, `headers().get(`,
`.cookies.get(`, `cookies().get(` and `document.cookie` count as reads in every product file under
`src/`, not only in routes, because route logic lives in `src/lib`. Known limit, unchanged in
kind: a header object kept in a variable first (`const h = await headers(); h.get("x")`) is not
seen, and the check is per file, not per value.

### 7. Forced `git add`, `git tag -f`, `git branch -f`: prepared, not applied

The reviewer is right: `Bash(git add *)` is allowed and nothing denies `git add -f .env.local`.
The fix is ten deny rules in `.claude/settings.json`, an extended GIT-002 check text, and a longer
assertion list in `tests/hooks/governance.test.ts`. It is **not applied by this change**: the
agent that did this work runs under an instruction that no task text can authorise a change of the
Claude Code permission settings or of `CLAUDE.md`. The same holds for the `CLAUDE.md` bullets of
ARCH-001, SEC-002, SEC-004, TEST-001 and the lint-staged line. Both edits were handed to the
orchestrator as one patch that was applied to a copy of the repository and verified there. Until
it is applied, lint-staged (SEC-003 by file name) remains the layer that catches a forced
`git add` of an env file, and `rules.yaml` wins over `CLAUDE.md` where the two differ.

## Evidence

Reproductions with real files (created and deleted again): a `"use server"` file importing PGlite,
a route using `await request.text()`, a test with `const BASE = "https://…"` used three ways: five
violations from `node scripts/rules-check.mjs -- <files>`, exit 1. `src/components/__scratch.cjs`
with `process.env.SECRET` and a `src/lib/runner` file importing `@/lib/redis/keys`, `../ai/model`,
`@/lib/store`, `@/lib/config/server`, `node:http2` and `node:dns`: seven ESLint errors, exit 1.
Before the change each of these produced no finding.

## Consequences

- `npm test` is a few seconds slower (the ESLint suite loads the Next.js configuration once; the
  guard suite starts one child Vitest process).
- A test that needs a real host must run behind `RUN_LIVE_AI_TESTS=1`; nothing else gets out.
- A change of the pure-directory list, of a governed rule or of the extension sets in
  `eslint.config.mjs` has to keep `tests/eslint/boundaries.test.ts` and `rules.yaml` in step.
