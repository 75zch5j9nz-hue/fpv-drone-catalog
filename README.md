# FPV Drone Catalog

Self-hosted Docker Compose system for cataloguing FPV drones and archiving Betaflight configuration snapshots.

## MVP scope

- Next.js frontend for browser access
- FastAPI backend for drone CRUD, uploads, snapshots, notes, and comparison
- PostgreSQL for metadata
- Persistent Docker volumes for uploaded files and generated exports
- Backup and restore helper scripts

## Quick start

1. Copy `.env.example` to `.env` and adjust secrets.
2. Run `docker compose up -d --build`.
3. Open `http://localhost:${FRONTEND_PORT:-3000}`.
4. Verify the backend at `http://localhost:8000/health`.

## Storage model

- Metadata lives in PostgreSQL.
- Original uploads live under `storage/uploads`.
- Generated exports live under `storage/exports`.
- Manual backups land in `storage/backups`.

## Core features

- Drone CRUD
- Snapshot creation
- Upload Betaflight dumps and paste raw CLI text
- Mark snapshots as current or known-good
- Compare snapshots using a line-based diff
- Track flight notes and maintenance events
- Download original files through backend endpoints
