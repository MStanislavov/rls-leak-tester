#!/usr/bin/env bash
# `npm run sonar`: analyses the working tree and waits for the quality gate, so a failing gate
# fails the command. Extra arguments go to the scanner (for example -Dsonar.organization=... on
# SonarCloud, or -X for debug output).
#
# Credentials: SONAR_TOKEN and SONAR_HOST_URL from the environment when both are set (CI), else
# from the git-ignored .env.sonar, sourced in a subshell. Only those two variables are exported;
# the administrator's password in the same file never reaches the scanner's environment.
#
# No Java is needed: @sonar/scan downloads the JRE and the scanner engine that the server itself
# offers (api/v2/analysis/jres, api/v2/analysis/engine) into ~/.sonar/cache and verifies their
# checksums.
set -euo pipefail

# shellcheck source=scripts/sonar/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

bash "$SONAR_DIR/check.sh"

if [ ! -s coverage/lcov.info ]; then
  fail "coverage/lcov.info is missing or empty: run 'npm run test:coverage' first.
Without it every line would count as uncovered and the gate would judge a wrong number."
fi

(
  # The file is parsed with env_value (lib.sh), never sourced: it must not be able to run code.
  if [ -z "${SONAR_TOKEN:-}" ]; then
    SONAR_TOKEN="$(env_value SONAR_TOKEN)"
  fi
  if [ -z "${SONAR_HOST_URL:-}" ]; then
    SONAR_HOST_URL="$(env_value SONAR_HOST_URL)"
  fi
  export SONAR_TOKEN SONAR_HOST_URL
  exec npx --no-install sonar-scanner-npm -Dsonar.qualitygate.wait=true \
    -Dsonar.qualitygate.timeout=600 "$@"
)
