#!/usr/bin/env bash
# Rebuilds BOTH databases from scratch: drops the public schema, applies every migration
# in filename order (001..099 = Person A, 100..199 = Person B), loads seed data, re-inits Mongo.
#
#   ./scripts/db-reset.sh              # reset + seed
#   ./scripts/db-reset.sh --no-seed    # reset only
#
# WARNING: destroys all data in the local dev databases.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then set -a; . ./.env; set +a; fi
PG_USER="${POSTGRES_USER:-skillmarket}"
PG_DB="${POSTGRES_DB:-skillmarket}"
MONGO_DB="${MONGO_DB:-skillmarket}"
SEED=1
[ "${1:-}" = "--no-seed" ] && SEED=0

echo ">> starting containers"
docker compose up -d --wait

pg() { docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q "$@"; }

echo ">> resetting PostgreSQL schema"
pg -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

for f in db/postgres/migrations/*.sql; do
  echo "   migrate  $f"
  pg < "$f"
done

if [ "$SEED" = 1 ]; then
  for f in db/postgres/seed/*.sql; do
    echo "   seed     $f"
    pg < "$f"
  done
fi

echo ">> resetting MongoDB"
URI="mongodb://localhost:27017/${MONGO_DB}"
docker compose exec -T mongo mongosh --quiet "$URI" --eval "db.dropDatabase()" >/dev/null
docker compose exec -T mongo mongosh --quiet "$URI" < db/mongo/init.js
if [ "$SEED" = 1 ]; then
  docker compose exec -T mongo mongosh --quiet "$URI" < db/mongo/seed.js
fi

echo ">> done. Quick check:"
pg -c "SELECT (SELECT count(*) FROM worker) AS workers, (SELECT count(*) FROM customer) AS customers, (SELECT count(*) FROM availability_slot) AS slots;"
