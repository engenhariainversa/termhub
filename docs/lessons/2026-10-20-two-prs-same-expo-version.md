---
symptom: "Version 0.7.0 is already on TestFlight (…); nothing to do. Bump expo.version for a native change, or pass --force."
tags: [mobile, testflight, ota, release, merge]
evidence: fixed
card: TER-994
pr: https://github.com/engenhariainversa/termhub/pull/405
agent: claude
date: 2026-10-20
---
## Cause

Two open PRs (#485, TER-368, and #405, TER-994) each added a native module and each bumped
`expo.version` to the same 0.7.0. `apps/mobile/scripts/testflight.sh` ships a version once (marker
`ios-<version>` on hulk) and skips any later merge with the same `expo.version`, so the PR merged
second would never reach a binary while its OTA bundle, published on the 0.7.0 runtime, imports a
native module the 0.7.0 build does not have. The same race happens with `@termhub/agent`: PRs opened
in parallel bump to the same version, and the second one must move above the one that merged, together
with every `*_MIN_AGENT_VERSION` gate it introduced (agents published in between lack its RPCs).

## Fix

When two pending PRs bump the same version, the one that merges second takes the next version: here
#405 went to app 0.7.1 (Android `versionCode` 9, `ota-runtimes.js` `for: '0.7.1'`, `runtimes: []`),
and the agent PRs went 0.31.0 → 0.32.0 → 0.34.0 as others landed first, gates and docs included.
Migrations of parallel PRs are renamed the same way so they sort after main's latest one.

## How to check

`git show origin/main:apps/mobile/app.json | grep '"version"'` before merging a PR that bumps it; after
the merge, the "Mobile TestFlight (hulk)" run summary names the version it shipped. For the agent,
`npm view @termhub/agent time` and `npm pack @termhub/agent@<v>` to look for the new RPC in `dist`.
