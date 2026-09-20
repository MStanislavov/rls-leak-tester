#!/usr/bin/env bash
# Prepares the local SonarQube server of docker-compose.yml for this project. Idempotent: run it
# as often as you like, also after the admin password was rotated by an earlier run.
#
#   1. waits until the server reports UP
#   2. rotates the default admin password (admin/admin) to a generated one
#   3. creates the project postgres-rls-leak-tester ("RLS Leak Tester") when it is absent
#   4. revokes and regenerates the project analysis token
#   5. creates the quality gate "RLS Leak Tester" when it is absent, sets the conditions of
#      rules.yaml (thresholds.quality_gate) in the vocabulary of this server's mode, and assigns
#      the gate to the project
#   6. reads the gate back and prints its conditions
#
# The password and the token are written only to the git-ignored .env.sonar (mode 600) and are
# never printed. Endpoints, parameters and metric keys were taken from this server's own listing
# (GET api/webservices/list, GET api/metrics/search; SonarQube Community Build 26.9), and every
# metric key is checked against the running server before it is used.
set -euo pipefail
umask 077

# shellcheck source=scripts/sonar/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOST="${SONAR_BOOTSTRAP_URL:-$DEFAULT_HOST}"
PROJECT_NAME="RLS Leak Tester"
GATE_NAME="RLS Leak Tester"
TOKEN_NAME="rls-leak-tester-analysis"
ADMIN_LOGIN="admin"
DEFAULT_PASSWORD="admin"
WAIT_SECONDS="${SONAR_WAIT_SECONDS:-300}"
ADMIN_PASSWORD=""

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# api METHOD PATH [curl arguments]: an authenticated call as the administrator. Prints the body;
# an HTTP error ends the script with the server's own message.
api() {
  local method="$1" path="$2" response status
  shift 2
  response="$(curl_config "$ADMIN_LOGIN" "$ADMIN_PASSWORD" |
    curl -sS -K - -X "$method" -w '\n%{http_code}' "$@" "$HOST$path")" ||
    fail "$method $path: no answer from $HOST"
  status="${response##*$'\n'}"
  response="${response%$'\n'*}"
  if [ "$status" -ge 400 ]; then
    fail "$method $path answered HTTP $status: $(printf '%s' "$response" | json_get errors 0 msg)"
  fi
  printf '%s' "$response"
}

# json_has ARRAY FIELD VALUE: "yes" when an element of ARRAY on stdin has FIELD equal to VALUE.
json_has() {
  node -e '
    const [list, field, wanted] = process.argv.slice(1);
    const data = JSON.parse(require("node:fs").readFileSync(0, "utf8") || "{}");
    const found = (data[list] ?? []).some((entry) => entry[field] === wanted);
    process.stdout.write(found ? "yes" : "no");
  ' "$@"
}

valid_login() {
  local answer
  answer="$(curl_config "$1" "$2" | curl -sS -K - "$HOST/api/authentication/validate" | json_get valid)"
  [ "$answer" = "true" ]
}

# At least 12 characters with an upper-case and a lower-case letter, a digit and a special
# character (the rule this server states for api/users/change_password). 40 random characters
# carry the entropy; the fixed tail only guarantees the character classes.
generate_password() {
  local random
  random="$(openssl rand -base64 96 | tr -dc 'A-Za-z0-9')"
  printf '%s-Aa1_' "${random:0:40}"
}

# write_env TOKEN PASSWORD: atomically, mode 600, in a format `source` can read.
write_env() {
  local tmp
  tmp="$(mktemp "$REPO_ROOT/.env.sonar.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf '# Written by scripts/sonar/bootstrap.sh. Git-ignored. Never commit it, never print it.\n'
    printf '# SONAR_* is what the scanner reads; SQ_ADMIN_* is only for scripts/sonar/*.sh.\n'
    printf 'SONAR_HOST_URL=%s\n' "$HOST"
    printf 'SONAR_TOKEN=%s\n' "$1"
    printf 'SQ_ADMIN_LOGIN=%s\n' "$ADMIN_LOGIN"
    printf 'SQ_ADMIN_PASSWORD=%s\n' "$2"
  } >"$tmp"
  mv "$tmp" "$ENV_FILE"
}

