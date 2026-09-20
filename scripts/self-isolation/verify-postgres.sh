#!/bin/sh
# The self-isolation proof against a REAL Postgres in Docker, step by step what the CI job does
# (brief 5.3): generate the proof, load the setup file, load every file of supabase/migrations in
# name order, load the seed, run the exported test with psql and ON_ERROR_STOP. Exit 0 only when
# the test file exits 0, which means: RLS Leak Tester's own scenarios table is ISOLATED.
#
#   sh scripts/self-isolation/verify-postgres.sh            # postgres:18-alpine
#   POSTGRES_IMAGE=postgres:17-alpine sh scripts/self-isolation/verify-postgres.sh
#
# psql runs inside the container (docker exec), so no port is published and nothing but Docker is
# needed on the host. The container is removed on exit, whatever happens.
set -eu

IMAGE="${POSTGRES_IMAGE:-postgres:18-alpine}"
NAME="rls-leak-tester-self-isolation-$$"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d)"

cleanup() {
  docker rm --force "$NAME" >/dev/null 2>&1 || true
  rm -rf "$OUT"
}
trap cleanup EXIT INT TERM

cd "$ROOT"
echo "== generating the proof in $OUT"
npx tsx scripts/self-isolation/generate.ts "$OUT"

echo "== starting $IMAGE as $NAME"
docker run --rm --detach --name "$NAME" --env POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

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
docker exec "$NAME" psql --no-psqlrc --quiet --tuples-only --no-align --username postgres \
  --command "select version()"

run_file() {
  # psql runs inside the container; the file comes in on stdin.
  echo "== psql -v ON_ERROR_STOP=1 -f $1"
  docker exec --interactive --env PGTZ=UTC "$NAME" \
    psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --username postgres --dbname postgres --file - <"$1"
}

load() {
  # A file that prepares the database must load completely; its NOTICEs are noise.
  loaded=0
  run_file "$1" >"$OUT/load.log" 2>&1 || loaded=$?
  grep -v "NOTICE:" "$OUT/load.log" || true
  if [ "$loaded" -ne 0 ]; then
    echo "self-isolation: $1 did not load (psql exit status $loaded)" >&2
    exit 1
  fi
}

load "$OUT/rls-isolation.setup.sql"
for migration in $(ls supabase/migrations/*.sql | LC_ALL=C sort); do
  load "$migration"
done
load "$OUT/rls-isolation.seed.sql"

status=0
run_file "$OUT/rls-isolation.test.sql" >"$OUT/test.log" 2>&1 || status=$?
grep -v "NOTICE:  ok - " "$OUT/test.log" | cut -c 1-260 || true
echo "-- cells reported ok: $(grep -c 'NOTICE:  ok - ' "$OUT/test.log" || true), psql exit status $status"

if [ "$status" -ne 0 ]; then
  echo "self-isolation: the app's own scenarios table is NOT proven isolated on $IMAGE" >&2
  exit 1
fi
echo "self-isolation: the app's own scenarios table is ISOLATED on $IMAGE"
