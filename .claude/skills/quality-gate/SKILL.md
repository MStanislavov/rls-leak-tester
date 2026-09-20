---
name: quality-gate
description: Use when about to call work done, commit a phase or cut a release, when any stage of the local quality gate is red (format, lint, types, rules check, tests, coverage, build, Playwright, SonarQube), or when tempted to skip, loosen or exclude something to get to green.
---

# Quality gate

`npm run quality` is the gate. A red stage is fixed in the code, never in the gate (QUAL-002,
FA-6). "Passed" is said only about a run you just read (P2, FA-7).

## Run

```sh
docker compose up -d --wait redis sonarqube   # sonarqube: 2 to 4 minutes on first start
npm run sonar:bootstrap                       # idempotent; needed once and after a reset
npm run quality
```

It stops at the first red stage: `quality: FAILED at stage n/9 "<id>"`, then the command that runs
that stage alone. Fix, re-run the stage, then run the whole gate again. Only
`quality: PASSED, all 9 stages` counts; `-- --no-sonar` ends with "NOT fully run" and is no pass.

## Stage by stage

| Stage           | Alone                                                    | When red                                                                             |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| sonar-preflight | `bash scripts/sonar/check.sh`                            | start and bootstrap the server, see `scripts/sonar/README.md`                        |
| format          | `npm run format:check`                                   | `npm run format`                                                                     |
| lint            | `npm run lint`                                           | the message names its rule id; an inline disable needs `-- why` (QUAL-001)           |
| typecheck       | `npm run typecheck`                                      | never plain `tsc`                                                                    |
| rules           | `npm run rules`                                          | the line names rule id and file; read that rule in `rules.yaml`                      |
| unit            | `REDIS_URL=redis://127.0.0.1:6379 npm run test:coverage` | one file: `npx vitest run <file>`; coverage under 80 percent: write tests (TEST-002) |
| build           | `npm run build`                                          | fix the error it prints                                                              |
| e2e             | `npx playwright test` (after a build)                    | one test: `-g "<title>"`; traces in `test-results/`                                  |
| sonar           | `npm run sonar`                                          | use the sonar-triage skill                                                           |

## Never

- Lower a threshold, add or widen an exclusion, delete, skip or loosen a test, resolve Sonar
  issues to pass, give `npm test` a file filter, commit with `--no-verify`.
- Edit an expectation or a golden snapshot to match: use the debug-probe skill.
