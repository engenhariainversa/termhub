// Older store builds that take the same OTA bundle as the current version.
//
// An update goes to runtime `expo.version` (app.config.js). When a version bump only changed
// native metadata (a privacy manifest, a permission string) and no native module, binaries of the
// previous version run the new JS just as well; listing them here makes every publish also go out
// under their runtime, so a phone that has not installed the newer build still gets the update.
//
// `for` pins the list to the version it was checked against: once `expo.version` moves, the list
// stops applying until someone checks the new native diff and updates `for`. Never list a version
// whose binary lacks a native module the current JS imports. The version bump itself ships to
// TestFlight on its own after the merge ("Mobile TestFlight (hulk)" workflow); review this list in the
// same PR as the bump, not after the build.
module.exports = {
  for: '0.6.0',
  // 0.5.0 → 0.6.0 (ec517b7c) only added the iOS privacy manifest and Android's AD_ID permission.
  runtimes: ['0.5.0'],
};

/** The extra runtimes to publish to when the app is at `version`. */
module.exports.compatibleRuntimes = function compatibleRuntimes(version, list = module.exports) {
  if (list.for !== version) return [];
  return list.runtimes.filter((runtime) => runtime !== version);
};

if (require.main === module) {
  const { version } = require('./app.json').expo;
  process.stdout.write(module.exports.compatibleRuntimes(version).join('\n'));
}
