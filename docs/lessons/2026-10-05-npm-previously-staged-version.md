---
symptom: "npm error 409 Conflict - PUT https://registry.npmjs.org/@termhub%2fagent - Cannot publish over previously staged version \"0.17.1\""
tags: [ci, npm, agent, publish]
evidence: fixed
card: TER-938
agent: claude
date: 2026-10-05
---
## Cause

npm stages a version published from CI (trusted publishing) until a maintainer approves it with 2FA
(`npm stage list @termhub/agent`, `npm stage approve <stage-id>`, or on npmjs.com). While staged,
`npm view @termhub/agent@<v>` answers nothing, so the `decide` job of any later push to `main` (not
only a version bump) concludes the version is not on npm and publishes again. npm refuses with
`E409 Cannot publish over previously staged version`, a wording the workflow's "already published"
check did not match, so the run failed. Seen for 0.17.0 (live about 3 minutes later, once approved)
and 0.17.1 (still staged 30+ minutes later, waiting for approval).

## Fix

`.github/workflows/publish-agent.yml` treats `cannot publish over previously staged` like
`EPUBLISHCONFLICT`: the version is already waiting, nothing to publish. The release itself still
needs the maintainer's approval: an agent cannot give it (2FA), so it reports the staged version and
asks for `npm stage approve`. Never `npm publish` by hand.

## How to check

`curl -s https://registry.npmjs.org/@termhub%2fagent | python3 -c "import json,sys;print(json.load(sys.stdin)['dist-tags'])"`
shows the new version once approved; a "Publish @termhub/agent" run started in the staged window
ends green with "já estava no npm; nada a publicar".
