# Sonar triage

How findings of the SonarQube gate "RLS Leak Tester" are handled, and the record of every finding
that was not simply fixed. Setup and commands: `scripts/sonar/README.md`.

## Policy

1. **Fix real issues in the code.** A finding that is right gets a code change and, where
   behaviour is involved, a test. It then disappears from the next analysis by itself; nobody
   closes it by hand.
2. **A suspected false positive stays open** and gets a row in the table below with the reasoning:
   what the rule assumes, why that assumption does not hold here, and what evidence shows it
   (a test, a line of the brief, an ADR). It is not marked "False positive" or "Accepted" in the
   server to make the gate green. If the gate stays red because of it, the report says so.
3. **Security hotspots are reviewed one by one.** "Reviewed" means somebody read the code and
   wrote down why it is safe, or fixed it. Each review gets a row below with its reasoning. A
   hotspot is never set to "Safe" without that row.
4. **Never in bulk.** No bulk change of issues, no `sonar.issue.ignore.*` rule, no `NOSONAR`
   without a reason on the same line (the rules check refuses that, QUAL-001), no rule switched
   off in a quality profile, no file added to an exclusion so that a number looks better.
5. **The gate is never weakened** (QUAL-002). Its conditions come from `rules.yaml`
   (`thresholds.quality_gate`) through `scripts/sonar/bootstrap.sh`, which only adds and corrects
   conditions and never deletes one. A change of a threshold is a change of `rules.yaml`, with an
   ADR, reviewed like any other rule change.
6. **Exclusions** live in `sonar-project.properties`, each one listed in `rules.yaml` with its
   reason; `npm run rules` compares the two in both directions.

Reading findings:

```sh
scripts/sonar/api.sh 'api/issues/search?components=postgres-rls-leak-tester&issueStatuses=OPEN,CONFIRMED&ps=500'
scripts/sonar/api.sh 'api/hotspots/search?project=postgres-rls-leak-tester&status=TO_REVIEW&ps=500'
```

## Findings that were not simply fixed

One row per finding that stays open as a suspected false positive, and per reviewed hotspot.
Fixed issues are not listed; the commit that fixed them is the record.

| Date | Rule | File and line | Kind | Decision | Reasoning and evidence |
| ---- | ---- | ------------- | ---- | -------- | ---------------------- |

### Area runner-export (`src/lib/runner/**`, `src/lib/export/**`)

Round 1 (2026-09-20): 53 issues, no hotspot. All 53 were fixed in the code, so there is no row:
nothing stays open and nothing was marked in the server. The generated SQL is the evidence that
behaviour did not change: `runtimeSql` for ten parameter sets and the 134 files of
`tests/export/write-template-exports.ts` are byte-identical before and after, apart from the keys
of `export-volatile-keys`, which come from `gen_random_uuid()` and differ on every run.

### Area ui (`src/components/**`, `src/app/**` pages and layouts, `src/lib/lab/**`, `src/lib/site/**`)

Round 1 (2026-09-20): 132 issues (84 blocking a rating), no hotspot. 108 were fixed in the code, 24
stayed open as suspected false positives; nothing was marked in the server. The decisions behind
the fixes that were more than a rewrite (the ejected stylesheet, `<fieldset>` and `<section>` for
groups and regions) are in `docs/adr/0031-sonar-ui-round-1.md`.

Round 2 (2026-09-20): the same 24 issues, none new, no hotspot. Ten of them (`typescript:S6845`,
`tabIndex` on a non-interactive element, `RELIABILITY:MEDIUM`) were the only reason the gate was
red. 17 were fixed in the code, 7 stay open in the row below; nothing was marked in the server, and
no rule, exclusion or gate condition was touched.

- `typescript:S6845`, all 10: round 1 listed them as false positives because a scroll region must
  take focus (WCAG 2.1.1, axe `scrollable-region-focusable`). The rule was half right: the ten
  elements had the tab stop always, also while nothing overflowed and they were static text. Now
  the stop is there exactly while the region overflows (`useScrollTabStop` in
  `src/components/site/scroll-region.tsx`). The rule reads a literal `tabIndex` only, so its
  silence proves nothing; `e2e/scroll-region.spec.ts` proves the behaviour in a browser, with axe.
- `typescript:S6819` on `role="group"` and `role="region"` of a `<pre>`, all 7: round 1 found no
  native element among the ones the rule offers. HTML has `<figure>` for a code listing, which
  takes a name without a role: `CodeListing` in the same file.

Reasoning, evidence and what changes for a keyboard user: `docs/adr/0032-sonar-ui-round-2.md`.
Lines in the row are those of the round 2 analysis.

