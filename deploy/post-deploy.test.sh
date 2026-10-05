#!/usr/bin/env bash
# Tests for deploy/post-deploy.sh (rollback decision) and deploy/smoke.sh, with docker, curl, the
# smoke test and blue-green.sh replaced by fakes. Nothing here talks to Docker or the network.
#
#   bash deploy/post-deploy.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0 fail=0

ok() { pass=$((pass + 1)); echo "ok   - $1"; }
not_ok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then echo "$2"; fi; }
# check <name> <cmd...>: ok when the command succeeds.
check() { local name="$1"; shift; if "$@"; then ok "$name"; else not_ok "$name"; fi; }

# ── fakes ─────────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
# docker: `ps` lists $FAKE_RUNNING (running) and $FAKE_EXISTING (all); `cp` streams $FAKE_OLD_TAR.
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  ps) if [ "${2:-}" = "-a" ]; then printf '%s\n' $FAKE_EXISTING; else printf '%s\n' $FAKE_RUNNING; fi ;;
  cp) [ -n "${FAKE_OLD_TAR:-}" ] && cat "$FAKE_OLD_TAR" || exit 1 ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
EOF
# curl: answers from FAKE_CURL_<step> (status code), counting calls; records argv to spot a leaked token.
cat > "$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
stdin=""; out=/dev/null; host=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -K) [ "$2" = "-" ] && stdin="$(cat)"; shift ;;
    -o) out="$2"; shift ;;
    -H) case "$2" in Host:*) host="${2#Host: }" ;; esac; shift ;;
    -w|--max-time|-X|--data) shift ;;
    http*) url="$1" ;;
  esac
  shift
done
n="$(cat "$FAKE_DIR/curl-count" 2>/dev/null || echo 0)"; echo $((n + 1)) > "$FAKE_DIR/curl-count"
case "$url" in
  */api/ready) code="$FAKE_READY" ;;
  */mcp) grep -q "Bearer $EXPECTED_TOKEN\"" <<<"$stdin" && code="$FAKE_MCP" || code=401
         echo '{"result":{"tools":[{"name":"find"}]},"jsonrpc":"2.0","id":1}' > "$out" ;;
  */) if [ "$host" = "termhub.dev" ]; then code="$FAKE_LANDING"; else code="$FAKE_ROOT"; fi ;;
esac
printf '%s' "$code"
EOF
cat > "$WORK/fake-smoke.sh" <<'EOF'
echo "smoke" >> "$FAKE_LOG"; exit "$FAKE_SMOKE_CODE"
EOF
cat > "$WORK/fake-blue-green.sh" <<'EOF'
echo "blue-green $*" >> "$FAKE_LOG"; exit "${FAKE_ROLLBACK_CODE:-0}"
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/curl"

# make_tar <name...>: a tar shaped like `docker cp <c>:.../migrations -` with those migrations.
make_tar() {
  local d="$WORK/old" n
  rm -rf "$d"; mkdir -p "$d/migrations"
  for n in "$@"; do mkdir -p "$d/migrations/$n"; echo "-- $n" > "$d/migrations/$n/migration.sql"; done
  tar -cf "$WORK/old.tar" -C "$d" migrations
  echo "$WORK/old.tar"
}

# add_migration <name> <sql>: a migration in this release's folder.
add_migration() {
  mkdir -p "$WORK/migrations/$1"
  printf '%s\n' "$2" > "$WORK/migrations/$1/migration.sql"
}

# reset: a fresh scenario where blue was just deployed and green is the stopped previous colour.
reset() {
  rm -rf "$WORK/state" "$WORK/migrations" "$WORK/summary" "$WORK/log" "$WORK/curl-count"
  mkdir -p "$WORK/state" "$WORK/migrations"
  echo blue > "$WORK/state/active-color"
  echo abc1234 > "$WORK/state/deployed-sha-green"
  add_migration 20261001000000_old "CREATE TABLE a (id int);"
  export FAKE_LOG="$WORK/log" FAKE_DIR="$WORK" FAKE_SMOKE_CODE=0 FAKE_ROLLBACK_CODE=0
  export FAKE_RUNNING="termhub-app-blue termhub-db-1" FAKE_EXISTING="termhub-app-blue termhub-app-green termhub-db-1"
  FAKE_OLD_TAR="$(make_tar 20261001000000_old)"; export FAKE_OLD_TAR
  export AUTO_ROLLBACK=1
  touch "$WORK/log"
}

