#!/bin/sh
# Apply db/migrations/*.sql in filename order, skipping any already recorded in
# schema_migrations. Idempotent: re-running applies nothing on an up-to-date database.
#
# Run by the armada-migrate one-shot service in docker-compose.yml, which every other
# service gates on via `depends_on: service_completed_successfully`.
#
# Each migration file wraps itself in BEGIN/COMMIT and records its own version row, so a
# failure part-way leaves that migration fully rolled back rather than half-applied.

set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
PSQL="psql --no-psqlrc --quiet --set ON_ERROR_STOP=1"

if [ -z "${DATABASE_URL:-}" ]; then
    echo "apply-migrations: DATABASE_URL is unset" >&2
    exit 1
fi

echo "apply-migrations: waiting for database"
until $PSQL "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; do
    # The db healthcheck already gates us, but a Postgres image runs a temporary server
    # during first-boot initdb; retry until the real one answers.
    sleep 1
done

# schema_migrations is created by 001_init.sql, so on a first-ever run this query fails.
# Treat that as "nothing applied yet" rather than an error.
applied=$(
    $PSQL "$DATABASE_URL" -tAc \
        'SELECT version FROM schema_migrations' 2>/dev/null || true
)

for file in "$MIGRATIONS_DIR"/*.sql; do
    [ -e "$file" ] || { echo "apply-migrations: no migrations found in $MIGRATIONS_DIR" >&2; exit 1; }

    version=$(basename "$file" .sql)

    if echo "$applied" | grep -qx "$version"; then
        echo "apply-migrations: skip $version (already applied)"
        continue
    fi

    echo "apply-migrations: apply $version"
    $PSQL "$DATABASE_URL" -f "$file"
done

echo "apply-migrations: up to date"
