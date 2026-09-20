# shellcheck shell=bash
# Shared by the scripts in this directory. Sourced, never executed.
#
# Secrets discipline: credentials reach curl through a config read from stdin (`curl -K -`), so
# they never appear in a process list; nothing here echoes a password or a token, and no script in
# this directory may run with `set -x`.

SONAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SONAR_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.sonar"
DEFAULT_HOST="http://127.0.0.1:9000"
PROJECT_KEY="postgres-rls-leak-tester"

START_HINT="  docker compose up -d --wait sonarqube   # first start takes 2 to 4 minutes
  npm run sonar:bootstrap                 # rotates the admin password, writes .env.sonar"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'sonar: %s\n' "$*" >&2
  exit 1
}

# env_value KEY: the value of KEY in .env.sonar, or nothing. The file is parsed, not sourced.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

# json_get key [key ...]: reads JSON on stdin and prints the value at that path, or nothing.
json_get() {
  node -e '
    let value = JSON.parse(require("node:fs").readFileSync(0, "utf8") || "null");
    for (const key of process.argv.slice(1)) value = value?.[key];
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$@"
}

# server_status HOST: UP, STARTING, ... or nothing when the server does not answer.
server_status() {
  curl -fsS --max-time 5 "$1/api/system/status" 2>/dev/null | json_get status 2>/dev/null || true
}

# curl_config LOGIN PASSWORD: a curl config with basic auth; a token is a login with no password.
curl_config() {
  local login="${1//\\/\\\\}" password="${2//\\/\\\\}"
  printf 'user = "%s:%s"\n' "${login//\"/\\\"}" "${password//\"/\\\"}"
}
