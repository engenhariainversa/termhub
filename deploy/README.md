# Deploy: smoke test and automatic rollback

The deploy job in `.github/workflows/deploy.yml` runs, on jarvis:

1. `deploy/blue-green.sh`: builds and healthchecks the inactive colour, switches the proxy nginx
   vhost to it, stops the old colour (kept for rollback).
2. "Conferir migrations aplicadas": `prisma migrate status` in the new colour.
3. `deploy/post-deploy.sh`: runs `deploy/smoke.sh` and, when the app does not answer, rolls back one
   step if that is safe. It runs only when step 1 succeeded (the switch happened).

Background and reasoning: `docs/superpowers/specs/2026-10-04-automation-safety-spike.md` §4.3–4.5 (R4).

## The smoke test (`deploy/smoke.sh`)

Through the local proxy nginx (`http://127.0.0.1` with a `Host:` header, so Cloudflare Access is not
in the way), up to 3 attempts 10 s apart:

| Step | Request | Expected | On failure |
| --- | --- | --- | --- |
| 1 | `GET /api/ready`, Host `app.termhub.dev` | 200 | rollback trigger |
| 2 | `GET /`, Host `app.termhub.dev` | 200 | rollback trigger |
| 3 | `POST /mcp` `tools/list` with `SMOKE_API_TOKEN` | 200 with a tool list | job fails, **no** rollback |
| 4 | `GET /`, Host `termhub.dev` (landing) | 200 | reported only |

Step 3 runs only when `SMOKE_API_TOKEN` is set; otherwise the log says it was skipped. Nothing in the
smoke test writes data.

Run it by hand on jarvis (read-only): `ENV_FILE=/mnt/hd2tb/projetos/termhub/.env bash deploy/smoke.sh`.

### Turning on the authenticated step (`SMOKE_API_TOKEN`)

1. In the app, create a personal API token with **only the `read` scope** (a dedicated token, named
   e.g. "smoke test do deploy", so it can be revoked without touching anything else).
2. On jarvis, add it to the server env file, which only lives there (chmod 600):
   `SMOKE_API_TOKEN=thb_pat_...` in `/mnt/hd2tb/projetos/termhub/.env`.
3. The next deploy uses it. The token is read from that single line (the file is not sourced),
   passed to curl through stdin and never printed.

If the token is revoked or expires, step 3 fails and the deploy job fails without rolling back:
replace the token, or remove the line to skip the step.

## Automatic rollback (`deploy/post-deploy.sh`)

When step 1 or 2 still fails after the retries, the script runs `bash deploy/blue-green.sh --rollback`
— once, one step back — only if all of these hold:

- the active colour (state file) is blue or green, and the other colour's container exists and is
  stopped (right after the very first blue/green deploy there is none: use the manual procedure in
  CLAUDE.md);
- no migration added by this release (present in the checkout, absent from the stopped colour's
  image, read with `docker cp`) contains `DROP`, `RENAME`, `ALTER … TYPE` or `SET NOT NULL`;
- `DEPLOY_AUTO_ROLLBACK` is not `0`.

`--rollback` itself refuses to switch to a colour that does not become healthy, so the site is never
left with nothing behind the proxy. There is never a revert commit, and releases (`@termhub/agent` on
npm, the mobile OTA) are never rolled back.

**Whatever happens after a failed smoke test, the job fails**, so it shows up as a failed deploy. The
run summary says either `revertido para <cor> (<sha>)` or `sem rollback automático: <motivo>`.

After a rollback, `main` still holds the broken commit and the next push to `main` redeploys it: fix
`main` first. The stopped colour (the broken release) is kept for inspection
(`docker logs termhub-app-<cor>`).

### Turning the automatic rollback off

Set the repository variable (the smoke test keeps running and still fails the job):

```bash
gh variable set DEPLOY_AUTO_ROLLBACK --body 0     # off
gh variable delete DEPLOY_AUTO_ROLLBACK           # back on (default)
```

### Tests

`bash deploy/post-deploy.test.sh` exercises the decision and the smoke test with fake `docker`,
`curl`, smoke and `blue-green.sh`; it touches neither Docker nor the network. The CI `check` job runs
it.
