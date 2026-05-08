#!/usr/bin/env sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 path/to/database.sql [path/to/uploads.tar.gz]"
  exit 1
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
POSTGRES_CONTAINER=${POSTGRES_CONTAINER:-fpv_catalog_postgres}
POSTGRES_USER=${POSTGRES_USER:-fpv_user}
POSTGRES_DB=${POSTGRES_DB:-fpv_catalog}

DB_DUMP=$1

cat "$DB_DUMP" | docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

if [ "$#" -ge 2 ]; then
  tar -xzf "$2" -C "$ROOT_DIR/storage"
fi

echo "Restore complete"
