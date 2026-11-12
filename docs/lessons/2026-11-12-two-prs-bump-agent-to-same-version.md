---
symptom: "An agent feature merged to main never reaches machines: the published @termhub/agent of that version lacks it (the server's call answers \"unknown method\")"
tags: [agent, release, npm, ci]
evidence: fixed
card: TER-1148
agent: claude
date: 2026-11-12
---
## Cause

Two open PRs bumped `apps/agent/package.json` to the same version (0.37.0: TER-1148 and TER-1178). The first
to merge published 0.37.0 with only its own change. When the second merged, main's merge kept the version
equal to the registry, so `publish-agent.yml` saw nothing new and published nothing. Its server code still
gated the feature on `>= 0.37.0`, so it called `claude.trustFolder` on agents that never had it. Nothing
conflicts in git: both sides wrote the same line, so the merge of main into the branch is clean.

## Fix

Bump the agent again to the next free version (0.38.0) in a new PR: `apps/agent/package.json`,
`apps/agent/src/version.ts`, the `apps/agent` entry of `package-lock.json`, and the server's minimum version
for the feature (`TRUST_FOLDER_MIN_AGENT_VERSION`) with its mentions. Before merging any PR that bumps the
agent, compare its version with main's and with `npm view @termhub/agent version`; if main or npm already
has it, bump again.

## How to check

After the merge, the "Publish @termhub/agent" run publishes the new version, and
`npm pack @termhub/agent@<version>` holds the feature in `package/dist/cli.js`
(`grep -c 'claude.trustFolder'` is not 0).
