#!/usr/bin/env bash
# Runs deploy/smoke.sh right after deploy/blue-green.sh switched the proxy and, when the app does
# not answer, rolls back one step with `deploy/blue-green.sh --rollback` if that is safe
# (spec docs/superpowers/specs/2026-10-04-automation-safety-spike.md §4.3-4.4, R4).
#
# The rollback happens only here (inside the deploy job), only one step back, only when the smoke
# test's app checks fail (steps 1-2), and only when:
#   - the active colour is blue or green and the other colour exists and is stopped (there is no
#     stopped colour right after the very first blue/green deploy);
#   - no migration added by this release contains DROP, RENAME, ALTER ... TYPE or SET NOT NULL (the
#     previous release may not work against such a schema, and a healthcheck would not show it).
# Never a revert commit, and never a release (npm / OTA). Whatever happens after a failed smoke
# test, this script exits 1 so the deploy job fails and someone looks at it; the run summary says
# what was done.
#
# Env vars:
#   STATE_FILE      the active colour written by blue-green.sh (default: /mnt/hd2tb/projetos/termhub/active-color)
#   AUTO_ROLLBACK   1 (default) rolls back when safe; 0 only reports (repository variable DEPLOY_AUTO_ROLLBACK)
#   GITHUB_SHA      the commit being deployed (set by GitHub Actions)
#   GITHUB_STEP_SUMMARY  the run summary file (set by GitHub Actions; stdout only when unset)
#   SMOKE_SCRIPT / BLUE_GREEN_SCRIPT  overridable for the tests (deploy/post-deploy.test.sh)
#   MIGRATIONS_DIR  this release's migrations (default: apps/server/prisma/migrations)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

STATE_FILE="${STATE_FILE:-/mnt/hd2tb/projetos/termhub/active-color}"
STATE_DIR="$(dirname "$STATE_FILE")"
AUTO_ROLLBACK="${AUTO_ROLLBACK:-1}"
SMOKE_SCRIPT="${SMOKE_SCRIPT:-$SCRIPT_DIR/smoke.sh}"
BLUE_GREEN_SCRIPT="${BLUE_GREEN_SCRIPT:-$SCRIPT_DIR/blue-green.sh}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-apps/server/prisma/migrations}"
CONTAINER_MIGRATIONS="/app/apps/server/prisma/migrations"
SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
SHA="${SHA:0:7}"

log() {
  echo "[post-deploy] $*"
}

summary() {
  echo "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

active="$(cat "$STATE_FILE" 2>/dev/null || true)"
case "$active" in
  blue) previous=green ;;
  green) previous=blue ;;
  *) previous="" ;;
esac

# Which commit each colour runs, so a rollback can say what it went back to.
if [ -n "$previous" ]; then
  echo "$SHA" > "$STATE_DIR/deployed-sha-$active" 2>/dev/null || log "could not record the deployed sha (ignored)"
fi

smoke_code=0
bash "$SMOKE_SCRIPT" || smoke_code=$?

if [ "$smoke_code" = "0" ]; then
  summary "### Smoke test: ok ($active, $SHA)"
  exit 0
fi

if [ "$smoke_code" != "1" ]; then
  summary "### Smoke test falhou só na chamada autenticada (MCP tools/list), sem rollback automático"
  summary "The app answers through the proxy; check SMOKE_API_TOKEN (deploy/README.md). Active: $active ($SHA)."
  exit 1
fi

# Prints why rolling back is not safe, or nothing when it is.
unsafe_reason() {
  if [ "$AUTO_ROLLBACK" != "1" ]; then
    echo "automatic rollback is turned off (DEPLOY_AUTO_ROLLBACK=$AUTO_ROLLBACK)"
    return
  fi
  if [ -z "$previous" ]; then
    echo "the active colour is '${active:-unknown}', not blue or green"
    return
  fi
  local prev_container="termhub-app-$previous"
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$prev_container"; then
    echo "$prev_container does not exist (first blue/green deploy: no stopped colour to go back to)"
    return
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$prev_container"; then
    echo "$prev_container is running, not stopped"
    return
  fi

  # The migrations this release added: the ones in this checkout that the previous colour's image
  # does not have. docker cp reads a stopped container's filesystem and changes nothing.
  local old_list
  if ! old_list="$(docker cp "$prev_container:$CONTAINER_MIGRATIONS" - | tar -tf - | sed -nE 's#^migrations/([^/]+)/.*#\1#p' | sort -u)" || [ -z "$old_list" ]; then
    echo "could not read the migrations of $prev_container"
    return
  fi
  local dir name risky=""
  for dir in "$MIGRATIONS_DIR"/*/; do
    name="$(basename "$dir")"
    grep -qxF "$name" <<<"$old_list" && continue
    [ -f "$dir/migration.sql" ] || continue
    # Comments dropped, statements joined on one line so ALTER ... TYPE split over lines is seen.
    if sed -E 's/--.*$//' "$dir/migration.sql" | tr '\n' ' ' |
      grep -qiE '\bDROP\b|\bRENAME\b|\bALTER\b[^;]*\bTYPE\b|\bSET[[:space:]]+NOT[[:space:]]+NULL\b'; then
      risky="$risky $name"
    fi
  done
  if [ -n "$risky" ]; then
    echo "migrations added by this release may not be backward compatible (DROP / RENAME / ALTER ... TYPE / SET NOT NULL):$risky"
    return
  fi
}

reason="$(unsafe_reason)"
if [ -n "$reason" ]; then
  summary "### Smoke test falhou: sem rollback automático: $reason"
  summary "Active colour: ${active:-unknown} ($SHA). Follow the manual rollback in deploy/README.md."
  exit 1
fi

previous_sha="$(cat "$STATE_DIR/deployed-sha-$previous" 2>/dev/null || echo "sha desconhecido")"
log "smoke test failed; rolling back to $previous"
if bash "$BLUE_GREEN_SCRIPT" --rollback; then
  summary "### Smoke test falhou: revertido para $previous ($previous_sha)"
  summary "$active ($SHA) was stopped and kept for inspection. main still holds the broken commit: the next push to main redeploys it, so fix main first."
else
  summary "### Smoke test falhou e o rollback automático falhou"
  summary "deploy/blue-green.sh --rollback exited non-zero (see the log). It never switches to a colour that is not healthy, so $active ($SHA) may still be serving. Act by hand (deploy/README.md)."
fi
exit 1