# --- 0. the ignore rule that keeps the secrets out of git --------------------------------------
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$REPO_ROOT" check-ignore -q .env.sonar ||
    fail ".env.sonar is not git-ignored: add '.env.*' to .gitignore before bootstrapping"
fi

# --- 1. wait for UP ------------------------------------------------------------------------------
say "sonar: waiting for $HOST (up to ${WAIT_SECONDS}s)"
deadline=$((SECONDS + WAIT_SECONDS))
status="$(server_status "$HOST")"
while [ "$status" != "UP" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    fail "the server is not UP (last status: ${status:-no answer}). Start it with:
$START_HINT
and read its log with: docker compose logs --tail 100 sonarqube"
  fi
  sleep 5
  status="$(server_status "$HOST")"
done
version="$(curl -fsS "$HOST/api/system/status" | json_get version)"
say "sonar: server is UP, version $version"

# --- 2. the admin password -----------------------------------------------------------------------
stored_password="$(env_value SQ_ADMIN_PASSWORD)"
stored_token="$(env_value SONAR_TOKEN)"
if [ -n "$stored_password" ] && valid_login "$ADMIN_LOGIN" "$stored_password"; then
  ADMIN_PASSWORD="$stored_password"
  say "sonar: admin password was already rotated; using the one in .env.sonar"
elif valid_login "$ADMIN_LOGIN" "$DEFAULT_PASSWORD"; then
  new_password="$(generate_password)"
  # Written before the change: if the script dies in between, the next run finds a stored
  # password that does not work yet, falls back to the default and rotates again.
  write_env "$stored_token" "$new_password"
  code="$({
    curl_config "$ADMIN_LOGIN" "$DEFAULT_PASSWORD"
    printf 'data-urlencode = "login=%s"\n' "$ADMIN_LOGIN"
    printf 'data-urlencode = "previousPassword=%s"\n' "$DEFAULT_PASSWORD"
    printf 'data-urlencode = "password=%s"\n' "$new_password"
  } | curl -sS -K - -X POST -o /dev/null -w '%{http_code}' "$HOST/api/users/change_password")"
  [ "$code" -lt 400 ] || fail "api/users/change_password answered HTTP $code"
  valid_login "$ADMIN_LOGIN" "$new_password" || fail "the new admin password does not log in"
  ADMIN_PASSWORD="$new_password"
  say "sonar: default admin password rotated; the new one is in .env.sonar only"
else
  fail "neither the password in .env.sonar nor the default one logs in as $ADMIN_LOGIN.
If the password is lost, reset the local server (this deletes its data):
  docker compose down -v && docker compose up -d --wait sonarqube && npm run sonar:bootstrap"
fi

# --- 3. the project ------------------------------------------------------------------------------
projects="$(api GET "/api/projects/search?projects=$PROJECT_KEY")"
if [ "$(printf '%s' "$projects" | json_has components key "$PROJECT_KEY")" = "yes" ]; then
  say "sonar: project $PROJECT_KEY exists"
else
  api POST /api/projects/create --data-urlencode "project=$PROJECT_KEY" \
    --data-urlencode "name=$PROJECT_NAME" --data-urlencode "mainBranch=main" >/dev/null
  say "sonar: project $PROJECT_KEY created"
fi

# --- 4. the analysis token -----------------------------------------------------------------------
tokens="$(api GET "/api/user_tokens/search")"
if [ "$(printf '%s' "$tokens" | json_has userTokens name "$TOKEN_NAME")" = "yes" ]; then
  api POST /api/user_tokens/revoke --data-urlencode "name=$TOKEN_NAME" >/dev/null
  say "sonar: old token \"$TOKEN_NAME\" revoked"
fi
token="$(api POST /api/user_tokens/generate --data-urlencode "name=$TOKEN_NAME" \
  --data-urlencode "type=PROJECT_ANALYSIS_TOKEN" --data-urlencode "projectKey=$PROJECT_KEY" |
  json_get token)"
