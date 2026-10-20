---
symptom: "Failed to load app from http://<host>:8081 with error: Code signature validation failed: No expo-signature header specified"
tags: [mobile, ios, expo, prebuild, simulator, ota]
evidence: fixed
card: TER-368
agent: claude
date: 2026-10-11
---
## Cause

`app.config.js` puts the OTA code-signing certificate (`codeSigningCertificate`,
`codeSigningMetadata`) into the build unless `DISABLE_CODE_SIGNING` is set, and `expo prebuild`
writes it into `ios/termhub/Supporting/Expo.plist` (`EXUpdatesCodeSigningCertificate`). A bare
`npx expo prebuild --platform ios --clean` (the command the TER-368 spike notes use) does not set the
variable, so the development build then refuses Metro's unsigned manifest. `npm run ios` sets it for
`expo run:ios`, but `run:ios` does not prebuild again when `ios/` already exists, so the certificate
from the earlier prebuild stays.

## Fix

Prebuild with the variable, like the npm scripts do:

```bash
DISABLE_CODE_SIGNING=1 npx expo prebuild --platform ios --clean   # from apps/mobile
```

For an `ios/` that is already generated, deleting the two keys and building again is enough:

```bash
/usr/libexec/PlistBuddy -c "Delete :EXUpdatesCodeSigningCertificate" \
  -c "Delete :EXUpdatesCodeSigningMetadata" apps/mobile/ios/termhub/Supporting/Expo.plist
```

Never do this to a release build: `scripts/ios-release.sh` prebuilds without the variable on purpose.

## How to check

`grep -c EXUpdatesCodeSigningCertificate apps/mobile/ios/termhub/Supporting/Expo.plist` prints `0`,
and the development build loads the bundle from Metro (`iOS Bundled … apps/mobile/index.ts`).
