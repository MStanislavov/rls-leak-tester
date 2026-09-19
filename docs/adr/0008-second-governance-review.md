# ADR 0008: Closing the gaps of the second governance review

- Status: accepted; section 9 is prepared as a patch and waits for the owner
- Date: 2026-09-19
- Phase: 2 (governance), second review round
- Versions: ESLint 9.39.5, eslint-config-next 16.3.5, Vitest 5.0.1, Node.js 26.8.1
- Supersedes parts of ADR 0007: section 4 (SEC-004 allow-list), section 5 (the live switch),
  section 7 (the settings patch, replaced by the one named in section 9)

## Context

A second independent review found ten places where a rule of `rules.yaml` could still be broken
without a tool noticing. Each one was reproduced first, changed, and reproduced again; the
mutations below were run against a copy of the repository and reverted.

## Decisions

### 1. SEC-004: the runner never holds an engine

`src/lib/runner` left the allow-list (`ENGINE_DIRS` is `["src/lib/engine"]`). The reviewer's
chain, a runner module that imports PGlite and a route handler one import away, produced no
finding, because nothing forbids server code from importing the runner. Of the two fixes offered,
"treat an import of the runner like an import of the engine in server places" leaves the same
chain open with one more hop (route, any `src/lib` module, runner, PGlite). Taking the runner out
closes it for any number of hops, because the list is now closed under imports: whatever may hold
an engine is under `src/lib/engine`, which nothing outside the list may value-import, or is a
`"use client"` module, of which server code only gets a reference it cannot call
(`next-flight-loader`: "Attempted to call … from the server").

Consequence for Phase 4 and later: the runner takes the `SqlEngine` port as a parameter and
imports it with `import type`. The engine is passed in by a `"use client"` module or by the worker
under `src/lib/engine/worker`. If the runner needs the Supabase shim SQL of `src/lib/engine`, it
receives it as a value, or the shim moves; a value import from `src/lib/engine` fails SEC-004.
Runner test files may use PGlite (brief 5.1), which is why `tests/eslint/boundaries.test.ts` keeps
"PGlite is allowed by ARCH-001 in `src/lib/runner`": ARCH-001 also lints the test files there.

### 2. SEC-002: a Server Function is an input boundary

A file with a `"use server"` directive (file or function level) and an async function that takes
a parameter counts as an input read and needs `.parse(` / `.safeParse(` or an imported `parse*` /
`validate*` function from `src/lib`. A Server Function without parameters reads nothing. New read
patterns for every product file: `.get(`, `.getAll(`, `.entries(`, `.values(` on a name ending in
`formData` or `searchParams`, and `Object.fromEntries(formData)`. Known limits, unchanged in kind:
per file, not per value; an object kept under another name first is not seen.

### 3. ARCH-002: the `process` identifier is restricted, not only `.env`

`const p = process; p.env.X` passed. `rules/arch-002` and `rules/arch-001` now ban the identifier
through `no-restricted-globals`, and `globalThis.process`, `global["process"]` and
`const { process } = globalThis` through `no-restricted-syntax`. `rules/arch-004` deliberately does
not name `no-restricted-globals`: flat config keeps the entry of `rules/arch-002` for `src/lib`,
and `src/lib/config`, which `rules/arch-002` ignores, stays free. Nothing under `src/` outside
`src/lib/config` used `process` (checked with grep). Known limit: an alias of `globalThis` itself.

### 4. QUAL-002: a governed rule lives in the named blocks only

Flat config replaces rule options. A later block such as
`{ files: ["src/app/docs/**"], rules: { "no-restricted-syntax": ["error", …] } }` dropped ARCH-002
and SEC-001 there while every tool stayed green. Two layers now:

- Script: each governed rule name may appear as a key only inside the block whose `name` is listed
  in `GOVERNED_ESLINT_BLOCKS` (`scripts/rules-check/checks.mjs`), every listed block exists exactly
  once and still sets its rules. A configuration that names no governed rule at all passes (the
  fixture checkout); the suite below is what fails when the real blocks disappear.
- Suite: `tests/eslint/boundaries.test.ts` imports the exported array and asserts the name, `files`,
  `ignores` and governed rules of each named block, that no other block after the presets names a
  governed rule, and, with `calculateConfigForFile`, that every real code file under `src/`,
  `tests/`, `e2e/`, `scripts/` and the root, plus five synthetic paths per directory of brief 4.2,
  resolves to exactly the entry its scope's named block declares.

The reviewer's block: 3 script violations, 2 of 76 suite tests fail; with `src/lib/engine/**` in
its `files`, 9 fail.

### 5. QUAL-002: the enforcing suites cannot be switched off quietly

