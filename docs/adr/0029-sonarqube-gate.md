# ADR: SonarQube quality gate and `npm run quality`

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-20
- Phase: 8 (task Q1)
- Builds on: ADR 0001 (stack, the `adm-zip` note), 0005 (rules.yaml and QUAL-001), 0009 (known
  limits of the governance checks)

## Context

Brief 5.2 asks for a local SonarQube server, an idempotent bootstrap, a gate named
"RLS Leak Tester" with conditions on overall and on new code, a `sonar-project.properties`, a scan
through `@sonar/scan`, and `npm run quality` as the single local gate. It also says: do not guess
the web API. This ADR records what the running server said and where the result differs from the
literal wording of the brief.

## Verified facts (2026-09-20, this machine: macOS arm64, Docker 29.5.2 with 8 GB)

- `sonarqube:community` runs natively on arm64 and reports version **26.9.0.129388**. It was `UP`
  within about two minutes with the compose settings that were already there
  (`SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true`, `nofile` 131072, `nproc` 8192). It uses 2.1 GB idle.
  `docker-compose.yml` needed no change.
- `GET api/webservices/list` requires authentication on this version (`sonar.forceAuthentication`
  is true). Endpoints used, with the parameter names from that listing:
  `api/system/status`, `api/authentication/validate`,
  `api/users/change_password (login, password, previousPassword)`,
  `api/projects/search (projects)`, `api/projects/create (project, name, mainBranch)`,
  `api/user_tokens/search | revoke (name) | generate (name, type=PROJECT_ANALYSIS_TOKEN, projectKey)`,
  `api/settings/values (keys)`, `api/metrics/search`,
  `api/qualitygates/list | create (name) | show (name) | create_condition (gateName, metric, op, error) | update_condition (id, metric, op, error) | select (gateName, projectKey) | get_by_project (project)`.
  `gateId`, `projectId` and numeric gate ids no longer exist (removed in 10.0).
