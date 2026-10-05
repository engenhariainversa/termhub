---
symptom: "npm error 409 Conflict - PUT https://registry.npmjs.org/@termhub%2fagent - Cannot publish over previously staged version \"0.17.1\""
tags: [ci, npm, agent, publish]
evidence: fixed
card: TER-938
agent: claude
date: 2026-10-05
---
## Cause

npm holds every new version as "staged" while it processes it: the publish log says "Your package is
being processed and may take a few minutes to become available". No approval is involved: the
versions are published by GitHub Actions through trusted publishing (OIDC), and they go live on
their own. The wait is usually 1 to 3 minutes (0.16.0: 1 min, 0.17.0: 3 min, 0.18.0: 3 min), but
0.17.1 stayed staged for about 55 minutes. While staged, `npm view @termhub/agent@<v>` answers
nothing, so the `decide` job of any later push to `main` (not only a version bump) concludes the
version is not on npm and publishes again. npm refuses with `E409 Cannot publish over previously
staged version`, a wording the workflow's "already published" check did not match, so those runs
failed.

## Fix

`.github/workflows/publish-agent.yml` treats `cannot publish over previously staged` like
`EPUBLISHCONFLICT`: the version is already on its way, nothing to publish. Then wait for npm to
finish processing. Never `npm publish` by hand, and do not read a long wait as a missing approval.

## How to check

`curl -s https://registry.npmjs.org/@termhub%2fagent | python3 -c "import json,sys;print(json.load(sys.stdin)['dist-tags'])"`
shows the new version once npm is done; a "Publish @termhub/agent" run started in the staged window
ends green with "já estava no npm; nada a publicar".
