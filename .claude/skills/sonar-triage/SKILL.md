---
name: sonar-triage
description: Use when the SonarQube quality gate of the project is red or the sonar stage of the local gate fails, when issues or security hotspots need a decision, when a finding looks like a false positive, or when tempted to resolve, accept, exclude or suppress findings to get the gate green.
---

# Sonar triage

Findings are fixed in the code. The gate, the quality profile and the exclusions stay as they are
(QUAL-002, FA-6). The policy and the record: `docs/sonar-triage.md`. Setup:
`scripts/sonar/README.md`.

## Pull

`scripts/sonar/api.sh` is an authenticated, read-only GET that prints JSON. Never read or print
`.env.sonar` (SEC-003, FA-3).

```sh
P=postgres-rls-leak-tester
scripts/sonar/api.sh "api/qualitygates/project_status?projectKey=$P"   # which conditions fail
scripts/sonar/api.sh "api/issues/search?components=$P&issueStatuses=OPEN,CONFIRMED&impactSeverities=BLOCKER,HIGH&ps=500&facets=rules,directories"
scripts/sonar/api.sh "api/hotspots/search?project=$P&status=TO_REVIEW&ps=500"
scripts/sonar/api.sh "api/rules/show?key=typescript:S3776"              # what a rule wants
scripts/sonar/api.sh "api/webservices/list"                             # never guess an endpoint
```

The server runs in MQR mode: severities are `impactSeverities` (BLOCKER, HIGH, MEDIUM, LOW, INFO),
HIGH is the old "critical". Each issue carries `rule`, `component`, `line`, `message`.

## Fix

1. Order: gate conditions first (blocker and high issues, reliability and security rating), then
   the rest, grouped by rule.
2. Read the rule and the code. Change behaviour only with a test; a complexity finding is a
   refactoring under green tests. Golden snapshots stay byte-identical.
3. After each batch run `npm run lint`, `npm run typecheck`, `npm run rules` and
   `npx vitest run <touched suites>`.
4. Re-scan: `npm run test:coverage`, then `npm run sonar`. A fixed issue closes itself.

## Claimed false positive

It stays open. Add a row to `docs/sonar-triage.md`: what the rule assumes, why that does not hold
here, the evidence (a test, an ADR). A hotspot gets its row before anyone calls it reviewed. If the
gate stays red because of it, report that.

## Never

Bulk-change issues, mark "False positive" or "Accepted" to pass, add `sonar.issue.ignore.*`, a bare
`NOSONAR`, an exclusion without its reason in `rules.yaml` (QUAL-001), switch a rule off, or touch
the gate's conditions.
