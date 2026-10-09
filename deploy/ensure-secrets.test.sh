#!/usr/bin/env bash
# Tests for deploy/ensure-secrets.sh, on throwaway .env files.
#
#   bash deploy/ensure-secrets.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0 fail=0

ok() { pass=$((pass + 1)); echo "ok   - $1"; }
not_ok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then echo "$2"; fi; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else not_ok "$name"; fi; }

run() { bash "$SCRIPT_DIR/ensure-secrets.sh" "$@" > "$WORK/out" 2>&1; }
is_hex64() { printf '%s' "$1" | grep -qxE '[0-9a-f]{64}'; }
value_of() { grep -E "^$1=" "$2" | tail -n 1 | cut -d= -f2-; }

# missing: appended, 64 hex chars, the other lines untouched, the value never printed
printf 'A=1\nB=2' > "$WORK/missing.env"
run "$WORK/missing.env" WHISPER_SECRET
v="$(value_of WHISPER_SECRET "$WORK/missing.env")"
check "missing secret is generated" is_hex64 "$v"
check "other lines are kept" grep -qx 'B=2' "$WORK/missing.env"
check "no line glued to the last one" [ "$(grep -c '' "$WORK/missing.env")" = 3 ]
check "the value is not printed" bash -c "! grep -q '$v' '$WORK/out'"

# empty and quoted-empty: replaced, one line left
for empty in 'WHISPER_SECRET=' 'WHISPER_SECRET=""' "WHISPER_SECRET=''"; do
  printf 'A=1\n%s\nC=3\n' "$empty" > "$WORK/empty.env"
  run "$WORK/empty.env" WHISPER_SECRET
  check "[$empty] is filled" is_hex64 "$(value_of WHISPER_SECRET "$WORK/empty.env")"
  check "[$empty] leaves a single line" [ "$(grep -c '^WHISPER_SECRET=' "$WORK/empty.env")" = 1 ]
  check "[$empty] keeps the rest" grep -qx 'C=3' "$WORK/empty.env"
done

# already set: untouched, file byte for byte
printf 'WHISPER_SECRET=chosen-by-the-operator\nX=y\n' > "$WORK/set.env"
cp "$WORK/set.env" "$WORK/set.orig"
run "$WORK/set.env" WHISPER_SECRET
check "a set secret is left alone" cmp -s "$WORK/set.env" "$WORK/set.orig"

# idempotent: the second run keeps the first value
printf 'A=1\n' > "$WORK/twice.env"
run "$WORK/twice.env" WHISPER_SECRET
first="$(value_of WHISPER_SECRET "$WORK/twice.env")"
run "$WORK/twice.env" WHISPER_SECRET
check "a second run keeps the value" [ "$(value_of WHISPER_SECRET "$WORK/twice.env")" = "$first" ]

# file mode survives (the .env is usually 600)
printf 'A=1\n' > "$WORK/mode.env"
chmod 600 "$WORK/mode.env"
printf 'WHISPER_SECRET=\n' >> "$WORK/mode.env"
run "$WORK/mode.env" WHISPER_SECRET
check "file mode is kept" [ "$(stat -c %a "$WORK/mode.env")" = 600 ]

# refusals
check "a missing file fails" bash -c "! bash '$SCRIPT_DIR/ensure-secrets.sh' '$WORK/nope.env' WHISPER_SECRET 2>/dev/null"
check "a bad name fails" bash -c "! bash '$SCRIPT_DIR/ensure-secrets.sh' '$WORK/twice.env' 'A;rm' 2>/dev/null"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