- The server runs in **MQR mode** (`sonar.multi-quality-mode.enabled=true`,
  `GET api/v2/clean-code-policy/mode` answers `MQR`). Severities are BLOCKER, HIGH, MEDIUM, LOW,
  INFO; the ratings it shows and evaluates are `software_quality_reliability_rating`,
  `software_quality_security_rating`, `software_quality_maintainability_rating` and their `new_`
  forms. The server **refuses** a gate that holds both spellings of one idea
  ("Condition for metric 'reliability_rating' already exists on equivalent metric
  'software_quality_reliability_rating'"), so one vocabulary has to be chosen.
- `api/qualitygates/create` does not create an empty gate: the new gate already holds the
  server's "Clean as You Code" conditions `new_coverage < 80`, `new_duplicated_lines_density > 3`,
  `new_security_hotspots_reviewed < 100` and `new_violations > 0`.
- A `PROJECT_ANALYSIS_TOKEN` may read `api/issues/search`, `api/measures/component` and
  `api/qualitygates/project_status` (HTTP 200) but not `api/hotspots/search` (HTTP 403).
- `@sonar/scan` 5.0.0 needs no Java install: it downloads
  `OpenJDK21U-jre_aarch64_mac_hotspot_21.0.11_10.tar.gz` (`api/v2/analysis/jres`) and
  `sonar-scanner-engine-community-13.7.0.4455.jar` (`api/v2/analysis/engine`) from the server into
  `~/.sonar/cache` and verifies the SHA-256 the server states.

## Decisions

### 1. The gate uses the MQR metric keys; "critical" is expressed as "high" (adaptation of 5.2)

In MQR mode the conditions are `software_quality_*_rating > 1` (worse than A) for the three
ratings, and "zero blocker or critical issues" is `software_quality_blocker_issues > 0` plus
`software_quality_high_issues > 0`. HIGH is the MQR name of the level that standard mode calls
CRITICAL, so this is the same condition in the server's vocabulary, not a weaker or stricter one.
Every condition exists twice, on overall code and as its `new_` form: 16 conditions.

`scripts/sonar/gate-conditions.mjs` derives them from `rules.yaml` (`thresholds.quality_gate`,
`thresholds.coverage.lines_min_percent`, `thresholds.duplication`) so the numbers live in one
place, and knows the classic keys as well. `bootstrap.sh` reads the mode from the server, checks
every metric key against `api/metrics/search` before using it, and fails with a clear message if
a key is unknown instead of trying another one. `tests/quality/gate-conditions.test.ts` pins both
vocabularies and the planning logic.

### 2. The server's own `new_violations > 0` condition is kept (stricter than 5.2)

The brief does not ask for "no new issue of any severity". The bootstrap nevertheless never
deletes a condition: a gate is a conjunction, so an extra condition can only make it stricter, and
a script that deletes conditions is one bug away from weakening the gate (QUAL-002). Consequence:
after the first analysis, new code must be free of issues of every severity, not only of blocker
and critical ones. If the owner wants the gate to be exactly the list of 5.2, the condition can be
removed in the UI; that is a decision for a person, with this paragraph as the record.

### 3. `sonar.sources=.`: the whole repository is analysed, and every exclusion is named

With an explicit source list (`src`, `scripts`, ...) everything that is not listed is left out
silently, and QUAL-001 cannot see it, because it compares `*.exclusions` keys. With
`sonar.sources=.` the only things not analysed are the patterns under `sonar.exclusions`, each of
which is listed in `rules.yaml` with its reason: the test files (moved to the test set through
`sonar.test.inclusions`, since a file cannot be source and test), `e2e/**` (brief 5.2), and
generated output (`node_modules`, `.next`, `coverage`, `playwright-report`, `test-results`,
`next-env.d.ts`). The generated directories are git-ignored and the scanner would skip them
anyway; they are named so that the analysis does not depend on the scanner finding git.
`public/pglite/**` from the brief is not listed because the directory does not exist (ADR 0003:
the bundler emits the assets).

Coverage exclusions are exactly the two the brief allows: `src/app/**` and `src/components/**`.

### 4. Vitest's coverage scope grows to what Sonar counts as coverable (change of `vitest.config.mts`)

Sonar counts every analysed source file without LCOV data as fully uncovered. With
`sonar.sources=.` that would have put `scripts/rules-check/**` (1123 lines, 96 percent covered by
`tests/rules-check`) at zero, which is as wrong as excluding it. `coverage.include` is therefore
`src/lib/**`, `src/*.ts`, `scripts/**` and the root `*.config.{ts,mts,mjs}` files. Measured on
2026-09-20: 94.1 percent lines and 89.6 percent branches over that scope, 99.1 and 96.2 for
`src/lib` alone. Files that only ever run as a child process (`scripts/rules-check.mjs`,
`scripts/hooks/payload-paths.mjs`, the spike) honestly show zero: v8 coverage does not follow a
spawn.

The thresholds did not get weaker: the global 80/80 now applies to the wider scope, and a
glob threshold `"src/lib/**": { lines: 80, branches: 80 }` keeps TEST-002 for the library by
itself. The rules check reads nested thresholds too and requires each to be at least 80.

### 5. `npm run quality`: a Sonar preflight first, and `--no-sonar` is loud

Order: sonar-preflight, format:check, lint, typecheck, rules, unit tests with coverage, build,
end to end in production mode, Sonar scan with gate wait. `format:check` and the preflight are
additions to the list of 5.2. The preflight (`scripts/sonar/check.sh`, a second of work) exists
because failing fast should not mean learning after ten minutes that the server is down. A
missing `.env.sonar` or an unreachable server fails the run with the two commands that fix it;
there is no silent skip.

`--no-sonar` leaves the two Sonar stages out for a machine without Docker. Every other stage still
has to pass, the exit code is then 0, and the last line says that the gate was NOT fully run and
that this is not a pass of the quality gate. Without the flag there is no way to get exit code 0
without a passed Sonar gate.

The unit stage starts `redis` through Docker Compose when Docker is available and sets
`REDIS_URL`, so the adapter contract suite runs on real Redis; without Docker it says so and runs
on the in-memory adapter. The end-to-end stage runs `playwright test` against the build of the
stage before it instead of `npm run e2e`, which would build a second time.

### 6. Secrets handling

`.env.sonar` (git-ignored through `.env.*`, mode 600, written atomically) holds `SONAR_HOST_URL`,
`SONAR_TOKEN`, `SQ_ADMIN_LOGIN` and `SQ_ADMIN_PASSWORD`. The administrator keys do not start with
`SONAR_` because the scanner turns every `SONAR_*` environment variable into an analysis property;
`scan.sh` exports only the token and the URL. Credentials reach `curl` through `-K -` (a config on
stdin), never through the command line, and no script prints them. The bootstrap writes the new
password to the file before it changes it on the server: if it dies in between, the next run finds
a stored password that does not work yet, falls back to the default and rotates again. `api.sh`
can only `GET`; it logs in as the administrator because the analysis token may not read hotspots.

### 7. `adm-zip` advisory through `@sonar/scan`: resolved with an npm override

Update (orchestrator, 2026-09-20): the override named below was applied
(`overrides: { "@sonar/scan": { "adm-zip": "0.6.1" } }`), `npm audit` reports 0 vulnerabilities and
the scan was re-run with the patched package. Remove the override once `@sonar/scan` ships the fix.
The original assessment follows.

`npm audit` reports 1 high and 1 moderate finding, both `adm-zip` 0.6.0 (GHSA-vwc7-r8mq-g2x9,
GHSA-7q85-xj36-vmfc), "no fix available": `@sonar/scan` 5.0.0 is the latest release and pins
`adm-zip` to exactly 0.6.0; the fixed `adm-zip` is 0.6.1 (published 2026-09-11). Risk: the package
is a devDependency, nothing under `src/` imports it, it never reaches the production bundle, and
the scanner calls it only for `.zip` archives, while this server hands out a `.tar.gz` JRE and a
JAR, both checksum-verified, from 127.0.0.1. `@sonar/scan` was therefore kept. Two ways to clear
the audit, neither taken here because this task did not own the lockfile: an npm `overrides`
entry `{"@sonar/scan": {"adm-zip": "0.6.1"}}`, or the next `@sonar/scan` release through
Dependabot. Recorded in `docs/sonar-triage.md` as well.

## Consequences

- `npm run rules` now compares `sonar-project.properties` with `rules.yaml` in both directions
  (the file exists), so a new Sonar exclusion without a reason fails the rules check.
- `npm run test:coverage` reports the wider scope; the "All files" line is no longer the figure
  for `src/lib` alone (that one is the `src/lib` rows and the glob threshold).
- CI can reuse everything: `npm run sonar` takes `SONAR_TOKEN` and `SONAR_HOST_URL` from the
  environment, and extra scanner arguments pass through (`-- -Dsonar.organization=...`).
- A reset of the local server is `docker compose down -v`, delete `.env.sonar`, start, bootstrap
  (`scripts/sonar/README.md`).
