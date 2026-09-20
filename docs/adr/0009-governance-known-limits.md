# ADR: Three more governance gaps closed, and the limits we accept

- Status: accepted; the `CLAUDE.md` lines of section 5 are prepared as a patch and wait for the owner
- Date: 2026-09-19
- Phase: 2 (governance), third round
- Versions: ESLint 9.39.5, eslint-config-next 16.3.5, eslint-plugin-import 2.32.0,
  @typescript-eslint/parser 8.70.0, Vitest 5.0.1
- Builds on ADR 0007 and ADR 0008

## Context

Three gaps were realistic enough to close before the product code arrives: a page that reads a
slug, a relative import that reaches a banned directory through another one, and the network
globals in bracket or destructured form. Everything else a reviewer could still construct is
listed in section 4 as an accepted limit, with one reasoning throughout: **these rules guard
against accidents; review guards against intent.** A tool that tries to stop a determined author
grows without bound and still loses; a tool that stops the honest mistake stays small and is right
almost every time.

## Decisions

### 1. SEC-002: `params` and `searchParams` are input in the segment files, not only in `route.ts`

The planned page `/s/[slug]` reads a slug the visitor chooses. The words `params` and
`searchParams` now count as an input read in `page`, `layout`, `template`, `default`, `icon`,
`apple-icon`, `opengraph-image` and `twitter-image` files under `src/app` (any code extension), as
they already did in `route.ts`. `generateMetadata` and `generateViewport` live in those files, so
they are covered without a pattern of their own. The file then needs `.parse(` / `.safeParse(` or
a called `parse*` / `validate*` function imported from `src/lib`, as before. `error`, `loading`,
`not-found` and ordinary components receive no parameters from Next.js and stay out of scope.
Known limits, unchanged in kind: per file, not per value; a component that is handed the raw
`params` object by its page is not seen (the page is, and has to parse first).

### 2. ARCH-001 / ARCH-004: imports are resolved before they are judged

`no-restricted-imports` matches the specifier as text. `^(?:\.\./)+(?:redis|ai|store)` sees
`../redis/keys` but not `../../lib/redis/keys` from `src/lib/runner`,
`../../../src/components/ui/button` from `src/lib/security`, `../checks/../redis/keys` or
`@/lib/runner/../redis/keys`.

The brief preferred `import/no-restricted-paths`. It is available (eslint-config-next registers
eslint-plugin-import 2.32.0), and it was rejected after reading its source: it resolves through
the file system and returns without a report when the target does not resolve
(`if (!absoluteImportPath) return;`). `src/lib/redis`, `src/lib/ai`, `src/lib/store` and
`src/components/ui` do not all exist yet, and `tests/eslint/boundaries.test.ts` lints snippets
whose paths never exist, so the rule could neither bite today nor be pinned by the suite. The
preset also registers the plugin without `.cjs`.

Instead: a local rule, `boundaries/resolved-imports`
(`scripts/rules-check/eslint-boundaries.mjs`), that resolves the specifier lexically with
`resolveImport` of `scripts/rules-check/text.mjs`, the resolver the SEC-004 check already uses
(`@/` alias and relative paths, `.` and `..` normalised, no file system), and reports when the
result is under a banned directory. It covers static and type-only imports, both re-export forms,
`import()` and `require()` with a string or a placeholder-free template literal,
`import x = require()` and the `import("…")` type. Zones are composed per scope like the other
governed rules: `src/app` and `src/components` for all of `src/lib` (message `ARCH-004:`), plus
`src/lib/redis`, `src/lib/ai`, `src/lib/store` and `src/lib/config` except `env` for the pure
directories (message `ARCH-001:`).

It is a governed rule: `GOVERNED_ESLINT_RULES` and `GOVERNED_ESLINT_BLOCKS` of the rules check name
it, the boundaries suite compares its resolved options for every real file, and the plugin is
registered by a block of its own (`rules/plugins`, no `files`, no rules). The text patterns stay:
they are pinned by the suite, and they over-approximate on purpose (`../app/x` from
`src/lib/security` is `src/lib/app/x` and still refused by them). An import into a UI layer is
therefore reported twice, once by each rule. A script check was the brief's fallback; it would
have needed `script:` in `enforced_by` of two rules and gives no editor feedback.

### 3. ARCH-001: the network globals in every spelling `process` already has

`globalThis["fetch"]`, `const { fetch: load } = globalThis` and `const { "fetch": load } = self`
passed. The selectors now mirror the ones for `process`: member and bracket form on `globalThis`,
`global`, `window` and `self` (`global` is new here; Node has `global.fetch`), destructuring with
an identifier or a string key, and `sendBeacon` in bracket and destructured form. `process` gained
the string-key destructuring it lacked. Known limits, as for `process`: an alias of the global
object itself (`const g = globalThis; g.fetch`), a computed key that is not a literal
(`globalThis["fe" + "tch"]`, a template literal), `Reflect.get`.

### 4. Accepted known limits

