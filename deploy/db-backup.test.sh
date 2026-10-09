#!/usr/bin/env bash
# Tests for deploy/db-backup.sh (dump, check, rotation) and deploy/db-restore-test.sh, with docker
# and gpg replaced by fakes. Nothing here talks to Docker or touches a real database.
#
#   bash deploy/db-backup.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0 fail=0

ok() { pass=$((pass + 1)); echo "ok   - $1"; }
not_ok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then echo "$2"; fi; }
# check <name> <cmd...>: ok when the command succeeds.
check() { local name="$1"; shift; if "$@"; then ok "$name"; else not_ok "$name" "$(cat "$WORK/out" "$WORK/summary" 2>/dev/null)"; fi; }

# ── fakes ─────────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
# docker: `ps` lists $FAKE_RUNNING; `exec … sh` is pg_dump ($FAKE_DUMP_FAIL=1 fails it);
# `exec -i … pg_restore` reads stdin, then lists a table of contents (--list, empty with
# $FAKE_TOC_EMPTY=1) or exits $FAKE_RESTORE_CODE; `exec … psql` answers the restore test's counts.
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  ps) printf '%s\n' $FAKE_RUNNING ;;
  info) echo "$FAKE_DOCKER_ROOT" ;;
  run) echo fakecid ;;
  rm) ;;
  exec)
    shift; [ "$1" = "-i" ] && shift; shift
    case "$1" in
      sh) [ "${FAKE_DUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: error: connection failed" >&2; exit 1; }; printf 'PGDMP fake dump' ;;
      pg_restore)
        input="$(cat)"
        [ "$input" = "PGDMP fake dump" ] || { echo "pg_restore: not a dump: $input" >&2; exit 1; }
        case " $* " in
          *" --list "*) [ "${FAKE_TOC_EMPTY:-0}" = 1 ] || printf '3456; 0 16390 TABLE DATA public users termhub\n3457; 0 16400 TABLE DATA public tasks termhub\n' ;;
          *) exit "${FAKE_RESTORE_CODE:-0}" ;;
        esac ;;
      pg_isready) exit 0 ;;
      psql)
        case "$*" in
          *migration_name*) echo 20261001000000_last ;;
          *_prisma_migrations*) echo 120 ;;
          *users*) echo "${FAKE_USERS:-3}" ;;
          *) echo 7 ;;
        esac ;;
      *) echo "unexpected docker exec: $*" >&2; exit 99 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
EOF
# gpg: "encrypts" stdin to -o as ENC:<data> and decrypts a file back; refuses without a passphrase file.
cat > "$WORK/bin/gpg" <<'EOF'
#!/usr/bin/env bash
echo "gpg $*" >> "$FAKE_LOG"
out="" in="" pf="" decrypt=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --passphrase-file) pf="$2"; shift ;;
    --cipher-algo|--compress-algo|--pinentry-mode) shift ;;
    --decrypt) decrypt=1 ;;
    -*) ;;
    *) in="$1" ;;
  esac
  shift
done
[ -s "$pf" ] || { echo "gpg: no passphrase" >&2; exit 2; }
if [ "$decrypt" = 1 ]; then
  data="$(cat "$in")"; [ "${data#ENC:}" != "$data" ] || exit 2
  printf '%s' "${data#ENC:}"
else
  { printf 'ENC:'; cat; } > "$out"
fi
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/gpg"

# days_ago <n>: a touch -t stamp n days back (GNU or BSD date).
days_ago() { date -d "$1 days ago" +%Y%m%d%H%M 2>/dev/null || date -v-"$1"d +%Y%m%d%H%M; }
# old_backup <n>: a finished backup file dated n days back.
old_backup() {
  local f="$WORK/backups/termhub-db-old-$1d.dump.gpg"
  printf 'ENC:PGDMP fake dump' > "$f"
  touch -t "$(days_ago "$1")" "$f"
}
backups() { find "$WORK/backups" -maxdepth 1 -type f -name 'termhub-db-*' -exec basename {} \; | sort; }
new_backups() { backups | grep -v -- '-old-' || true; }

