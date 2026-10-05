---
symptom: "npm error 409 Conflict - PUT https://registry.npmjs.org/@termhub%2fagent - Cannot publish over previously staged version \"0.17.1\""
tags: [ci, npm, agent, publish]
evidence: fixed
card: TER-938
agent: claude
date: 2026-10-05
---
## Cause

npm holds a freshly published version as "staged" while it processes it ("Your package is being
processed and may take a few minutes to become available"). Until then `npm view
@termhub/agent@<v>` answers nothing, so the `decide` job of a later push to `main` (any push, not
only a version bump) concludes the version is not on npm and publishes again. npm refuses with
`E409 Cannot publish over previously staged version`, a wording the workflow's "already published"
check did not match, so the run failed. Seen for 0.17.0 (staged about 3 minutes) and 0.17.1 (staged
much longer).

## Fix

`.github/workflows/publish-agent.yml` treats `cannot publish over previously staged` like
`EPUBLISHCONFLICT`: the version is already on its way, nothing to publish. Do not run `npm publish`
by hand while a version is staged; wait for it to show up.

## How to check

`curl -s https://registry.npmjs.org/@termhub%2fagent | python3 -c "import json,sys;print(json.load(sys.stdin)['dist-tags'])"`
shows the new version once npm finishes processing; a "Publish @termhub/agent" run started in the
staged window ends green with "já estava no npm; nada a publicar".
