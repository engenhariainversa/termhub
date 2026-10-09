#!/usr/bin/env bash
# Builds the iOS app for TestFlight on a Mac, without EAS.
#
#   bash scripts/ios-release.sh            # prebuild, archive, export build/export/termhub.ipa
#   bash scripts/ios-release.sh --upload   # same, then upload the build to App Store Connect
#
# Signing is Xcode's automatic signing for team S873WHF2TZ, under the Apple ID signed in to
# Xcode (Settings → Accounts). The distribution certificate is cloud-managed: its private key
# never sits in the local keychain, Xcode signs the export through Apple, and
# `-allowProvisioningUpdates` lets it create or refresh the App Store profile.
#
# Optionally, an App Store Connect API key with access to the team signs and uploads instead of
# the Xcode account, so a release no longer depends on an Apple ID staying signed in to Xcode:
#
#   ASC_KEY_ID=ABC123DEFG ASC_ISSUER_ID=<issuer uuid> bash scripts/ios-release.sh --upload
#
# ASC_KEY_PATH points at the .p8 file; it defaults to
# ~/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8. Without ASC_KEY_ID the script uses the
# Xcode account, as before.
#
# Bump `expo.version` and/or `expo.ios.buildNumber` in app.json before each upload: App Store
# Connect refuses a build number it has already seen for the same version. BUILD_NUMBER, when set,
# replaces `expo.ios.buildNumber` in the generated Info.plist without touching app.json
# (scripts/testflight.sh sets it).
set -euo pipefail

cd "$(dirname "$0")/.."

TEAM_ID="${TEAM_ID:-S873WHF2TZ}"
UPLOAD=0
[ "${1:-}" = "--upload" ] && UPLOAD=1

AUTH_ARGS=()
if [ -n "${ASC_KEY_ID:-}" ]; then
  [ -n "${ASC_ISSUER_ID:-}" ] || { echo "ASC_KEY_ID is set but ASC_ISSUER_ID is not" >&2; exit 2; }
  ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
  [ -f "$ASC_KEY_PATH" ] || { echo "App Store Connect key not found: $ASC_KEY_PATH" >&2; exit 2; }
  AUTH_ARGS=(
    -authenticationKeyPath "$ASC_KEY_PATH"
    -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER_ID"
  )
  echo "Signing and uploading with App Store Connect API key $ASC_KEY_ID"
fi

# Baked into the JS bundle by Metro during the Xcode build phase; without them the app would
# fall back to mock mode (src/services/api/index.ts).
export EXPO_PUBLIC_API_MODE=http
export EXPO_PUBLIC_TERMHUB_URL=https://termhub.dev

BUILD_DIR="$PWD/build"
ARCHIVE="$BUILD_DIR/termhub.xcarchive"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

npm run build:contract
npx expo prebuild --platform ios --clean

if [ -n "${BUILD_NUMBER:-}" ]; then
  case "$BUILD_NUMBER" in
    *[!0-9]*) echo "BUILD_NUMBER must be a plain integer: $BUILD_NUMBER" >&2; exit 2 ;;
  esac
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" ios/termhub/Info.plist
  echo "Build number $BUILD_NUMBER"
fi

xcodebuild archive \
  -workspace ios/termhub.xcworkspace \
  -scheme termhub \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic

export_with() {
  local destination="$1" out="$2"
  cat > "$BUILD_DIR/ExportOptions-$destination.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportOptionsPlist "$BUILD_DIR/ExportOptions-$destination.plist" \
    -exportPath "$out" \
    -allowProvisioningUpdates \
    ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}
}

export_with export "$BUILD_DIR/export"

if [ "$UPLOAD" = 1 ]; then
  export_with upload "$BUILD_DIR/upload"
fi