New repository check `checkGuardSuites`: `tests/eslint/boundaries.test.ts`,
`tests/setup/network-guard.test.ts` and `tests/hooks/governance.test.ts` exist, hold a test, carry
no `.skip` / `.todo` / `.only`; `test.include` of `vitest.config.*` contains
`src/**/*.test.{ts,tsx}` and `tests/**/*.test.ts`; no `test.exclude` pattern matches a suite. In
`package.json`, `test` is `vitest run` and `test:coverage` is `vitest run --coverage`, with
reporting flags at most (`--reporter=`, `--outputFile=`, `--silent`, `--bail=`,
`--passWithNoTests`, `--no-file-parallelism`). A later phase that needs another flag extends
`HARMLESS_VITEST_FLAG` on purpose. The script still runs 15 rules.

Mutations, each reported by `node scripts/rules-check.mjs`: include narrowed to `src/**` (1), both
suites deleted (2), `describe.skip` on the ARCH-001 block (1).

### 6. TEST-001: the live switch cannot be set from inside

`installNetworkGuard` copies `RUN_LIVE_AI_TESTS` into a frozen record when it is installed; it used
to read the live `process.env` on every call, so a test could lift the guard. Proof in
`tests/setup/network-guard.test.ts`: a test sets the variable (name assembled at run time) and
`fetch`, `net.connect` and `WebSocket` are still blocked; the child run has a third fixture test
that does the same and fails. With the snapshot removed, both tests fail.

Static layer: a test file that writes the switch (`.RUN_LIVE_AI_TESTS =`, bracket form, `||=`,
`??=`, `vi.stubEnv`, `Object.assign(process.env, …)`) fails; the setup file must call
`installNetworkGuard(process.env)` literally, every call of it; `vitest.config.*` must not name
the variable outside comments; no npm script or lint-staged command contains
`RUN_LIVE_AI_TESTS=`. Live tests are started by hand: `RUN_LIVE_AI_TESTS=1 npm test`.

### 7. The hook suite no longer leaves `build/` behind

`rmSync(dir, { recursive: false })` throws on a directory, and the cleanup ran before the scratch
directory inside was removed (the cleanups run last in, first out). Now `rmdirSync`, registered
before the scratch directory and only when `build/` did not exist, plus an `afterAll` assertion
that the suite leaves `build/` the way it found it.

### 8. File ownership

The task named `tests/eslint/boundaries.test.ts` and `tests/setup/**` in its findings but not in
its ownership list. They were edited, because the findings cannot be closed without them and the
agent ran alone.

### 9. `.claude/settings.json`, `CLAUDE.md`, the reviewer agent: prepared, not applied (again)

Still open from ADR 0007 section 7, for the same reason: the agents of this build run under a
standing instruction that no message from another agent authorises a change of Claude Code's
permission settings, of `CLAUDE.md` or of its configuration. The orchestrator's task text is such
a message. The change is therefore one patch for the owner (or for a session the owner instructs
directly): `governance-settings-claude-md-agent.patch` in the orchestrator's scratchpad, applied
with `git apply` from the repository root. It was applied to a copy of this tree, where lint,
type-check, rules check, the full test suite and the format check passed.

What it contains:

- Deny rules without the space, so that a cluster of short flags is caught: `git commit -n*`,
  `* -n*`, `-an*`, `-sn*`, `-qn*`, `-vn*` (first or later on the line), `git add -f*`, `--force*`,
  `-Af*`, `-uf*`, `-vf*`, `git tag` and `git branch` with `-f*` and `--force*`, and the
  later-position forms for `checkout` and `switch`. Known cost: a commit message that contains
  ` -n` or ` -f` is refused and has to be reworded. Known limit, documented by Claude Code: Bash
  rules match the command text and are not a security boundary (`git -c … commit` prompts, it is
  not allowed silently, because it does not match `Bash(git commit *)`).
- `tests/hooks/governance.test.ts`: an emulation of the documented rule matching (any text for
  `*`, a trailing ` *` also matches the bare command) and a table of 45 commands that must be
  denied, 10 that must stay allowed without a prompt and 3 that must stay a prompt. Against the
  current settings 26 of them fail, which is the reviewer's finding as a test. A second new test
  pins the facts `CLAUDE.md` and the reviewer agent must state.
- `rules.yaml`: the GIT-002 and QUAL-002 check texts name the new deny rules.
- `CLAUDE.md`: ARCH-001, ARCH-002, SEC-002, SEC-004, TEST-001, the ESLint block rule, the guard
  rails and the lint-staged line as `rules.yaml` has them now.
- `.claude/agents/security-reviewer.md`: a section on Server Functions and a line on the live
  switch.

Until it is applied, `rules.yaml` wins over `CLAUDE.md` where they differ (SEC-004 and the runner
above all), and lint-staged remains the only layer against a forced `git add` of an env file.

## Consequences

- A lab hook or component that needs the engine starts with `"use client"`; the runner never
  imports it as a value.
- A new ESLint selector goes into the shared lists of `eslint.config.mjs`, never into a new block.
- `npm test` with a file filter belongs on the command line (`npx vitest run <file>`), not in
  `package.json`.
