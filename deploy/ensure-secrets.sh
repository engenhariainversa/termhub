#!/usr/bin/env bash
# Makes sure each named shared secret has a value in the server's .env, generating a random one when
# it is missing or empty. Run by the deploy before the services that read it are recreated, so a
# release that makes a secret mandatory (WHISPER_SECRET, TER-585) cannot turn a feature off in
# production just because nobody edited the .env (TER-1035). Never prints a value.
#
#   bash deploy/ensure-secrets.sh <env-file> NAME [NAME...]
set -euo pipefail

ENV_FILE="${1:?usage: ensure-secrets.sh <env-file> NAME [NAME...]}"
shift
[ -f "$ENV_FILE" ] || { echo "ensure-secrets: $ENV_FILE not found" >&2; exit 1; }

for name in "$@"; do
  case "$name" in *[!A-Z0-9_]*|'') echo "ensure-secrets: bad variable name '$name'" >&2; exit 1 ;; esac
  # The last assignment wins, as in docker compose: a non-empty one means the operator already chose a value.
  current="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  current="${current%$'\r'}"
  current="${current//\"/}"
  current="${current//\'/}"
  if [ -n "${current// /}" ]; then
    echo "ensure-secrets: $name already set"
    continue
  fi
  # 32 random bytes as hex: no quoting or sed escaping to worry about.
  value="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # An empty "NAME=" line would win over nothing but lose to ours only if ours comes after it: drop it,
  # writing in place (cat >) so the file keeps its owner and mode.
  if grep -qE "^${name}=" "$ENV_FILE"; then
    kept="$(grep -vE "^${name}=" "$ENV_FILE" || true)"
    printf '%s\n' "$kept" > "$ENV_FILE"
  fi
  # A file without a final newline would glue our line to its last one.
  if [ -s "$ENV_FILE" ] && [ "$(tail -c 1 "$ENV_FILE")" != "" ]; then echo >> "$ENV_FILE"; fi
  printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  echo "ensure-secrets: $name was empty, generated a new value"
done
