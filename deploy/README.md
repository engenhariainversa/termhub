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

## Database backups

`deploy/db-backup.sh`, run every day by the **Backup do banco** workflow
(`.github/workflows/db-backup.yml`, self-hosted runner on jarvis), takes an encrypted `pg_dump` of
the production database and deletes the backups past their retention. On Sundays the same workflow
restores the newest backup into a throwaway container (`deploy/db-restore-test.sh`) and checks what
came back. Before this (TER-745) the only backup was a manual `pg_dump` before risky migrations.

### Decisions (TER-745, items P-7 and D-7 of `docs/legal/duvidas-advogado.md`)

| Question | Decided | Why |
| --- | --- | --- |
| Frequency | daily, 06:30 UTC (03:30 in Brasília) | at most one day of data lost; outside the hours when merges deploy |
| Where | on jarvis, `/mnt/hd2tb/projetos/termhub/backups/db` (`BACKUP_DIR`) | no new provider and no data leaving Brazil, so the Privacy Policy's international transfer section does not change. The run summary says when the folder shares a disk with the Docker volumes: then a backup protects against mistakes and a corrupted database, not against losing that disk. A copy outside the house is a later step and, if it leaves Brazil, goes into the Policy first |
| Encryption | `gpg --symmetric`, AES256, passphrase in `/mnt/hd2tb/projetos/termhub/backup-passphrase` (chmod 600) | nothing unencrypted reaches the disk (the dump is piped into gpg), and a copied file is useless without the passphrase |
| Retention | 30 days (`BACKUP_RETENTION_DAYS`) | the Privacy Policy's "até N dias dos backups": a deleted account leaves the backups at most 30 days after it leaves the database (30 days of deletion window + 30 days of backups) |
| Restore test | weekly, automatic, into `th-restore-test` (no network) | a backup that was never restored is a hope, not a backup |

### Setting it up on jarvis (once)

1. `gpg` must be installed (`gpg --version`; else `sudo apt install gnupg`).
2. Add `BACKUP_RETENTION_DAYS=30` to the server's `.env` (`/mnt/hd2tb/projetos/termhub/.env`). The
   backup script reads that line, and the app uses it in the "account deleted" e-mail, which then
   says when the copies in backups go. Without the line the script keeps 30 days and the e-mail says
   nothing about backups.
3. Run the workflow once by hand (`gh workflow run "Backup do banco" --ref main -f restore_test=true`).
   The first run creates the passphrase file and says so in the run summary: **copy the passphrase to
   a password manager**, outside jarvis. Without it no backup can be restored. Never paste it in a
   card, a lesson or a log.
4. Check the space: `df -h /mnt/hd2tb` and the size of the first backup (`ls -lh
   /mnt/hd2tb/projetos/termhub/backups/db`). 30 backups take about 30 times that. The script refuses to
   start with less than `BACKUP_MIN_FREE_MB` (2 GB) free or less than twice the latest backup, so a
   full disk (it happened before, with build cache) fails the run instead of the database.

### Restoring

**Check a backup** (safe, never touches production):

```bash
bash deploy/db-restore-test.sh                                        # the newest
bash deploy/db-restore-test.sh /mnt/hd2tb/projetos/termhub/backups/db/termhub-db-<UTC>.dump.gpg
```

**Restore production** (a person does this, never an automatic run: it replaces the live database):

1. Take a backup of the current state first, even a broken one: `ENV_FILE=/mnt/hd2tb/projetos/termhub/.env bash deploy/db-backup.sh`.
2. Check the backup you will restore with `deploy/db-restore-test.sh <file>`.
3. Note which accounts exist now, when the database still answers:
   `docker exec termhub-db-1 psql -U termhub -d termhub -tAc 'SELECT id FROM users' > /tmp/users-now.txt`.
4. Stop the active colour, then recreate the database and restore into it:
   ```bash
   docker exec termhub-db-1 dropdb -U termhub --force termhub
   docker exec termhub-db-1 createdb -U termhub termhub
   gpg --batch --pinentry-mode loopback --passphrase-file /mnt/hd2tb/projetos/termhub/backup-passphrase \
     --decrypt <file> | docker exec -i termhub-db-1 pg_restore -U termhub -d termhub --no-owner --exit-on-error
   ```
5. Start the colour again; on boot it applies the migrations newer than the backup.
6. **Deletions done after the backup must not come back.** Accounts whose 30-day window is over are
   deleted again by the app's job by itself. Accounts deleted after the backup was taken are back,
   though: compare `SELECT id FROM users` with `/tmp/users-now.txt` (or, when step 3 was not possible,
   with the `account deletion: account deleted` log lines and the "Sua conta do termhub foi excluída"
   e-mails sent since the backup) and delete each one again in Configurações → Usuários. Then delete
   `/tmp/users-now.txt`.

### Tests

`bash deploy/db-backup.test.sh` runs both scripts with fake `docker` and `gpg` (no Docker, no
database). `bash deploy/db-backup.e2e.sh` runs them for real against throwaway `th-*` containers with
the real migrations; the CI `check` job runs both.