reset() {
  rm -rf "$WORK/backups" "$WORK/pass" "$WORK/summary" "$WORK/log" "$WORK/env" "$WORK/dockerroot"
  mkdir -p "$WORK/backups" "$WORK/dockerroot"
  export FAKE_LOG="$WORK/log" FAKE_RUNNING="termhub-app-blue termhub-db-1" FAKE_DOCKER_ROOT="$WORK/dockerroot"
  export FAKE_DUMP_FAIL=0 FAKE_TOC_EMPTY=0 FAKE_RESTORE_CODE=0 FAKE_USERS=3
  touch "$WORK/log"
}

run_backup() {
  PATH="$WORK/bin:$PATH" ENV_FILE="$WORK/env" BACKUP_DIR="$WORK/backups" BACKUP_PASSPHRASE_FILE="$WORK/pass" \
    BACKUP_MIN_FREE_MB="${MIN_FREE:-1}" GITHUB_STEP_SUMMARY="$WORK/summary" \
    bash "$SCRIPT_DIR/db-backup.sh" > "$WORK/out" 2>&1
  echo $?
}

run_restore() {
  PATH="$WORK/bin:$PATH" BACKUP_DIR="$WORK/backups" BACKUP_PASSPHRASE_FILE="$WORK/pass" RESTORE_WAIT=2 \
    GITHUB_STEP_SUMMARY="$WORK/summary" bash "$SCRIPT_DIR/db-restore-test.sh" "$@" > "$WORK/out" 2>&1
  echo $?
}

perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# ── db-backup.sh ──────────────────────────────────────────────────────────────
reset
code="$(run_backup)"
check "backup: passes" [ "$code" = 0 ]
check "backup: one encrypted file with a UTC timestamp, no .partial left" \
  [ "$(new_backups | grep -cE '^termhub-db-[0-9]{8}T[0-9]{6}Z\.dump\.gpg$')" = 1 -a "$(backups | grep -c partial)" = 0 ]
f="$WORK/backups/$(new_backups | head -n1)"
check "backup: the file is the encrypted dump (nothing in clear on disk)" [ "$(cat "$f")" = "ENC:PGDMP fake dump" ]
check "backup: the file and the folder are private" [ "$(perm "$f")" = 600 -a "$(perm "$WORK/backups")" = 700 ]
check "backup: a missing passphrase is created, private, with a notice to copy it" \
  [ -s "$WORK/pass" -a "$(perm "$WORK/pass")" = 600 ]
check "backup: the notice is in the summary" grep -q 'Guarde uma cópia fora do jarvis' "$WORK/summary"
if grep -qF "$(cat "$WORK/pass")" "$WORK/out" "$WORK/summary" "$WORK/log"; then not_ok "backup: the passphrase is never printed nor in argv"; else ok "backup: the passphrase is never printed nor in argv"; fi
check "backup: checks the file reads back (pg_restore --list)" grep -q 'pg_restore --list' "$WORK/log"
check "backup: summary reports ok and the retention" grep -q 'Backup do banco: ok.*retenção de 30 dias' "$WORK/summary"
check "backup: says when the backups share the database volume's disk" grep -q 'mesmo disco do volume do banco' "$WORK/summary"

pass_before="$(cat "$WORK/pass")"
: > "$WORK/summary"
code="$(run_backup)"
check "backup: an existing passphrase is kept, without the notice" [ "$code" = 0 -a "$(cat "$WORK/pass")" = "$pass_before" ]
check "backup: no notice the second time" bash -c "! grep -q 'Guarde uma cópia' '$WORK/summary'"