run_post_deploy() {
  PATH="$WORK/bin:$PATH" STATE_FILE="$WORK/state/active-color" MIGRATIONS_DIR="$WORK/migrations" \
    SMOKE_SCRIPT="$WORK/fake-smoke.sh" BLUE_GREEN_SCRIPT="$WORK/fake-blue-green.sh" \
    GITHUB_SHA=def5678000 GITHUB_STEP_SUMMARY="$WORK/summary" \
    bash "$SCRIPT_DIR/post-deploy.sh" > "$WORK/out" 2>&1
  echo $?
}

rollbacks() { grep -c '^blue-green --rollback$' "$WORK/log" || true; }

# expect <name> <exit> <rollbacks> <summary regex>
expect() {
  local name="$1" want_code="$2" want_rb="$3" want_summary="$4" code="$5"
  local rb; rb="$(rollbacks)"
  if [ "$code" = "$want_code" ] && [ "$rb" = "$want_rb" ] && grep -qE "$want_summary" "$WORK/summary" 2>/dev/null; then
    ok "$name"
  else
    not_ok "$name (exit $code want $want_code, rollbacks $rb want $want_rb)" "$(cat "$WORK/out" "$WORK/summary" 2>/dev/null)"
  fi
}

# ── post-deploy.sh ────────────────────────────────────────────────────────────
reset
expect "smoke ok -> no rollback, job passes" 0 0 'Smoke test: ok \(blue, def5678\)' "$(run_post_deploy)"
check "records the sha the active colour runs" [ "$(cat "$WORK/state/deployed-sha-blue")" = "def5678" ]

reset; export FAKE_SMOKE_CODE=1
add_migration 20261011000000_new 'CREATE TABLE b (id int); ALTER TABLE "a" ADD COLUMN "dropped_at" TIMESTAMP;'
expect "smoke fails + safe -> rollback once, job fails" 1 1 'revertido para green \(abc1234\)' "$(run_post_deploy)"

reset; export FAKE_SMOKE_CODE=1 FAKE_ROLLBACK_CODE=1
expect "smoke fails + rollback script fails -> job fails, says so" 1 1 'rollback automático falhou' "$(run_post_deploy)"

for sql in 'ALTER TABLE "a" DROP COLUMN "x";' 'ALTER TABLE "a" RENAME COLUMN "x" TO "y";' \
  $'ALTER TABLE "a"\n  ALTER COLUMN "x" SET DATA TYPE TEXT;' 'ALTER TABLE "a" ALTER COLUMN "x" set not null;' 'DROP INDEX "i";'; do
  reset; export FAKE_SMOKE_CODE=1
  add_migration 20261011000000_new "$sql"
  expect "smoke fails + unsafe migration ($(tr '\n' ' ' <<<"$sql" | cut -c1-40)) -> no rollback, job fails" 1 0 'sem rollback automático: migrations added by this release.*20261011000000_new' "$(run_post_deploy)"
done

reset; export FAKE_SMOKE_CODE=1
add_migration 20261001000000_old 'ALTER TABLE "a" DROP COLUMN "x";'
expect "an unsafe migration the previous colour already has does not block" 1 1 'revertido para green' "$(run_post_deploy)"

reset; export FAKE_SMOKE_CODE=1
add_migration 20261011000000_new '-- we do not DROP anything here
CREATE TABLE c (id int);'
expect "a DROP inside a SQL comment does not block" 1 1 'revertido para green' "$(run_post_deploy)"

reset; export FAKE_SMOKE_CODE=1 FAKE_EXISTING="termhub-app-blue termhub-db-1"
expect "first deploy (no stopped colour) -> no rollback, job fails" 1 0 'sem rollback automático: termhub-app-green does not exist' "$(run_post_deploy)"

