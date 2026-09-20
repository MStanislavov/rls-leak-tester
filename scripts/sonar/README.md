# SonarQube, locally

The quality gate "RLS Leak Tester" runs on a SonarQube Community Build server from
`docker-compose.yml`. Nothing here talks to SonarCloud or any other external service. The server
listens on `127.0.0.1:9000` only and needs roughly 2 to 3 GB of memory (measured: 2.1 GB idle).

| File                  | What it does                                                                     |
| --------------------- | -------------------------------------------------------------------------------- |
| `bootstrap.sh`        | Idempotent setup: password, project, token, quality gate. Writes `.env.sonar`.   |
| `scan.sh`             | `npm run sonar`: scans and waits for the gate; a failing gate fails the command. |
| `check.sh`            | Preflight: credentials known and server `UP`? Used by `scan.sh` and the gate.    |
| `api.sh`              | Authenticated, read-only `GET` against the server's web API. Prints JSON.        |
| `gate-conditions.mjs` | The gate conditions, derived from `rules.yaml`, for MQR and standard mode.       |
| `lib.sh`              | Shared shell helpers. Sourced, never executed.                                   |

## Start

```sh
docker compose up -d --wait sonarqube   # first start takes 2 to 4 minutes
```

`--wait` returns when the healthcheck sees `"status":"UP"`. If it does not, read
`docker compose logs --tail 100 sonarqube`.

## Bootstrap

```sh
npm run sonar:bootstrap
```

Safe to run as often as you like. It waits for `UP`, rotates the default `admin`/`admin` password
to a generated one, creates the project `postgres-rls-leak-tester`, revokes and regenerates the
project analysis token `rls-leak-tester-analysis`, creates the gate, sets its conditions, assigns
it to the project, reads the gate back and prints the conditions.

Secrets go to the git-ignored `.env.sonar` (mode 600) and nowhere else. The scripts never print
them, and credentials reach `curl` through a config on stdin, not through the command line.

| Key in `.env.sonar` | Read by                                                        |
| ------------------- | -------------------------------------------------------------- |
| `SONAR_HOST_URL`    | the scanner                                                    |
| `SONAR_TOKEN`       | the scanner (project analysis token: may analyse this project) |
| `SQ_ADMIN_LOGIN`    | `bootstrap.sh`, `api.sh`                                       |
| `SQ_ADMIN_PASSWORD` | `bootstrap.sh`, `api.sh`; never exported to the scanner        |

The administrator keys deliberately do not start with `SONAR_`: the scanner turns every `SONAR_*`
environment variable into an analysis property.

## Scan

```sh
npm run test:coverage   # writes coverage/lcov.info; the scan refuses to run without it
npm run sonar           # scans, waits for the gate, exits non-zero when the gate fails
```

`npm run quality` does both as its last stages, after format, lint, type check, rules check, the
build and the end-to-end suite.

No Java install is needed. `@sonar/scan` downloads the JRE and the scanner engine that the server
itself offers (`api/v2/analysis/jres`, `api/v2/analysis/engine`) into `~/.sonar/cache` and checks
their SHA-256 sums.

In CI, set `SONAR_TOKEN` and `SONAR_HOST_URL` in the environment; `scan.sh` then ignores
`.env.sonar`. Extra scanner arguments pass through: `npm run sonar -- -Dsonar.organization=...`.

## The gate

Conditions come from `rules.yaml` (`thresholds.quality_gate`, `thresholds.coverage`,
`thresholds.duplication`), each on overall code and on new code: coverage at least 80 percent,
duplicated lines at most 3 percent, reliability, security and maintainability rating A, security
hotspots reviewed 100 percent, no blocker and no critical issue.

This server runs in MQR mode, so the ratings are the `software_quality_*` metrics and "critical"
is called "high" (`software_quality_high_issues`). On a server in standard mode the bootstrap
uses the classic keys instead. A new gate is born with the server's own condition
`new_violations > 0` (no new issue at all); the bootstrap keeps it, because an extra condition
can only make a gate stricter. The bootstrap never deletes a condition.

## Read results

```sh
scripts/sonar/api.sh 'api/qualitygates/project_status?projectKey=postgres-rls-leak-tester'
scripts/sonar/api.sh 'api/issues/search?components=postgres-rls-leak-tester&issueStatuses=OPEN,CONFIRMED&ps=500'
scripts/sonar/api.sh 'api/hotspots/search?project=postgres-rls-leak-tester&status=TO_REVIEW&ps=500'
scripts/sonar/api.sh 'api/measures/component?component=postgres-rls-leak-tester&metricKeys=coverage,duplicated_lines_density'
scripts/sonar/api.sh 'api/webservices/list'   # everything this server version offers
```

The UI is at <http://127.0.0.1:9000> (login `admin`, password in `.env.sonar`).

Findings are handled by the policy in `docs/sonar-triage.md`: real issues are fixed in the code,
a suspected false positive stays open and is documented there, nothing is resolved in bulk.

## Reset

```sh
docker compose down -v                   # deletes the server's volumes: projects, history, users
rm -f .env.sonar
docker compose up -d --wait sonarqube
npm run sonar:bootstrap
```

Use this when the admin password is lost (`.env.sonar` deleted after a rotation), or to start
from a clean history. `docker compose down` without `-v` keeps everything.
