# Multi-repo: agent RPC `git.repos.scan` (TER-1075) — implementation plan

Task 2 of `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`. Spec:
`docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` (R2, R4, R10, R18, §5 step 2, §10).

**Goal:** the machine agent lists the git checkouts of a project folder, so the server's discovery (Task 6)
has something to call. Nothing calls the RPC in this PR.

**Depends on:** nothing.

## Contract

`git.repos.scan` in `packages/agent-protocol/src/rpc.ts`:

- params `{ dir: machinePath, depth: 1..3 }`;
- result `{ repos: [{ dir, origin, default_branch, has_commits, description }], truncated }`:
  - `dir`: relative to the scanned folder, `/`-separated, `.` for the folder itself (spec §4);
  - `origin`: `git remote get-url origin` without a secret, or null. An http(s) URL loses its whole
    `user:pass@` (a token lives in either half); another scheme loses only the password, since the user of
    `ssh://git@host/…` is part of the address;
  - `default_branch`: `origin/HEAD` without the `origin/` prefix, or null;
  - `has_commits`: `git rev-list -n1 --all` printed a commit;
  - `description`: at most `REPO_DESCRIPTION_MAX_CHARS` (200) characters, or null;
  - `truncated`: the walk stopped at `REPO_SCAN_MAX_REPOS` (200) checkouts or at its folder cap;
- timeout 60 s. The agent keeps one deadline 10 s under it.

Constants in `messages.ts`: `CAPABILITY_REPO_SCAN = 'repo_scan'`, `REPO_SCAN_MIN_AGENT_VERSION = '0.29.0'`.

## Rules of the walk (`apps/agent/src/rpc/repos.ts`)

1. `dir` is expanded (`~`), must exist and be a folder (`notfound` otherwise), and is resolved with
   `realpath`. `/` and the home folder are refused (`invalid`), before and after the links are resolved, the
   same rule `worktrees_dir` has in `worktree.ts`.
2. A folder is a checkout when its `.git` is a **directory**. A `.git` **file** is a worktree or a
   submodule: it is not listed and not walked.
3. The scanned folder itself is listed (`.`) when it is a checkout, and its subfolders are still walked
   (spec §10, "the project folder is itself a repo and also holds repos"). A subfolder that is a checkout is
   listed and never walked.
4. Subfolders come from `readdir({ withFileTypes: true })`. Skipped: names starting with `.`,
   `node_modules`, anything that is not a real directory (a symbolic link is never followed, so the walk
   cannot leave the folder or loop). A folder that cannot be read is skipped.
5. `depth` 1 looks at the folder and its direct subfolders, 2 one level below, 3 one more.
6. Each checkout runs four git calls with an argv array (`run` → `execFile`), `GIT_TERMINAL_PROMPT=0` and
   the quick step timeout (15 s) under the call's deadline: `rev-parse --git-dir` (a folder git refuses, for
   example one owned by another user, is left out), `remote get-url origin`, `symbolic-ref --short
   refs/remotes/origin/HEAD`, `rev-list -n1 --all`. A timeout fails the call with `timeout`. A machine
   without git fails with `failed`.
7. Description: the top-level `description` of `package.json`, else the first ATX heading of `README.md`
   (any letter case of the file name, fenced code skipped). At most 4 KiB of each file is read, only from a
   regular file (a link is not followed). A `package.json` cut at 4 KiB is not valid JSON, so the field is
   then taken with a regular expression. Control characters and runs of white space become one space, and
   the text is cut at 200 characters.
8. The answer is sorted by `dir`.

## Steps

1. **Protocol.** Add the constants, the `git.repos.scan` definition and its tests (`rpc.test.ts`: the method
   list, depth 0 and 4 refused, a relative `dir` refused, the result shape; `messages.test.ts`: the two
   constants).
2. **Tests first** (`apps/agent/src/rpc/repos.test.ts`, real git on temporary folders, a fake `home`):
   - a repo at the root, alone, and with repos in subfolders;
   - repos in subfolders at depth 1, 2 and 3, and one below the depth left out;
   - no descent into a checkout;
   - hidden folders, `node_modules`, a worktree, a submodule and a linked folder skipped;
   - no `origin`; ssh and https `origin`; credentials in the URL removed;
   - `default_branch` from `origin/HEAD`, null without it; `has_commits` false on a fresh `git init`;
   - description from `package.json`, from `README.md`, from a `package.json` longer than 4 KiB, capped at
     200 characters, null when there is none, and a linked `README.md` not read;
   - `/`, the home folder (also through a link and as `~`) refused; a missing folder is `notfound`.
3. **Handler.** Write `repos.ts` until the tests pass. `git`, `gitFailure`, `Deadline` and `QUICK_STEP_MS`
   are reused from `worktree.ts` (exported there). `scrubCredentials` is not: it would turn
   `ssh://git@github.com/…` into `ssh://github.com/…`.
4. **Wiring.** `rpc/index.ts` (`'git.repos.scan': repos.scan`), `CAPABILITIES` in `run.ts` and its test.
5. **Release.** `apps/agent/package.json`, `src/version.ts` and the workspace entry in `package-lock.json`
   go from 0.28.1 to 0.29.0. CI publishes; never `npm publish`.
6. **Verify.** `npm test -w @termhub/agent-protocol`, `npm test -w @termhub/agent`, typecheck of the agent,
   the protocol and the server, and the agent build.

## Impact on other users

A new agent release reaches machines through the existing auto-update. No behaviour changes: the server
does not call the RPC yet, and `MIN_AGENT_VERSION` is not raised (spec R18).
