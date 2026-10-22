---
symptom: "error: exportArchive No Accounts / error: exportArchive No signing certificate \"iOS Distribution\" found"
tags: [ios, testflight, xcode, signing, mobile]
evidence: observed
agent: claude
date: 2026-10-01
---
## Cause

`npm run release:ios` archives fine, then `xcodebuild -exportArchive` fails: the script signs through
the Apple ID signed in to Xcode (the distribution certificate is cloud-managed), and Xcode had no
account any more. On the release Mac the account vanished from Xcode → Settings → Accounts when Xcode
was quit, so the next release found an empty list. `defaults read com.apple.dt.Xcode
DVTDeveloperAccountManagerAppleIDLists` shows it: an empty `IDE.Identifiers.Prod` list means no
account.

A different App Store Connect API key on the same Mac failed the same step with "No App Store Connect
access for the team" (in the `IDEDistribution` log): the key must belong to team `S873WHF2TZ`.

## Fix

Either sign in to Xcode again (Settings → Accounts) and keep Xcode open until the upload finishes, or
run the script with an App Store Connect API key of the team, which does not depend on the Xcode
account:

```bash
ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer uuid> npm run release:ios -w @termhub/mobile -- --upload
```

Also close the termhub workspace in Xcode before a release: an open `ios/termhub.xcworkspace` makes
`expo prebuild --clean` fail with `ENOTEMPTY: directory not empty, rmdir '.../apps/mobile/ios'`.

## Seen again (2026-10-22, app 0.8.0, TER-1109)

Same failure on another Mac: Xcode still listed the account, but `xcodebuild` logged
`DVTDeveloperAccountManager: Failed to load credentials … missing Xcode-Username` at the start of the
archive, and the export failed with `No Accounts`. The archive itself succeeds (it signs with the
development identity), so after the person signs in again there is no need to rebuild: rerun only
`xcodebuild -exportArchive` with the script's `ExportOptions` plist (`destination` `export`, then
`upload`) against `apps/mobile/build/termhub.xcarchive`. Check the account before a release:
`defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists` lists an identifier, and the
archive log has no `Failed to load credentials` line.

## How to check

The script prints `Signing and uploading with App Store Connect API key <id>` and ends with
`Upload succeeded`; the build shows up in App Store Connect → TestFlight.
