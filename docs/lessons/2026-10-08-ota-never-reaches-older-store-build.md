---
symptom: "Publish mobile OTA runs green but the phone keeps showing old mobile JS"
tags: [mobile, ota, xprem, expo-updates, runtime-version]
evidence: fixed
agent: claude
date: 2026-10-08
---
## Cause

`runtimeVersion` follows `expo.version` (`appVersion` policy). `app.json` went to 0.6.0 on 2026-10-01
(privacy manifest only), but the iPhone kept the 0.5.0 store build (Ajustes → Versão: `0.5.0 (202609300448)`).
Every automatic OTA since then went to runtime `0.6.0`; the server's `0.5.0` line stopped at an update of
2026-10-04, so the 0.5.0 binary kept running that bundle. Nothing fails: the workflow is green and the
server answers 200 for both runtimes.

## Fix

`apps/mobile/ota-runtimes.js` lists older versions whose binaries take the current JS (pinned to the
`expo.version` it was checked against), and `scripts/ota-publish.sh` publishes the same bundle again with
`OTA_RUNTIME_VERSION=<old>` (read by `app.config.js`). The alternative is installing the newer store build.

## How to check

Read-only manifest request (one per runtime), compare `createdAt` with the last publish:

```bash
curl -s https://ota.engenhariainversa.com.br/manifest -H 'expo-platform: ios' -H 'expo-runtime-version: 0.5.0' \
  -H 'expo-channel-name: production' -H 'expo-app-id: ed0e9dc1-67db-40c2-8bf4-685e6b0cc2d2' \
  -H 'expo-protocol-version: 1' -H 'accept: multipart/mixed' | grep -o '"createdAt":"[^"]*"'
```

On the phone, Ajustes → Versão shows the binary version and the running update's id and date.