[ -n "$token" ] || fail "api/user_tokens/generate returned no token"
write_env "$token" "$ADMIN_PASSWORD"
say "sonar: project analysis token \"$TOKEN_NAME\" generated and stored in .env.sonar"

# --- 5. the quality gate -------------------------------------------------------------------------
mqr="$(api GET "/api/settings/values?keys=sonar.multi-quality-mode.enabled" | json_get settings 0 value)"
if [ "$mqr" = "true" ]; then mode="MQR"; else mode="STANDARD"; fi
say "sonar: the server evaluates issues in $mode mode"

gates="$(api GET /api/qualitygates/list)"
if [ "$(printf '%s' "$gates" | json_has qualitygates name "$GATE_NAME")" = "yes" ]; then
  say "sonar: quality gate \"$GATE_NAME\" exists"
else
  api POST /api/qualitygates/create --data-urlencode "name=$GATE_NAME" >/dev/null
  say "sonar: quality gate \"$GATE_NAME\" created"
fi

api GET "/api/metrics/search?ps=500" >"$WORK_DIR/metrics.json"
api GET /api/qualitygates/show --get --data-urlencode "name=$GATE_NAME" >"$WORK_DIR/gate.json"
node "$SONAR_DIR/gate-conditions.mjs" plan "$mode" "$WORK_DIR/gate.json" "$WORK_DIR/metrics.json" \
  >"$WORK_DIR/plan.tsv"
while IFS=$'\t' read -r action id metric op error scope; do
  case "$action" in
    create)
      api POST /api/qualitygates/create_condition --data-urlencode "gateName=$GATE_NAME" \
        --data-urlencode "metric=$metric" --data-urlencode "op=$op" \
        --data-urlencode "error=$error" >/dev/null
      say "sonar:   + $metric $op $error ($scope code)"
      ;;
    update)
      api POST /api/qualitygates/update_condition --data-urlencode "id=$id" \
        --data-urlencode "metric=$metric" --data-urlencode "op=$op" \
        --data-urlencode "error=$error" >/dev/null
      say "sonar:   ~ $metric corrected to $op $error ($scope code)"
      ;;
    missing-metric)
      fail "this server has no metric \"$metric\": adapt scripts/sonar/gate-conditions.mjs to its api/metrics/search"
      ;;
    keep | extra) ;;
    *) fail "unexpected plan line: $action" ;;
  esac
done <"$WORK_DIR/plan.tsv"

api POST /api/qualitygates/select --data-urlencode "gateName=$GATE_NAME" \
  --data-urlencode "projectKey=$PROJECT_KEY" >/dev/null
assigned="$(api GET "/api/qualitygates/get_by_project?project=$PROJECT_KEY" | json_get qualityGate name)"
[ "$assigned" = "$GATE_NAME" ] || fail "the project uses the gate \"$assigned\", not \"$GATE_NAME\""

# --- 6. read back --------------------------------------------------------------------------------
api GET /api/qualitygates/show --get --data-urlencode "name=$GATE_NAME" >"$WORK_DIR/gate.json"
node "$SONAR_DIR/gate-conditions.mjs" plan "$mode" "$WORK_DIR/gate.json" "$WORK_DIR/metrics.json" \
  >"$WORK_DIR/plan.tsv"
if grep -Eq $'^(create|update|missing-metric)\t' "$WORK_DIR/plan.tsv"; then
  fail "the gate read back from the server still differs from rules.yaml"
fi
say "sonar: gate \"$GATE_NAME\" is assigned to $PROJECT_KEY; conditions read back from the server"
say "sonar: (the gate fails when a condition is true; 'extra' ones came with the server's template)"
while IFS=$'\t' read -r action id metric op error scope; do
  if [ "$action" = "extra" ]; then scope="extra, stricter"; fi
  printf '  %-52s %s %-4s [%s]\n' "$metric" "$op" "$error" "$scope"
done <"$WORK_DIR/plan.tsv"
say "sonar: done. Secrets are in .env.sonar (mode $(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")). Next: npm run test:coverage && npm run sonar"
