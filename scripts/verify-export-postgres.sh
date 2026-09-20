#!/bin/sh
# Runs exported CI checks against a REAL Postgres in Docker, the way the exported workflow does:
# a fresh database per scenario; ONE psql with ON_ERROR_STOP for the setup file, the schema and
# the seed (one session, as in the matrix runner), then one for the test file. Covered: every
# template variant (fixed must exit 0; leaky must fail in the test file with psql's exit status
# 3), the fixtures of tests/export, and the CI use case itself: cross-* folders hold the test file
# of a GOOD scenario beside the schema and seed of its regressed twin. For each, the failing
# cells and preflight lines psql prints must be exactly what expected.txt says: the cells the
# matrix runner reports on PGlite, or the `[setup]` line the preflight must raise.
#
#   sh scripts/verify-export-postgres.sh            # postgres:18-alpine, host port 55432
#   POSTGRES_IMAGE=postgres:17-alpine sh scripts/verify-export-postgres.sh
#
# Not part of the unit test suite (it needs Docker); the quality gate calls it when Docker is up.
# The container is removed on exit, whatever happens.
set -eu

IMAGE="${POSTGRES_IMAGE:-postgres:18-alpine}"
PORT="${POSTGRES_PORT:-55432}"
NAME="rls-leak-tester-export-verify-$$"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"

cleanup() {
  docker rm --force "$NAME" >/dev/null 2>&1 || true
  rm -rf "$OUT"
}
trap cleanup EXIT INT TERM

cd "$ROOT"
echo "== writing the exports to $OUT"
npx tsx tests/export/write-template-exports.ts "$OUT"

echo "== starting $IMAGE as $NAME on 127.0.0.1:$PORT"
docker run --rm --detach --name "$NAME" --publish "127.0.0.1:$PORT:5432" \
  --env POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

attempt=0
# The image starts a temporary server first; only a TCP answer means the real one is up.
until docker exec "$NAME" pg_isready --quiet --host 127.0.0.1 --username postgres; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Postgres did not become ready within 60 seconds" >&2
    exit 1
  fi
  sleep 1
done

admin() {
  docker exec "$NAME" psql --no-psqlrc --quiet --tuples-only --no-align --username postgres --command "$1"
}

# psql runs inside the container, on the files copied into it: several --file options are one
# invocation, so one session, which a file on stdin could not give.
docker cp "$OUT/." "$NAME:/exports"

run_files() {
  # $1 database, then the files (paths inside the container), loaded in order in ONE session.
  database="$1"
  shift
  options=""
  for file in "$@"; do
    options="$options --file $file"
  done
  # shellcheck disable=SC2086 # the options are built above from paths without spaces
  docker exec --env PGTZ=UTC "$NAME" \
    psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --username postgres --dbname "$database" $options
}

admin "select version()"

# What the workflow's loading step relies on: with ON_ERROR_STOP, psql ends at the first error of
# ANY of its files, with exit status 3, and never reaches the next file.
docker exec "$NAME" sh -c "printf 'select 1 / 0;\n' >/exports/stop-a.sql; printf 'create table must_not_exist ();\n' >/exports/stop-b.sql"
stop=0
run_files postgres /exports/stop-a.sql /exports/stop-b.sql >/dev/null 2>&1 || stop=$?
reached="$(admin "select count(*) from pg_class where relname = 'must_not_exist'")"
if [ "$stop" -ne 3 ] || [ "$reached" -ne 0 ]; then
  echo "psql did not stop at the first failing file (exit status $stop, second file ran: $reached)" >&2
  exit 1
fi
echo "-- psql --file a --file b stops at the first error: exit status $stop, the second file did not run"
failures=0
for folder in "$OUT"/*/; do
  scenario="$(basename "$folder")"
  database="$(printf '%s' "$scenario" | tr '-' '_')"
  echo
  echo "== $scenario"
  admin "create database $database"
  loading=""
  for file in rls-isolation.setup.sql rls-isolation.schema.sql rls-isolation.seed.sql; do
    if [ -f "$folder$file" ]; then
      loading="$loading /exports/$scenario/$file"
    fi
  done
  loaded=0
  # shellcheck disable=SC2086 # a list of paths without spaces
  run_files "$database" $loading >"$OUT/$scenario.load.log" 2>&1 || loaded=$?
  grep -v "NOTICE:" "$OUT/$scenario.load.log" || true
  if [ "$loaded" -ne 0 ]; then
    echo "-- UNEXPECTED: setup, schema and seed did not load (psql exit status $loaded)" >&2
    failures=$((failures + 1))
  fi
  status=0
  run_files "$database" "/exports/$scenario/rls-isolation.test.sql" >"$OUT/$scenario.log" 2>&1 || status=$?
  # The last statement's exception: a summary line, then one line per preflight problem and per
  # failed cell. A preflight line is cut after its subject, a cell line after the cell id.
  sed -n '/ERROR:  /,$p' "$OUT/$scenario.log" | cut -c 1-260
  sed -n '/ERROR:  /,$p' "$OUT/$scenario.log" |
    sed -n -E -e 's/^(\[setup\] the (table|rows of|role) [^ ]+) .*/\1/p' -e t \
      -e 's/^(\[[a-z]+\] [^ ]+) .*/\1/p' | LC_ALL=C sort >"$OUT/$scenario.actual"
  echo "-- cells reported ok: $(grep -c 'NOTICE:  ok - ' "$OUT/$scenario.log" || true), psql exit status $status"

  # Roles are cluster-wide; a CI job has one database and creates them once.
  admin "drop database $database"
  for role in $(admin "select rolname from pg_roles where rolname !~ '^pg_' and rolname <> 'postgres'"); do
    admin "drop role \"$role\""
  done

  if [ -s "${folder}expected.txt" ]; then expected=3; else expected=0; fi
  if [ "$status" -ne "$expected" ]; then
    echo "-- UNEXPECTED: psql exit status $status, expected $expected" >&2
    grep -E "ERROR|FATAL" "$OUT/$scenario.log" | head -5 >&2 || true
    failures=$((failures + 1))
  elif ! LC_ALL=C sort "${folder}expected.txt" | diff - "$OUT/$scenario.actual"; then
    echo "-- UNEXPECTED: the failing cells differ from the matrix runner's (< runner, > Postgres)" >&2
    failures=$((failures + 1))
  else
    echo "-- as expected: $(wc -l <"${folder}expected.txt" | tr -d ' ') failing line(s), exactly the expected ones"
  fi
done

echo
if [ "$failures" -gt 0 ]; then
  echo "verify-export-postgres: $failures scenario(s) did not behave as expected on $IMAGE" >&2
  exit 1
fi
echo "verify-export-postgres: every exported check behaved on $IMAGE as the matrix runner says"
