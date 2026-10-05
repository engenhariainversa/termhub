# Integrator playbook

What the integrator agent does for an epic branch, in order. The integrator prompt points here.

1. **Update the branch.** `git fetch origin && git merge origin/<base>`. Resolve conflicts preserving the intent of both sides.
2. **Prisma migrations.** When both the base and the epic added migrations, the epic's folders must sort after the newest one on the base. Run `node scripts/automation/rename-migrations.mjs <base>` from the repository root: it renames only the folders that are not on `origin/<base>` to `YYYYMMDDHHMMSS_name` timestamps right after the newest base migration, keeping their relative order, and commit the result. Never rename or edit a migration that exists on the base: it is applied in production, and the script refuses (`rename-migrations.mjs <base> <folder>` exits 1 for such a folder).
3. **Generated Prisma client.** Never edit it by hand; run `npx prisma generate`.
4. **Lockfiles.** Take the base's version of `package-lock.json` (`git checkout origin/<base> -- package-lock.json`) and run `npm install` to regenerate it with the epic's dependencies.
5. **Checks.** Run the project's typecheck, build and tests until they pass.
6. **Push** the epic branch.
7. **Report.** Call `report_card` with status `done` and the PR URL; if blocked, with status `blocked` and the reason.