reset
old_backup 31; old_backup 29
code="$(run_backup)"
check "rotation: a backup past 30 days goes, a younger one stays" \
  [ "$code" = 0 -a "$(backups | grep -c -- '-old-31d')" = 0 -a "$(backups | grep -c -- '-old-29d')" = 1 ]
check "rotation: says what it removed" grep -q 'removed termhub-db-old-31d.dump.gpg' "$WORK/out"

reset
old_backup 8; old_backup 6
echo 'BACKUP_RETENTION_DAYS="7"' > "$WORK/env"
code="$(run_backup)"
check "rotation: BACKUP_RETENTION_DAYS from the server's .env" \
  [ "$code" = 0 -a "$(backups | grep -c -- '-old-8d')" = 0 -a "$(backups | grep -c -- '-old-6d')" = 1 ]

reset
echo 'BACKUP_RETENTION_DAYS=thirty' > "$WORK/env"
code="$(run_backup)"
check "an invalid retention fails before dumping" [ "$code" = 1 -a "$(grep -c 'exec' "$WORK/log")" = 0 ]

reset
old_backup 40
export FAKE_DUMP_FAIL=1
code="$(run_backup)"
check "pg_dump fails -> job fails, no new file, no .partial, nothing rotated" \
  [ "$code" = 1 -a -z "$(new_backups)" -a "$(backups | grep -c -- '-old-40d')" = 1 ]
check "pg_dump fails -> summary says so" grep -q 'Backup do banco: falhou.*nothing was rotated' "$WORK/summary"

reset
old_backup 40
export FAKE_TOC_EMPTY=1
code="$(run_backup)"
check "a backup that does not read back -> job fails, no new file, nothing rotated" \
  [ "$code" = 1 -a -z "$(new_backups)" -a "$(backups | grep -c -- '-old-40d')" = 1 ]

reset
code="$(MIN_FREE=999999999 run_backup)"
check "not enough free space -> fails before dumping" [ "$code" = 1 -a "$(grep -c 'exec' "$WORK/log")" = 0 ]
check "not enough free space -> says how much is needed" grep -q 'MB needed' "$WORK/out"

reset
export FAKE_RUNNING="termhub-app-blue"
code="$(run_backup)"
check "database container not running -> fails" [ "$code" = 1 ]
check "database container not running -> says which" grep -q 'termhub-db-1 is not running' "$WORK/out"

# ── db-restore-test.sh ────────────────────────────────────────────────────────
reset
run_backup > /dev/null
: > "$WORK/log"; : > "$WORK/summary"
code="$(run_restore)"
check "restore: the newest backup restores into a throwaway th-restore-test" [ "$code" = 0 ]
check "restore: the container has no network" grep -q 'docker run -d --name th-restore-test --network none' "$WORK/log"
check "restore: the container is removed afterwards" [ "$(tail -n1 "$WORK/log")" = "docker rm -f th-restore-test" ]
check "restore: summary reports the counts" grep -q 'Teste de restauração: ok.*120 migrations.*3 usuários' "$WORK/summary"
check "restore: never touches the live database container" bash -c "! grep -q 'termhub-db-1' '$WORK/log'"

: > "$WORK/log"
code="$(RESTORE_CONTAINER=termhub-db-1 run_restore)"
check "restore: refuses a container name outside th-*" [ "$code" = 1 -a ! -s "$WORK/log" ]

export FAKE_RESTORE_CODE=1
: > "$WORK/log"
code="$(run_restore)"
check "restore: pg_restore fails -> fails, container still removed" [ "$code" = 1 -a "$(tail -n1 "$WORK/log")" = "docker rm -f th-restore-test" ]

export FAKE_RESTORE_CODE=0 FAKE_USERS=0
code="$(run_restore)"
check "restore: a database without users fails" [ "$code" = 1 ]

rm -f "$WORK"/backups/*
code="$(run_restore)"
check "restore: no backup -> fails with a message" [ "$code" = 1 ]
check "restore: no backup -> says so" grep -q 'no backup to test' "$WORK/out"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
