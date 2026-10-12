// Over-the-air updates, served by the self-hosted xprem server (see README, "OTA updates").
//
// app.json stays the source of truth for everything else; this file only adds `updates` and
// `runtimeVersion` on top of it, because the code-signing fields must be switchable by an env var.
//
// runtimeVersion follows `expo.version`: a 0.3.2 binary only ever takes updates published from a
// 0.3.2 checkout, so a JS bundle can never land on a binary with different native code. Bumping
// `expo.version` for a new store build starts a fresh line of updates for that version.
// OTA_RUNTIME_VERSION overrides it only while scripts/ota-publish.sh publishes the same bundle to an
// older, compatible build (ota-runtimes.js); store builds never set it.
const OTA_URL = 'https://ota.engenhariainversa.com.br';
const OTA_APP_ID = 'ed0e9dc1-67db-40c2-8bf4-685e6b0cc2d2';
const OTA_CHANNEL = 'production';

module.exports = ({ config }) => ({
  ...config,
  // No web build: without this, `expo export` (which `eoas publish` runs) also bundles for web.
  platforms: ['ios', 'android'],
  runtimeVersion: process.env.OTA_RUNTIME_VERSION || { policy: 'appVersion' },
  updates: {
    enabled: true,
    url: `${OTA_URL}/manifest`,
    // Check on every cold start without blocking it: a new update is downloaded in the
    // background and runs from the next launch.
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
    requestHeaders: {
      'expo-channel-name': OTA_CHANNEL,
      'expo-app-id': OTA_APP_ID,
    },
    // The server signs every manifest with the app's private key; the build only carries the
    // public certificate. `expo start` would need the private key to sign development manifests,
    // so `npm start` sets DISABLE_CODE_SIGNING.
    ...(process.env.DISABLE_CODE_SIGNING
      ? {}
      : {
          codeSigningCertificate: './certs/certificate.pem',
          codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
        }),
  },
});
