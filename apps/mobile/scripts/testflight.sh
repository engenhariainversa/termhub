#!/usr/bin/env bash
# Ships the current `expo.version` to TestFlight from the Mac that builds the app (hulk), once per
# version. The "Mobile TestFlight (hulk)" workflow runs it after a merge to main that changes the
# native app; it can also be run by hand from a clean checkout of main.
#
#   bash apps/mobile/scripts/testflight.sh            # upload expo.version unless it was already uploaded
#   bash apps/mobile/scripts/testflight.sh --force    # upload it again, with a new build number
#
# The build itself is scripts/ios-release.sh --upload (prebuild, archive, export, upload to App Store
# Connect), with the Xcode account or the App Store Connect API key the Mac already has. Nothing is
# read from the repository: ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH, when used, come from the
# environment or from "$STATE_DIR/env", a file kept on the Mac.
#
# The build number is the build's UTC date and time (YYYYMMDDHHMM, the convention of app.json's
# `ios.buildNumber`), so it only grows and app.json is never rewritten.
#
# "$STATE_DIR/ios-<version>" records an upload that App Store Connect accepted (build number, commit).
# A version with that file is skipped: a merge that changes native files without bumping
# `expo.version` does not ship a second build of the same version (CLAUDE.md, "Mobile OTA updates").
#
# Only TestFlight: the build waits there for the testers' group. Submitting for App Store review
# stays manual, in App Store Connect.
set -euo pipefail

cd "$(dirname "$0")/.."

STATE_DIR="${TESTFLIGHT_STATE_DIR:-$HOME/.termhub/testflight}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Step outputs and summary when run by GitHub Actions; no-ops by hand.
output() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >> "$GITHUB_OUTPUT" || true; }
summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$1" >> "$GITHUB_STEP_SUMMARY" || true; }

[ "$(uname -s)" = Darwin ] || { echo "testflight.sh runs on a Mac (Xcode)" >&2; exit 2; }
if [ -n "$(git status --porcelain)" ]; then
  echo "The checkout has uncommitted changes; ship from a clean checkout of main." >&2
  exit 2
fi

VERSION="$(node -p "require('./app.json').expo.version")"
COMMIT="$(git rev-parse HEAD)"
MARKER="$STATE_DIR/ios-$VERSION"
output "version=$VERSION"

if [ -f "$MARKER" ] && [ "$FORCE" = 0 ]; then
  echo "Version $VERSION is already on TestFlight ($(cat "$MARKER")); nothing to do. Bump expo.version for a native change, or pass --force."
  summary "### TestFlight: nada a enviar"
  summary "A versão \`$VERSION\` já foi enviada ($(cat "$MARKER")). Para uma mudança nativa, aumente \`expo.version\`; para reenviar a mesma versão, rode o workflow com \`force\`."
  output "uploaded=false"
  exit 0
fi

mkdir -p "$STATE_DIR"
if [ -f "$STATE_DIR/env" ]; then
  # shellcheck disable=SC1091
  . "$STATE_DIR/env"
fi

BUILD_NUMBER="$(date -u +%Y%m%d%H%M)"
export BUILD_NUMBER
echo "Shipping $VERSION ($BUILD_NUMBER) from ${COMMIT:0:8} to TestFlight"

bash scripts/ios-release.sh --upload

echo "build $BUILD_NUMBER, commit $COMMIT, $(date -u +%Y-%m-%dT%H:%MZ)" > "$MARKER"
output "uploaded=true"
output "build=$BUILD_NUMBER"
summary "### TestFlight: $VERSION ($BUILD_NUMBER) enviado"
summary "Commit \`${COMMIT:0:8}\`. O App Store Connect processa o build em alguns minutos; depois ele aparece no TestFlight para o grupo de testers. Enviar para revisão da App Store continua manual."