**Abbreviated git long options in the permission denies.** Git accepts any unambiguous prefix of a
long option, so `git commit --no-verif` or `git push --forc` is not matched by a deny rule written
for `--no-verify` or `--force`. Listing every prefix of every option is a table nobody can review,
and Claude Code documents Bash rules as text matching, not as a security boundary. Nobody types
`--no-verif` by accident. These rules guard against accidents; review guards against intent, and
here review has help: the server-side branch protection and CI run the same checks the skipped
hook would have run.

**`package.json` scripts beyond the test scripts.** The rules check pins `test`, `test:coverage`,
the `--max-warnings 0` of every ESLint command and the absence of the live switch. It does not pin
`lint`'s file set, `typecheck`, `rules`, `build` or what `prepare` installs; a script could be
rewritten to `true`. Pinning every script turns the check into a second copy of `package.json`
that has to change with every honest edit. A script that stops doing its job by accident shows up
at once (CI calls the tools by the same names and the Definition of Done reads their output). These
rules guard against accidents; review guards against intent: a diff of `package.json` scripts is on
the QUAL-002 review list.

**Vitest config keys that skip tests.** `test.include`, `test.exclude`, `setupFiles` and the
coverage block are read. `testNamePattern`, `allowOnly`, `passWithNoTests`, `bail`, `shard`,
`sequence`, a `projects` / workspace split, or `include` assembled at run time can still narrow a
run. The check reads the configuration as text and a complete model of Vitest's options would go
stale with every minor release. None of these keys is something one sets by mistake while fixing
something else. These rules guard against accidents; review guards against intent, and
`vitest.config.mts` is on the QUAL-002 review list by name.

**Network access from a worker thread or a child process started by a test.** The network guard
patches `fetch`, `net`, `tls`, `dns`, `http(s)` and `WebSocket` in the process that runs the test
file. A `worker_threads` Worker gets fresh globals and built-ins, and a child process is another
process; both reach the network unguarded (the guard's own suite uses a child run on purpose).
Closing it means `--experimental-permission`, a preload for every spawn or a sandbox, each with a
cost out of proportion to a test suite that has no reason to spawn anything that talks to a real
host. The static layer still sees a URL literal in the test file. These rules guard against
accidents; review guards against intent: a test that starts a worker or a process in order to
reach a host is a decision somebody has to write down and somebody else has to read.

**A Pages Router directory.** Every path rule assumes the App Router: `src/app/**/route.ts` for
ARCH-003, REDIS-002 and SEC-004, the segment files for SEC-002, `src/app/api` as a server
directory. A `src/pages/api/*.ts` handler or a `getServerSideProps` would be outside all of them.
The brief fixes the App Router, the repository has no `pages` directory, and adding one is a
structural change no tool needs to catch: it cannot happen in passing. These rules guard against
accidents; review guards against intent. If the decision ever changes, the rules change with it, in
the same commit.

**A deny-list, not an allow-list, for what the pure directories import.** ARCH-001 names what
`runner`, `checks`, `export` and `scenario` must not load. A new impure package (`undici`, `axios`,
`node:worker_threads`, `node:vm`) or a new impure directory under `src/lib` is allowed until
somebody adds it. An allow-list would be the proof, and it is what SEC-004 uses, where the set is
three entries long and closed under imports. Here the allowed set is open: `zod`, PGlite in tests,
type-only ports, every pure helper a later phase adds, and each addition would be an edit of
`eslint.config.mjs`, which trains people to edit it without thinking. The deny-list covers what is
installed in this repository and what the layout of the brief contains, which is what an honest
author reaches for. These rules guard against accidents; review guards against intent: a new
dependency is a diff of `package.json`, and a new directory under `src/lib` is visible in any
review.

### 5. `CLAUDE.md`: prepared, not applied

The task listed `CLAUDE.md` (the lines that describe these rules) under its ownership. The agents
of this build run under a standing instruction that no message from another agent authorises a
change of `CLAUDE.md`; the orchestrator's task text is such a message (same finding as ADR 0007
section 7 and ADR 0008 section 9). The four changed passages are therefore a patch for the owner,
`governance-claude-md.patch` in this agent's scratchpad, and in words:

- ARCH-001: add that the network globals are banned as `globalThis["fetch"]` and as
  `const { fetch } = globalThis` too, and that a relative path is resolved before it is judged
  (`boundaries/resolved-imports`), so `../../lib/redis/keys` is as much an error as `../redis/keys`.
- ARCH-004: add "whichever directories the relative path passes through
  (`../../../src/components/ui/button` included)".
- SEC-002: "in a route" becomes "in a route, and in a `page`, `layout`, `template`, `default` or
  metadata image file under `src/app`, `generateMetadata` included".
- The list of governed rule names gains `boundaries/resolved-imports`.

Until it is applied, `rules.yaml` wins over `CLAUDE.md` where they differ, as before.

## Consequences

- `/s/[slug]/page.tsx` parses `await params` with a zod schema or a `parse*` function from
  `src/lib` before it uses the slug, and so does its `generateMetadata`.
- A new banned directory goes into the zones of `eslint.config.mjs` (`appLayerZone`, `pureZones`)
  as well as into the text patterns.
- `eslint.config.mjs` imports from `scripts/rules-check/`. That directory is part of the lint
  configuration now, not only of `npm run rules`.
