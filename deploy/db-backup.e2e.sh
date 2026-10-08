#!/usr/bin/env bash
# End-to-end test of deploy/db-backup.sh and deploy/db-restore-test.sh with the real Docker, gpg,
# pg_dump and pg_restore (TER-745): a throwaway Postgres with pgvector gets the real migrations and a
# user, is backed up, and the backup is restored into another throwaway container. Run by the CI
# check job (needs Docker, gpg, and `npm ci` done for prisma); never on jarvis.
#
#   bash deploy/db-backup.e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE="${E2E_IMAGE:-pgvector/pgvector:pg16}"
DB=th-e2e-backup-db
PORT="${E2E_PORT:-5499}"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$DB" th-e2e-restore >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
cleanup
mkdir -p "$WORK"

docker run -d --name "$DB" -p "127.0.0.1:$PORT:5432" \
  -e POSTGRES_USER=termhub -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=termhub "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$DB" pg_isready -q -h 127.0.0.1 -U termhub -d termhub && break
  sleep 1
done

(cd "$ROOT/apps/server" && DATABASE_URL="postgresql://termhub:e2e@127.0.0.1:$PORT/termhub" npx prisma migrate deploy >/dev/null)
docker exec "$DB" psql -U termhub -d termhub -qc "INSERT INTO users (id, email, name) VALUES ('e2e', 'e2e@example.com', 'E2E')"

BACKUP_DIR="$WORK/backups" BACKUP_PASSPHRASE_FILE="$WORK/pass" DB_CONTAINER="$DB" ENV_FILE=/nonexistent \
  BACKUP_MIN_FREE_MB=1 bash "$SCRIPT_DIR/db-backup.sh"

backup="$(find "$WORK/backups" -name 'termhub-db-*.dump.gpg' | head -n1)"
if head -c 5 "$backup" | grep -q PGDMP; then
  echo "FAIL - the backup file is a plain dump"; exit 1
fi

BACKUP_DIR="$WORK/backups" BACKUP_PASSPHRASE_FILE="$WORK/pass" RESTORE_IMAGE="$IMAGE" RESTORE_CONTAINER=th-e2e-restore \
  bash "$SCRIPT_DIR/db-restore-test.sh"

# A wrong passphrase must not restore anything.
echo wrong > "$WORK/wrong"
if BACKUP_DIR="$WORK/backups" BACKUP_PASSPHRASE_FILE="$WORK/wrong" RESTORE_IMAGE="$IMAGE" RESTORE_CONTAINER=th-e2e-restore \
  bash "$SCRIPT_DIR/db-restore-test.sh" >/dev/null 2>&1; then
  echo "FAIL - a wrong passphrase restored the backup"; exit 1
fi
echo "e2e: backup, encryption and restore passed"
