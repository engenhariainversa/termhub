#!/usr/bin/env bash
# Smoke test of the live app, run by the deploy job right after deploy/blue-green.sh switched the
# proxy (spec docs/superpowers/specs/2026-10-04-automation-safety-spike.md §4.3, R4).
#
# It goes through the local proxy nginx on jarvis with a Host header, which is the path users take
# (proxy nginx -> active colour) without Cloudflare Access in front. Only GET requests, plus one
# read-only MCP tools/list when a token is configured: nothing is written.
#
#   1. GET /api/ready  Host: app.termhub.dev -> 200   (rollback trigger)
#   2. GET /           Host: app.termhub.dev -> 200   (rollback trigger: the web bundle is served)
#   3. POST /mcp tools/list with SMOKE_API_TOKEN (scope read) -> 200 with a tool list
#      Runs only when SMOKE_API_TOKEN is set; skipped with a notice otherwise. A failure fails the
#      job but is not a rollback trigger (a revoked token must not roll production back).
#   4. GET /           Host: termhub.dev -> 200       (landing: reported, never a trigger)
#
# Steps 1-3 get up to SMOKE_ATTEMPTS attempts SMOKE_DELAY seconds apart (default 3 x 10 s, about
# 30 s), so a cold start is not taken for a failure.
#
# Exit codes: 0 = passed; 1 = step 1 or 2 failed (the deploy may roll back); 2 = only step 3 failed.
#
# Env vars:
#   SMOKE_BASE_URL   where the proxy listens (default: http://127.0.0.1)
#   SMOKE_APP_HOST   app Host header (default: app.termhub.dev)
#   SMOKE_LANDING_HOST  landing Host header (default: termhub.dev)
#   SMOKE_ATTEMPTS / SMOKE_DELAY  retry policy (default: 3 / 10)
#   SMOKE_API_TOKEN  personal API token, scope read. When unset, read from the SMOKE_API_TOKEN= line
#                    of ENV_FILE (the server's .env). Never printed.
#   ENV_FILE         the server's .env (default: .env)
set -euo pipefail

BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1}"
APP_HOST="${SMOKE_APP_HOST:-app.termhub.dev}"
LANDING_HOST="${SMOKE_LANDING_HOST:-termhub.dev}"
ATTEMPTS="${SMOKE_ATTEMPTS:-3}"
DELAY="${SMOKE_DELAY:-10}"
ENV_FILE="${ENV_FILE:-.env}"

log() {
  echo "[smoke] $*"
}

# The token from the environment, else from the server's .env. Only that one line is read (the file
# is never sourced), surrounding quotes are dropped, and the value is never echoed.
read_token() {
  if [ -n "${SMOKE_API_TOKEN:-}" ]; then
    printf '%s' "$SMOKE_API_TOKEN"
    return
  fi
  [ -r "$ENV_FILE" ] || return 0
  local line
  line="$(grep -E '^[[:space:]]*SMOKE_API_TOKEN=' "$ENV_FILE" | tail -n1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

TOKEN="$(read_token)"

# status <host> <path>: prints the HTTP status of a GET (000 when the request itself failed).
status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $1" "$BASE_URL$2" || true
}

# mcp_tools_list: 0 when tools/list answers 200 with a result.tools array. The Authorization header
# goes through curl's config on stdin, so the token is neither in argv (ps) nor in the log.
mcp_tools_list() {
  local body_file code
  body_file="$(mktemp)"
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -s -K - -o "$body_file" -w '%{http_code}' --max-time 15 \
    -X POST -H "Host: $APP_HOST" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$BASE_URL/mcp" || true)"
  if [ "$code" = "200" ] && grep -q '"tools"' "$body_file"; then
    rm -f "$body_file"
    log "3. MCP tools/list: 200"
    return 0
  fi
  rm -f "$body_file"
  log "3. MCP tools/list: $code (expected 200 with a tool list)"
  return 1
}

ready=000 root=000 mcp_ok=skipped
for attempt in $(seq 1 "$ATTEMPTS"); do
  log "attempt $attempt/$ATTEMPTS"
  ready="$(status "$APP_HOST" /api/ready)"
  log "1. GET /api/ready (Host: $APP_HOST): $ready"
  root="$(status "$APP_HOST" /)"
  log "2. GET / (Host: $APP_HOST): $root"

  if [ -z "$TOKEN" ]; then
    mcp_ok=skipped
  elif mcp_tools_list; then
    mcp_ok=yes
  else
    mcp_ok=no
  fi

  if [ "$ready" = "200" ] && [ "$root" = "200" ] && [ "$mcp_ok" != "no" ]; then
    break
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$DELAY"
  fi
done

if [ "$mcp_ok" = "skipped" ]; then
  log "3. MCP tools/list: skipped (SMOKE_API_TOKEN is not set; see deploy/README.md)"
fi

landing="$(status "$LANDING_HOST" /)"
if [ "$landing" = "200" ]; then
  log "4. GET / (Host: $LANDING_HOST): 200"
else
  log "4. GET / (Host: $LANDING_HOST): $landing (landing problem: reported only, never a rollback trigger)"
fi

if [ "$ready" != "200" ] || [ "$root" != "200" ]; then
  log "FAILED: the app does not answer through the proxy"
  exit 1
fi
if [ "$mcp_ok" = "no" ]; then
  log "FAILED: the authenticated MCP call did not pass (not a rollback trigger)"
  exit 2
fi
log "passed"