reset; export FAKE_SMOKE_CODE=1 FAKE_RUNNING="termhub-app-blue termhub-app-green"
expect "previous colour still running -> no rollback" 1 0 'sem rollback automático: termhub-app-green is running' "$(run_post_deploy)"

reset; export FAKE_SMOKE_CODE=1; echo legacy > "$WORK/state/active-color"
expect "active colour not blue/green -> no rollback" 1 0 "sem rollback automático: the active colour is 'legacy'" "$(run_post_deploy)"

reset; export FAKE_SMOKE_CODE=1 FAKE_OLD_TAR=""
expect "previous colour's migrations unreadable -> no rollback" 1 0 'sem rollback automático: could not read the migrations' "$(run_post_deploy)"

reset; export FAKE_SMOKE_CODE=1 AUTO_ROLLBACK=0
expect "DEPLOY_AUTO_ROLLBACK=0 -> no rollback, job fails" 1 0 'sem rollback automático: automatic rollback is turned off' "$(run_post_deploy)"

reset; export FAKE_SMOKE_CODE=2
expect "only the MCP step fails -> no rollback, job fails" 1 0 'só na chamada autenticada' "$(run_post_deploy)"

# ── smoke.sh ──────────────────────────────────────────────────────────────────
TOKEN_VALUE="thb_pat_SECRETsecretSECRETsecret0123456789abcdefg"
run_smoke() {
  rm -f "$WORK/curl-count"; : > "$WORK/log"
  PATH="$WORK/bin:$PATH" SMOKE_DELAY=0 EXPECTED_TOKEN="$TOKEN_VALUE" bash "$SCRIPT_DIR/smoke.sh" > "$WORK/out" 2>&1
  echo $?
}
# expect_smoke <name> <want exit> <output regex> <exit>
expect_smoke() {
  if [ "$4" = "$2" ] && grep -qE "$3" "$WORK/out"; then ok "$1"; else not_ok "$1 (exit $4 want $2)" "$(cat "$WORK/out")"; fi
}
export FAKE_READY=200 FAKE_ROOT=200 FAKE_LANDING=200 FAKE_MCP=200
echo "SMOKE_API_TOKEN=\"$TOKEN_VALUE\"" > "$WORK/env"

code="$(ENV_FILE=/nonexistent run_smoke)"
expect_smoke "smoke: no token -> steps 1, 2, 4 pass, step 3 skipped with a notice" 0 '3\. MCP tools/list: skipped' "$code"

code="$(ENV_FILE="$WORK/env" run_smoke)"
expect_smoke "smoke: token from the env file -> tools/list passes" 0 '3\. MCP tools/list: 200' "$code"
if grep -q "$TOKEN_VALUE" "$WORK/out" "$WORK/log"; then not_ok "smoke: the token is never printed nor passed in argv"; else ok "smoke: the token is never printed nor passed in argv"; fi

export FAKE_READY=502
code="$(ENV_FILE=/nonexistent run_smoke)"
expect_smoke "smoke: /api/ready 502 -> exit 1 after 3 attempts" 1 'attempt 3/3' "$code"
check "smoke: 3 attempts at /api/ready" [ "$(grep -c '/api/ready' "$WORK/log")" = 3 ]

export FAKE_READY=200 FAKE_ROOT=404
code="$(ENV_FILE=/nonexistent run_smoke)"
expect_smoke "smoke: / 404 -> exit 1" 1 'FAILED: the app does not answer' "$code"

export FAKE_ROOT=200 FAKE_LANDING=502
code="$(ENV_FILE=/nonexistent run_smoke)"
expect_smoke "smoke: landing 502 -> reported, still exit 0" 0 'landing problem: reported only' "$code"

export FAKE_LANDING=200 FAKE_MCP=500
code="$(ENV_FILE="$WORK/env" run_smoke)"
expect_smoke "smoke: tools/list 500 -> exit 2 (not a rollback trigger)" 2 'not a rollback trigger' "$code"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
