#!/usr/bin/env bash
# The preflight of `npm run quality` and of `npm run sonar`: is there a server to scan against?
# Exits 0 when SONAR_HOST_URL and SONAR_TOKEN are known (environment, else .env.sonar) and the
# server reports UP; otherwise exits 1 with the commands that fix it. Prints no secret.
set -euo pipefail

# shellcheck source=scripts/sonar/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ -n "${SONAR_TOKEN:-}" ] && [ -n "${SONAR_HOST_URL:-}" ]; then
  host="$SONAR_HOST_URL"
  origin="the environment"
else
  [ -f "$ENV_FILE" ] || fail ".env.sonar is missing and SONAR_TOKEN / SONAR_HOST_URL are not set. Run:
$START_HINT"
  host="$(env_value SONAR_HOST_URL)"
  [ -n "$host" ] && [ -n "$(env_value SONAR_TOKEN)" ] ||
    fail ".env.sonar is incomplete. Run:
$START_HINT"
  origin=".env.sonar"
fi

status="$(server_status "$host")"
[ "$status" = "UP" ] || fail "the SonarQube server at $host is not UP (status: ${status:-no answer}). Run:
$START_HINT"
say "sonar: $host is UP; credentials come from $origin"
