#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_DIR="$ROOT_DIR/storage/backups"
DB_DIR="$BACKUP_DIR/database"
FILES_DIR="$BACKUP_DIR/files"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$DB_DIR" "$FILES_DIR"

POSTGRES_CONTAINER=${POSTGRES_CONTAINER:-fpv_catalog_postgres}
POSTGRES_USER=${POSTGRES_USER:-fpv_user}
POSTGRES_DB=${POSTGRES_DB:-fpv_catalog}

docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > "$DB_DIR/fpv_catalog_$TIMESTAMP.sql"
tar -czf "$FILES_DIR/fpv_uploads_$TIMESTAMP.tar.gz" -C "$ROOT_DIR/storage" uploads exports
tar -czf "$BACKUP_DIR/fpv_catalog_full_$TIMESTAMP.tar.gz" -C "$ROOT_DIR" docker-compose.yml .env storage

echo "Backup written to $BACKUP_DIR"
