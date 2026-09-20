#!/usr/bin/env bash
# An authenticated, read-only GET against the SonarQube server of .env.sonar. Prints the response
# body (JSON) and nothing else; credentials never reach the command line or the output.
#
#   scripts/sonar/api.sh 'api/qualitygates/project_status?projectKey=postgres-rls-leak-tester'
#   scripts/sonar/api.sh 'api/issues/search?components=postgres-rls-leak-tester&issueStatuses=OPEN&ps=500'
#   scripts/sonar/api.sh 'api/hotspots/search?project=postgres-rls-leak-tester&ps=500'
#   scripts/sonar/api.sh 'api/webservices/list'          # what this server version offers
#
# It logs in as the administrator of the local server: the project analysis token may read issues
# and measures, but api/hotspots/search answers it with HTTP 403 (tried on 26.9). Only GET is
# possible here: changing an issue or a hotspot is a decision recorded in docs/sonar-triage.md.
set -euo pipefail

# shellcheck source=scripts/sonar/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -eq 1 ] || fail "usage: scripts/sonar/api.sh '<path-and-query>', for example 'api/system/health'"
[ -f "$ENV_FILE" ] || fail ".env.sonar is missing. Create it with:
$START_HINT"

host="$(env_value SONAR_HOST_URL)"
login="$(env_value SQ_ADMIN_LOGIN)"
password="$(env_value SQ_ADMIN_PASSWORD)"
[ -n "$host" ] && [ -n "$login" ] && [ -n "$password" ] ||
  fail ".env.sonar is incomplete: run npm run sonar:bootstrap"

response="$(curl_config "$login" "$password" |
  curl -sS -K - --get -w '\n%{http_code}' "$host/${1#/}")" ||
  fail "no answer from $host. Start the server with:
$START_HINT"
status="${response##*$'\n'}"
printf '%s\n' "${response%$'\n'*}"
[ "$status" -lt 400 ] || fail "GET ${1%%\?*} answered HTTP $status"
