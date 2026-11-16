# Multi-repo: workspace runs for a card with several repositories (TER-1065)

Epic TER-1060, card 12 of 16. Spec: `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md`
(R11, R13, §7). Outline: `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 12. Builds on
TER-1066 (`docs/superpowers/plans/2026-11-16-multi-repo-run-repo.md`).

## Goal

A card whose `repo_keys` name two or more repositories runs in a **workspace**: one folder
`<root>/<pid>/<ref>/` (the tab's cwd, and the guard's `WORKTREE`), with one worktree per repository at
`<ref>/<key>`, all on the same branch name. A card with one repository, and every single-repo project, keep
today's layout, prompt, allow list and guard byte for byte.

## Steps

1. **Which repositories** (`run-repo.ts`): `pickRunRepo` no longer refuses several keys. It returns the
   first key's `RunRepo` (its entry gives the branch pattern, so the one branch name is the same everywhere)
   with `members`: one `RunRepo` per key, in the card's order, each enabled and readable (else
   `REPO_UNAVAILABLE`). `checkoutDirOn` of a workspace run is null unless every member has a present
   checkout on the machine; `memberDirsOn` gives each member's dir. `runKeysOf(rows, worktree)` reads a
   run's keys back from its `automation_run_repos` rows (each row's path is `<worktree>/<key>`).
2. **Queue** (`repo-readiness.ts`, `eligibility.ts`): `repo_multi_soon` is gone. `cardRepoBlock` checks each
   key in turn (`repo_disabled`, `repo_no_access`, `repo_missing`, `agent_no_repo_scan`) and, for
   `repo_not_on_machine`, wants one linked machine holding every repository. The reason is removed from the
   type, the texts, the MCP description and `STRUCTURAL_REASONS`.
3. **Placement** (`placement.ts`): a workspace run leaves out a machine whose guard is older than
   `MULTI_REPO_GUARD_MIN_AGENT_VERSION` (`no_guard`) and returns `repoDirs` (key → checkout) next to
   `repoDir`. The room check gets the repository count.
4. **Disk room** (`machine-room.ts`): `MIN_FREE_DISK_KB` times the repository count (`check(…, repos)`).
5. **Launch** (`dispatcher.ts`), workspace run:
   - the epic branch (an automatic epic) is ensured in each member's repository, from its base, with its own
     integration (spec R16 creation; the integrator stays single-repo until Task 15);
   - `ensureWorkspace({ …, key })` per member at `<root>/<pid>/<ref>/<key>`, from that member's base;
   - the run's `worktree_path` is the workspace root (the parent of the first worktree, as the agent
     resolved it), one `automation_run_repos` row per member;
   - the tab's cwd is the root; the permission carries `repoKeys`, so the allow list gets the `-C <key>` forms
     (`automationAllowList`), the push rules for each `<root>/<key>` (`runBranchRules`), and the guard gets
     the root (its v2+ push rule already takes `git -C <root>/<key> push`);
   - `existingWork` asks GitHub about each repository.
6. **Permission on restarts** (`permission.ts`): `runPermission` reads `repoKeys` from the run's rows, so a
   restart, a resume, an account swap and the answers' allow-list check keep the same rules.
7. **Prompts** (`prompts.ts`): `implementerPrompt`, `fixerPrompt` and `integratorPrompt` take `repos`
   (key, `owner/repo`, base). With two or more:
   - one line per repository (`- api: owner/api (base main)`), a required part, so it takes the room of the
     description excerpt first; the block is clipped at `REPOS_MAX`;
   - `SHELL_LINE_MULTI`: each repository is in `<key>/`, git through `git -C <key> …`, other commands after
     a `cd <key>` sent alone in its own call; push with `git -C <root>/<key> push -u origin <branch>` (the
     exact form the guard and the allow list take);
   - "um PR por repositório com mudança";
   - everything under `PROMPT_MAX_CHARS`, with a length test at the longest inputs.
   The fixer is told which repository's PR failed (`merge.ts` passes the card's repositories when it has
   more than one). The integrator gets the parameter but `integrator.ts` keeps passing none (Task 15).
8. **Cleanup** (`cleanup.ts`): a workspace run (rows under its `worktree_path`) removes each worktree from
   its own checkout with `remove_empty_parent`: the agent (0.39.0, `git.worktree.remove`) then removes the
   `<ref>/` folder once it is empty and strictly under `root` (`rmdir`, never recursive). An older agent drops
   the field and leaves the empty folder. A dirty worktree keeps the run `kept`, as today. `runOnMachine`
   cannot do it: it refuses agent machines, the only ones automatic work runs on.
9. **Fixer takeover** (`takeOverTab`, TER-1051): unchanged copy of the rows; when the card names a
   repository the old run did not have, the fixer does not take the tab and starts a new run (new tab, fresh
   guard, the missing worktree added to the same workspace).
10. **Guard check**: the agent's guard tests gain the relative forms the prompt mentions (`cd <key>` alone
    passes; `cd <key> && git push …` is denied, `git -C <root>/<key> push -u origin <branch>` passes).

## Tests

- `run-repo.test.ts`: two keys give members in order; a disabled member refuses; `checkoutDirOn` needs every
  member; `runKeysOf`.
- `repo-readiness.test.ts`: two ready keys pass; the first missing thing of either key; a machine holding
  only one of them is `repo_not_on_machine`.
- `machine-room.test.ts`: two repositories need twice the disk.
- `placement.test.ts`: a workspace run returns `repoDirs`; a machine missing one member is left out.
- `prompts.test.ts`: repo lines and the multi shell line only with two or more repositories; single-repo
  snapshot unchanged; longest inputs stay within `PROMPT_MAX_CHARS`; the repo lines eat the description first.
- `dispatcher.db.test.ts`: a two-repo card gets two `ensureWorkspace` calls at `<ref>/<key>`, a run whose
  worktree is the root, two rows, cwd at the root and a permission with both keys; a single-repo card is
  unchanged.
- `cleanup.test.ts`: a workspace run removes both worktrees, asking for the empty folder; a dirty one keeps it.
- agent `worktree.test.ts`: two worktrees at `<ref>/<key>` from two clones; the folder goes with the last
  clean one, never the project's folder nor `root`.
- `guard-script.test.ts`: `cd <key>` alone and the absolute `git -C` push pass; a relative `cd` or `-C` with
  the push is denied.
- `permission` / `answers`: `runPermission` returns the keys of a workspace run.

## Impact on other users

Only projects with several repositories, and only cards naming two or more of them: they now run instead of
waiting with "Vários repositórios: em breve". Those runs need an agent with guard v2 (0.29.0; automatic work
already requires 0.36.0). Single-repo projects and one-repo cards: nothing changes.

## CLIs covered

Claude Code ✅ (automatic runs start Claude Code only) · Codex, Cursor, Gemini: not account providers of
automatic runs (unchanged, `docs/agent-cli-parity.md`).
