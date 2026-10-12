#!/usr/bin/env bash
# Encrypted backup of the production database, with rotation (TER-745). Run daily by the
# "Backup do banco" workflow (.github/workflows/db-backup.yml) on jarvis; decisions and restore
# procedure in deploy/README.md, "Database backups".
#
#   1. checks gpg, the database container and the free space in BACKUP_DIR;
#   2. pg_dump (custom format, already compressed) inside the database container, piped to
#      gpg --symmetric (AES256) into BACKUP_DIR/termhub-db-<UTC timestamp>.dump.gpg. Nothing
#      unencrypted touches the disk; the file only gets its final name once the dump finished;
#   3. checks the new file: it decrypts and pg_restore reads its table of contents;
#   4. deletes the backups older than BACKUP_RETENTION_DAYS. A failed run deletes nothing.
#
# Env vars:
#   ENV_FILE               the server's .env (default: .env); only the BACKUP_RETENTION_DAYS= line is
#                          read from it, the file is never sourced
#   BACKUP_DIR             where backups go (default: /mnt/hd2tb/projetos/termhub/backups/db)
#   BACKUP_PASSPHRASE_FILE the gpg passphrase (default: /mnt/hd2tb/projetos/termhub/backup-passphrase).
#                          Created (random, chmod 600) when missing, with a notice: keep a copy outside
#                          jarvis, or the backups die with it. Never printed.
#   BACKUP_RETENTION_DAYS  days a backup is kept (default: from ENV_FILE, else 30)
#   BACKUP_MIN_FREE_MB     refuse to start below this much free space (default: 2048); the run also
#                          needs twice the size of the latest backup
#   DB_CONTAINER           the database container (default: termhub-db-1)
#   GITHUB_STEP_SUMMARY    when set, a short report is appended to it
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/hd2tb/projetos/termhub/backups/db}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/mnt/hd2tb/projetos/termhub/backup-passphrase}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-2048}"
DB_CONTAINER="${DB_CONTAINER:-termhub-db-1}"

log() {
  echo "[db-backup] $*"
}

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

fail() {
  log "FAILED: $*"
  summary "**Backup do banco: falhou** — $*"
  exit 1
}

# env_value <NAME>: the value of NAME= in ENV_FILE (last line wins, quotes dropped), empty when absent.
env_value() {
  [ -r "$ENV_FILE" ] || return 0
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-$(env_value BACKUP_RETENTION_DAYS)}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
case "$RETENTION_DAYS" in
  ''|*[!0-9]*) fail "BACKUP_RETENTION_DAYS must be a whole number of days, got '$RETENTION_DAYS'" ;;
esac
[ "$RETENTION_DAYS" -ge 1 ] || fail "BACKUP_RETENTION_DAYS must be at least 1"

command -v gpg >/dev/null 2>&1 || fail "gpg is not installed on this host (apt install gnupg)"
docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER" || fail "the database container $DB_CONTAINER is not running"

# ── passphrase ──────────────────────────────────────────────────────────────
if [ ! -s "$PASSPHRASE_FILE" ]; then
  (umask 077 && head -c 48 /dev/urandom | base64 | tr -d '\n' > "$PASSPHRASE_FILE")
  log "created a new passphrase in $PASSPHRASE_FILE: keep a copy outside jarvis (password manager)"
  summary "> **Atenção:** criada uma nova chave dos backups em \`$PASSPHRASE_FILE\`. Guarde uma cópia fora do jarvis (gerenciador de senhas): sem ela, nenhum backup pode ser restaurado."
fi
chmod 600 "$PASSPHRASE_FILE"

# ── space ───────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# latest_backup: the newest finished backup (names sort by their UTC timestamp), empty when none.
latest_backup() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'termhub-db-*.dump.gpg' | sort | tail -n1
}
free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
need_kb=$((MIN_FREE_MB * 1024))
previous="$(latest_backup)"
if [ -n "$previous" ]; then
  prev_kb=$(( $(wc -c < "$previous") / 1024 ))
  [ $((prev_kb * 2)) -gt "$need_kb" ] && need_kb=$((prev_kb * 2))
fi
[ "$free_kb" -ge "$need_kb" ] || fail "only $((free_kb / 1024)) MB free in $BACKUP_DIR, $((need_kb / 1024)) MB needed (see deploy/README.md: the disk filled up before with build cache)"

# ── dump ────────────────────────────────────────────────────────────────────
name="termhub-db-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg"
target="$BACKUP_DIR/$name"
partial="$target.partial"
trap 'rm -f "$partial"' EXIT

log "dumping $DB_CONTAINER into $target"
# The container's own POSTGRES_USER/POSTGRES_DB: the dump runs over the local socket, no password.
# --compress-algo none: the custom format is already compressed.
if ! docker exec "$DB_CONTAINER" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
      --symmetric --cipher-algo AES256 --compress-algo none -o "$partial"; then
  fail "pg_dump or gpg failed; nothing was rotated"
fi
chmod 600 "$partial"

# ── check ───────────────────────────────────────────────────────────────────
entries="$(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" --decrypt "$partial" \
  | docker exec -i "$DB_CONTAINER" pg_restore --list | grep -c ' TABLE DATA ' || true)"
[ "${entries:-0}" -gt 0 ] || fail "the new backup does not read back (no table data in its table of contents); nothing was rotated"
mv "$partial" "$target"
trap - EXIT
size_mb="$(awk -v b="$(wc -c < "$target")" 'BEGIN { printf "%.1f", b / 1048576 }')"
log "ok: $name ($size_mb MB, $entries tables with data)"

# ── rotation ────────────────────────────────────────────────────────────────
# A backup is kept RETENTION_DAYS days: data deleted from the database leaves the backups at most
# that long afterwards (the Privacy Policy's "até N dias dos backups"). Leftover .partial files of
# runs that died go too.
removed=0
while IFS= read -r old; do
  [ -n "$old" ] || continue
  [ "$old" = "$target" ] && continue
  rm -f "$old"
  log "removed $(basename "$old") (older than $RETENTION_DAYS days)"
  removed=$((removed + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'termhub-db-*.dump.gpg' -mmin +$((RETENTION_DAYS * 24 * 60)))
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'termhub-db-*.partial' -mmin +720 -delete

kept="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'termhub-db-*.dump.gpg' | wc -l | tr -d ' ')"
free_mb=$(( $(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}') / 1024 ))
log "kept $kept backups, removed $removed, $free_mb MB free"
summary "**Backup do banco: ok** — \`$name\` ($size_mb MB, $entries tabelas com dados). $kept backups guardados (retenção de $RETENTION_DAYS dias), $removed apagados, $free_mb MB livres em \`$BACKUP_DIR\`."

# A backup on the disk that holds the database volume survives a mistake or a corrupted database,
# not the loss of that disk: say so, so it is a known trade-off rather than a surprise.
docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
if [ -n "$docker_root" ]; then
  db_fs="$(df -P "$docker_root" 2>/dev/null | awk 'NR==2 {print $1}' || true)"
  backup_fs="$(df -P "$BACKUP_DIR" | awk 'NR==2 {print $1}')"
  if [ -n "$db_fs" ] && [ "$db_fs" = "$backup_fs" ]; then
    log "note: $BACKUP_DIR is on the same disk as the Docker volumes ($db_fs)"
    summary "> Os backups estão no mesmo disco do volume do banco (\`$db_fs\`): protegem contra erro e corrupção, não contra a perda do disco."
  fi
fi
