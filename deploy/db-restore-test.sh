#!/usr/bin/env bash
# Restore test of a database backup (TER-745): restores it into a throwaway Postgres container,
# never the live database, checks what came back and removes the container. Run weekly by the
# "Backup do banco" workflow, and by hand before trusting a backup (deploy/README.md).
#
#   bash deploy/db-restore-test.sh [backup file]     # default: the newest backup in BACKUP_DIR
#
# The container has no network, a throwaway password, and is named th-restore-test (CLAUDE.md:
# throwaway containers are th-*), so it can never be mistaken for a production one.
#
# Env vars:
#   BACKUP_DIR             where backups are (default: /mnt/hd2tb/projetos/termhub/backups/db)
#   BACKUP_PASSPHRASE_FILE the gpg passphrase (default: /mnt/hd2tb/projetos/termhub/backup-passphrase)
#   RESTORE_IMAGE          Postgres image with pgvector (default: termhub-db, the image the db service builds)
#   RESTORE_CONTAINER      container name, must start with th- (default: th-restore-test)
#   RESTORE_WAIT           seconds to wait for Postgres to start (default: 60)
#   GITHUB_STEP_SUMMARY    when set, a short report is appended to it
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/mnt/hd2tb/projetos/termhub/backups/db}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/mnt/hd2tb/projetos/termhub/backup-passphrase}"
IMAGE="${RESTORE_IMAGE:-termhub-db}"
CONTAINER="${RESTORE_CONTAINER:-th-restore-test}"
WAIT="${RESTORE_WAIT:-60}"

log() {
  echo "[restore-test] $*"
}

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

fail() {
  log "FAILED: $*"
  summary "**Teste de restauração: falhou** — $*"
  exit 1
}

case "$CONTAINER" in
  th-*) ;;
  *) fail "RESTORE_CONTAINER must start with th- (got '$CONTAINER')" ;;
esac

backup="${1:-$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'termhub-db-*.dump.gpg' 2>/dev/null | sort | tail -n1)}"
[ -n "$backup" ] && [ -f "$backup" ] || fail "no backup to test in $BACKUP_DIR"
[ -s "$PASSPHRASE_FILE" ] || fail "the passphrase file $PASSPHRASE_FILE is missing"
command -v gpg >/dev/null 2>&1 || fail "gpg is not installed on this host"

# psql_in <sql>: one value from the restored database.
psql_in() {
  docker exec "$CONTAINER" psql -U termhub -d termhub -tAc "$1"
}

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT

log "restoring $(basename "$backup") into $CONTAINER ($IMAGE)"
docker run -d --name "$CONTAINER" --network none \
  -e POSTGRES_USER=termhub -e POSTGRES_PASSWORD=restore-test -e POSTGRES_DB=termhub "$IMAGE" >/dev/null

# Over TCP on purpose: during initdb the image runs a temporary server on the socket only, and a
# restore into it would be lost when it restarts.
ready=no
for _ in $(seq 1 "$WAIT"); do
  if docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U termhub -d termhub; then ready=yes; break; fi
  sleep 1
done
[ "$ready" = yes ] || fail "Postgres did not start in $CONTAINER within ${WAIT}s"

if ! gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" --decrypt "$backup" \
  | docker exec -i "$CONTAINER" pg_restore -U termhub -d termhub --no-owner --exit-on-error; then
  fail "pg_restore failed for $(basename "$backup")"
fi

migrations="$(psql_in 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')"
last_migration="$(psql_in 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1')"
users="$(psql_in 'SELECT count(*) FROM users')"
projects="$(psql_in 'SELECT count(*) FROM projects')"
tasks="$(psql_in 'SELECT count(*) FROM tasks')"
[ "${migrations:-0}" -gt 0 ] || fail "the restored database has no applied migrations"
[ "${users:-0}" -gt 0 ] || fail "the restored database has no users"

log "ok: $migrations migrations (last $last_migration), $users users, $projects projects, $tasks cards"
summary "**Teste de restauração: ok** — \`$(basename "$backup")\` restaurado num banco descartável: $migrations migrations (última \`$last_migration\`), $users usuários, $projects projetos, $tasks cards."