| Date       | Key                                                                                                                                                                                                                                                                                    | Rule                                                       | File and line                                                                                                                                                                                                                                                                                     | Kind                                                          | Decision                                                       | Reasoning and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-20 | `9c607c0f-705c-455b-ac17-9e9c34ddc75b`, `7ad0275e-da1e-4e11-a3a6-c5c076d19be0`, `ba157294-e41a-4566-a575-9289a4d36539`, `5ea18e5a-0a27-4de4-9f5a-2c98243a0aca`, `b7277d2e-0f5d-4924-92e9-78603cdc5fff`, `5747a2de-808d-44f7-b95d-d6208fb54cef`, `13b350d6-9c2b-4726-bdcd-0ba109710dc8` | `typescript:S6819` (`<output>` instead of `role="status"`) | `src/app/lab/lab-loader.tsx:18`, `src/app/s/[slug]/shared-scenario-loader.tsx:20`, `src/components/lab/export/export-ci-check.tsx:246` and `:258`, `src/components/lab/scenario-panel.tsx:27`, `src/components/lab/share/share-dialog.tsx:237`, `src/components/lab/share/shared-scenario.tsx:38` | Code smell, `MAINTAINABILITY:MEDIUM`, does not block a rating | Open, suspected false positive (round 1, confirmed in round 2) | The seven are notices of a state: "Loading the lab", "Loading the SQL editor", "Checking your session", "The scenario changed since the last run", "Running the matrix". HTML defines `<output>` as the result of a calculation or of a user action, a form-associated element; a loading notice is neither. `<p role="status">` is the ARIA live region for exactly this, and `status` is the role the rule's own replacement maps to, so nothing is gained for a screen reader. |

### Area tooling-tests (`scripts/**`, `tests/**`, `e2e/**`, root config files)

Round 1 (2026-09-20): 66 issues (36 blocking a rating or the blocker/high condition), no hotspot.
All 66 were fixed in the code, so there is no row: nothing stays open and nothing was marked in the
server. Three fixes are not the rewrite the rule message suggests, and this is why:

- `javascript:S2871` (sort without a comparator, 4 places in `scripts/rules-check/`): the
  comparator is `byCodeUnit` of `text.mjs`, not `localeCompare`. The rules check must list files
  and rule ids in the same order on every machine, whatever its locale; code unit order is what the
  bare `sort()` did, so the output is unchanged.
- `javascript:S4036` (`execFileSync("git", …)` in `scripts/rules-check/repo.mjs`, the only security
  finding of the project): the finding is real here, because `npm run` puts `node_modules/.bin`
  first on PATH and a package that ships a bin called `git` would have answered "which files are
  tracked". `findGit` now resolves git to an absolute path and skips relative PATH entries and
  every directory inside the repository; `tests/rules-check/repo.test.ts` plants such a bin and
  proves it is never run.
- `typescript:S2187` and `typescript:S2699` (both blocker, `tests/redis/contract/memory.test.ts`
  and `redis.test.ts`): the files only called the shared contract suite, which the rule cannot
  see, and `redis.test.ts` held an empty `it.skip` as a marker. Each file now has a test of its
  own for what the suite relies on (a harness starts empty, under a prefix no other run shares),
  and the real-Redis one is a `describe.skipIf` with its reason, so a run without `REDIS_URL` still
  reports it as skipped.

Evidence that behaviour did not change: every helper and every file check of the old and the new
`scripts/rules-check/` gave identical output over a frozen copy of the repository (492 files, full
and fast mode) and over 300 000 generated inputs (token soups for imports, directives, Redis calls,
ESLint and Sonar configuration, package scripts and globs); `npm run rules` prints the same result.

## Dependency advisories of the tooling

| Date       | Package                                        | Advisory                                                                                       | Decision                                                                                                                                                                                                                                       | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-20 | `adm-zip` 0.6.0, pinned by `@sonar/scan` 5.0.0 | GHSA-vwc7-r8mq-g2x9 (symlink following on extraction), GHSA-7q85-xj36-vmfc (memory allocation) | Resolved 2026-09-20: `package.json` `overrides` pins `@sonar/scan` > `adm-zip` to the fixed 0.6.1; `npm audit` reports 0 vulnerabilities and the scanner was re-run with it (see `docs/PROGRESS.md`, Phase 8). Originally accepted as dev-only | `npm audit`: 1 high, 1 moderate, "no fix available": 5.0.0 is the latest `@sonar/scan` and pins `adm-zip` exactly; the fix is `adm-zip` 0.6.1. The package is a devDependency, is not imported by anything under `src/`, and never reaches the production bundle. The scanner calls `adm-zip` only for `.zip` archives (`node_modules/@sonar/scan/src/file.js`); against this server it downloads a `.tar.gz` JRE and a JAR, both verified by SHA-256, from a server on 127.0.0.1 that the developer runs. Follow-up: take the `@sonar/scan` release that moves to 0.6.1 (Dependabot), or add an npm `overrides` entry for `adm-zip` 0.6.1 in a change that owns the lockfile. |
