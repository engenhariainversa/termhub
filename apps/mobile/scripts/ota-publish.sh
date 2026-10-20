#!/usr/bin/env bash
# Publishes the current JS bundle as an over-the-air update to the xprem server, on both platforms.
#
#   bash scripts/ota-publish.sh                           # message: the last commit's subject
#   bash scripts/ota-publish.sh -m "what changed"
#   bash scripts/ota-publish.sh --rollout-percentage 20   # any other flag goes to `eoas publish`
#
# The update goes to the `production` branch under runtime version `expo.version` (app.json), so
# only binaries of that exact version take it: publish from the commit the store build was cut
# from, plus JS-only changes. Anything that touches native code (a new native module, a config
# plugin, app.json fields prebuild reads) needs a new binary with a bumped `expo.version` instead.
# Older builds listed in ota-runtimes.js get the same bundle under their own runtime version.
#
# The token is a publishing API key of the termhub app on xprem: EOO_TOKEN when set (CI passes the
# XPREM_TOKEN secret), otherwise the macOS Keychain item `xprem-token-termhub`. eoas refuses to
# publish from a dirty working tree, so the update always matches a commit.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${EOO_TOKEN:-}" ] && command -v security >/dev/null 2>&1; then
  EOO_TOKEN="$(security find-generic-password -s xprem-token-termhub -w 2>/dev/null || true)"
fi
[ -n "${EOO_TOKEN:-}" ] || {
  echo "no xprem token: set EOO_TOKEN, or store one in the Keychain as xprem-token-termhub" >&2
  exit 2
}
export EOO_TOKEN

# The same values the store builds bake in (scripts/ios-release.sh); without them the bundle
# would fall back to mock mode (src/services/api/index.ts).
export EXPO_PUBLIC_API_MODE=http
export EXPO_PUBLIC_TERMHUB_URL=https://termhub.dev

npm run build:contract
npx -y eoas@3 publish --branch production --platform all --nonInteractive "$@"

# The same bundle for older builds listed as compatible with this version (ota-runtimes.js).
for runtime in $(node ota-runtimes.js); do
  echo "Also publishing for compatible runtime $runtime"
  OTA_RUNTIME_VERSION="$runtime" npx -y eoas@3 publish --branch production --platform all --nonInteractive "$@"
done
