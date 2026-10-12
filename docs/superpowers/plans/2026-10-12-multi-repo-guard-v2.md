# Multi-repo guard v2 and `-C` allow-list forms — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** the hard-lock guard and the server's allow list accept a push of the run's own branch from a repo
folder of a multi-repo workspace (`git -C <workspace>/<key> push …`), with nothing using it yet.

**Architecture:** the guard script (`@termhub/machine-ops`, shipped inside the agent) rewrites
`git -C <WORKTREE>/<key> push …` to the plain `git push …` when `<key>` is a valid repo key, then applies the
four exact forms it already has. On the server, `runBranchRules` and `gitRuleForms` take the run's repo keys
and emit the matching rules by exact path. Both are inert until a run passes keys (Task 12 of the epic).

**Tech stack:** TypeScript, POSIX sh (the guard), vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md`, R13 (guard and allow list) and
R18 (agent capabilities). Outline: `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`, Task 4.
Card: TER-1073.

## Global constraints

- A project with one repository sees no change: without keys, `runBranchRules`, `gitRuleForms` and
  `automationAllowList` return exactly what they return today, and the guard decides every command a
  single-repo run sends the same way as before (spec §3.1).
- Still one `BRANCH` and one `WORKTREE` in the guard. Only the four plain push forms, only to `BRANCH`.
- `<key>` charset: starts with a letter or digit, then letters, digits, `.`, `_` or `-`; no `/`, no `..`.
- POSIX sh only in the guard (dash on Linux, bash-as-sh on macOS).
- Agent: bump `apps/agent/package.json`, `apps/agent/src/version.ts` and the workspace entry in
  `package-lock.json` together, to `0.29.0` (main is at `0.28.1`). CI publishes; never `npm publish`.
  `MIN_AGENT_VERSION` is not raised.
- Cite the decision in code comments: `spec 2026-10-07 multi-repo R13`.
- No UI copy changes, no migration.

## Review focus

1. **A `-C` path that only looks like a repo folder** (`<WORKTREE>/a/../../x`, `<WORKTREE>/..`, `<WORKTREE>2/x`,
   a relative `frontend`): must be denied by the guard. Tests in Task 1.
2. **`-C` on the workspace root** (`git -C <WORKTREE> push …`, with or without a trailing `/`): denied, as
   today. Test in Task 1.
3. **Something after or between the allowed words** (`… push -u origin BRANCH && git push origin main`,
   `-C <ok> -C /elsewhere push`, `-C <ok> --no-pager push`, `--force`): denied. Tests in Task 1.
4. **A guard launched without a usable worktree** (empty `$2`, or `/`): the `-C` form must not open
   `git -C /etc push`. Test in Task 1.
5. **A key or workspace the rule syntax cannot hold** (`a b`, `a*`, `../x`, a relative workspace): the server
   emits no rule for it rather than a broken or broader one. Tests in Task 2.

## File structure

| File | Change |
| --- | --- |
| `packages/machine-ops/src/guard-script.ts` | push rule accepts the `-C <WORKTREE>/<key>` form; `GUARD_SCRIPT_VERSION = 2` |
| `packages/machine-ops/src/guard-script.test.ts` | new cases |
| `apps/server/src/control/automation-tools.ts` | `RunRepos`, `runRepoPaths`, keys in `runBranchRules`, `gitRuleForms`, `automationAllowList` |
| `apps/server/src/control/automation-tools.test.ts` | new cases |
| `apps/server/src/terminal/tab-mcp.ts` (+ test) | `MULTI_REPO_GUARD_MIN_AGENT_VERSION`, `multiRepoGuardSupported` |
| `apps/agent/package.json`, `apps/agent/src/version.ts`, `package-lock.json` | `0.29.0` |
| `docs/automation/runbook.md` | one sentence on guard v2 |

## Decisions taken

| Question | Options | Choice | Why |
| --- | --- | --- | --- |
| How the guard marks version 2 | a comment only; an exported constant plus the comment | `GUARD_SCRIPT_VERSION = 2` and a `# termhub-guard v2` line in the script | Same pattern as `HOOK_SCRIPT_VERSION`; a person can `head` the file on a machine and see which guard it has. |
| Does the guard accept a relative `git -C <key> push`? | yes; no | No, only `<WORKTREE>/<key>` | The spec names the absolute form, and the prompt of a multi-repo run tells the agent to push from inside the folder. A relative path depends on the cwd, which the guard cannot see. |
| Which `-C` spellings `gitRuleForms` emits per key | absolute only; absolute and relative `<key>`; those plus a trailing `/` | Absolute `<workspace>/<key>` and relative `<key>` | The relative one is the analogue of today's `-C .` and is what the multi-repo prompt will suggest (`git -C <key>`); without it every `git -C frontend log` would ask (lesson `2026-10-07-automatic-run-escalates-git-dash-c.md`). No trailing-slash form, to keep the list at six rules per repo and git rule. `runBranchRules` emits the absolute form only, the one the guard accepts. |
| Where the keys enter `automationAllowList` | a new argument; the existing `forms` object | `forms.keys` | The forms already travel only on lines that go through a launch file, which is where the extra rules fit. |
| A helper next to the constant | constant only; constant and `multiRepoGuardSupported` | Both | It mirrors `guardSupported`, and Task 12 needs exactly this check. |

---

### Task 1: Guard v2 (`@termhub/machine-ops`)

**Files:**
- Modify: `packages/machine-ops/src/guard-script.ts`
- Test: `packages/machine-ops/src/guard-script.test.ts`

**Interfaces:**
- Produces: `GUARD_SCRIPT_VERSION: number` (2). `GUARD_SCRIPT` and `buildGuardSettings(branch, worktree)` keep
  their signatures; for a multi-repo run the caller passes the workspace root as `worktree`.

- [ ] **Step 1: Write the failing tests** — add to `guard-script.test.ts`, after the `git push` block
  (and import `GUARD_SCRIPT_VERSION`):

```ts
describe('guard v2 — push from a repo folder of the workspace (spec 2026-10-07 multi-repo R13)', () => {
  it('is marked as version 2', () => {
    expect(GUARD_SCRIPT_VERSION).toBe(2);
    expect(GUARD_SCRIPT).toContain('# termhub-guard v2\n');
  });
  it('allows the run\'s own branch from <WORKTREE>/<key>, in the four plain forms', () => {
    for (const key of ['frontend', 'hub-community-frontend', 'api.v2', 'bff_1', 'main']) {
      const c = `git -C ${WORKTREE}/${key} push`;
      expect(bash(`${c} -u origin ${BRANCH}`).deny, key).toBe(false);
      expect(bash(`${c} origin ${BRANCH}`).deny, key).toBe(false);
      expect(bash(`${c} -u origin HEAD:refs/heads/${BRANCH}`).deny, key).toBe(false);
      expect(bash(`${c} origin HEAD:refs/heads/${BRANCH}`).deny, key).toBe(false);
    }
    expect(bash(`git  -C  ${WORKTREE}/frontend   push origin ${BRANCH}`).deny).toBe(false); // blanks squashed
  });
  it('denies a key with `..`, with `/`, hidden, or that starts an option', () => {
    for (const key of ['..', '../other', 'a/..', 'a..b', 'a/b', 'frontend/', '.git', '-x', 'a*', '$HOME', '']) {
      const c = `git -C ${WORKTREE}/${key} push -u origin ${BRANCH}`;
      expect(bash(c).deny, c).toBe(true);
    }
  });
  it('denies another branch or shape from a repo folder', () => {
    const c = `git -C ${WORKTREE}/frontend`;
    for (const rest of ['push origin main', 'push origin HEAD:main', `push origin ${BRANCH}:main`, `push --force origin ${BRANCH}`, `push -f origin ${BRANCH}`, 'push', `push upstream ${BRANCH}`,
      `push -u origin ${BRANCH} && git push origin main`, `--no-pager push -u origin ${BRANCH}`, `-C /home/u/other push -u origin ${BRANCH}`, `-c core.sshCommand=x push -u origin ${BRANCH}`]) {
      expect(bash(`${c} ${rest}`).deny, rest).toBe(true);
    }
  });
  it('denies -C outside the workspace, on a sibling of it, relative, and on the workspace root itself', () => {
    for (const p of ['/home/u/other/frontend', `${WORKTREE}2/frontend`, `${WORKTREE}-x/frontend`, '/etc', 'frontend', './frontend', '.', WORKTREE, `${WORKTREE}/`]) {
      const c = `git -C ${p} push -u origin ${BRANCH}`;
      expect(bash(c).deny, c).toBe(true);
    }
  });
  it('denies the -C form when the run has no branch or no usable worktree', () => {
    expect(bash(`git -C ${WORKTREE}/frontend push -u origin ${BRANCH}`, null).deny).toBe(true);
    expect(bash(`git -C /etc push -u origin ${BRANCH}`, BRANCH, '').deny).toBe(true);
    expect(bash(`git -C /etc push -u origin ${BRANCH}`, BRANCH, '/').deny).toBe(true);
    expect(bash(`git -C //etc push -u origin ${BRANCH}`, BRANCH, '/').deny).toBe(true);
    expect(bash(`git -C ${WORKTREE}//frontend push -u origin ${BRANCH}`, BRANCH, `${WORKTREE}/`).deny).toBe(true);
  });
  it('leaves the other git commands in a repo folder to the allow list', () => {
    for (const c of [`git -C ${WORKTREE}/frontend status`, `git -C ${WORKTREE}/frontend log --oneline -5`, 'git -C frontend diff --stat']) expect(bash(c).deny, c).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w @termhub/machine-ops -- guard-script`
Expected: FAIL — `GUARD_SCRIPT_VERSION` is undefined and the `-C <WORKTREE>/<key>` pushes are denied.

- [ ] **Step 3: Implement** — in `guard-script.ts`:

Add, next to `GUARD_SCRIPT_REL`:

```ts
/**
 * The guard's version, also written in the script's header (`# termhub-guard v2`). 2 (spec 2026-10-07
 * multi-repo R13): the push rule also takes `git -C <WORKTREE>/<key> push …`, for a multi-repo run whose
 * `WORKTREE` is the workspace root. The server asks for it by agent version
 * (`MULTI_REPO_GUARD_MIN_AGENT_VERSION`).
 */
export const GUARD_SCRIPT_VERSION = 2;
```

In the script, the second line becomes `# termhub-guard v${GUARD_SCRIPT_VERSION}` and the push rule becomes:

```sh
        ALLOWED=0
        if [ -n "$BRANCH" ]; then
          PUSH="$SQ"
          # v2, multi-repo runs (WORKTREE is the workspace root, one repo per <key>/ folder): the same
          # push as `git -C <WORKTREE>/<key> push …`, read as the plain one. <key> is a repo key: it starts
          # with a letter or digit and holds only letters, digits, . _ -, so no /, no .. and no option.
          # The root itself, a path outside it and a relative path are not this form: denied below.
          case "$WORKTREE" in
            /*[!/])
              case "$SQ" in
                "git -C $WORKTREE/"*)
                  R=${SQ#"git -C $WORKTREE/"}
                  KEY=${R%% *}
                  case "$KEY" in
                    '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]* | *..*) ;;
                    *) PUSH="git ${R#"$KEY "}" ;;
                  esac
                  ;;
              esac
              ;;
          esac
          case "$PUSH" in
            "git push -u origin $BRANCH" | "git push origin $BRANCH" | \
            "git push -u origin HEAD:refs/heads/$BRANCH" | "git push origin HEAD:refs/heads/$BRANCH")
              ALLOWED=1 ;;
          esac
        fi
        [ "$ALLOWED" = 1 ] || deny 'push so para a branch da run'
```

(inside the TS template literal every `${…}` of the shell is written `\${…}`, like the rest of the file.)
Update the doc comment of `GUARD_SCRIPT` (`$2` is the worktree, or the workspace root of a multi-repo run).

- [ ] **Step 4: Run and see them pass**

Run: `npm test -w @termhub/machine-ops -- guard-script`
Expected: PASS, the old cases included.

- [ ] **Step 5: Commit** — `Guard v2: allow the run branch push from a workspace repo folder`.

### Task 2: Allow-list forms for repo keys (server)

**Files:**
- Modify: `apps/server/src/control/automation-tools.ts`
- Test: `apps/server/src/control/automation-tools.test.ts`

**Interfaces:**
- Produces:
  - `interface RunRepos { workspace: string | null; keys: readonly string[] }`
  - `runRepoPaths(repos: RunRepos | null | undefined): string[]` — `<workspace>/<key>` per valid key, each once.
  - `runBranchRules(branch: string | null, repos?: RunRepos | null): string[]`
  - `gitRuleForms(rule: string, worktree: string | null, keys?: readonly string[]): string[]`
  - `automationAllowList(allowed, branch, forms?: { worktree: string | null; keys?: readonly string[] } | null)`

- [ ] **Step 1: Write the failing tests** — a new `describe` in `automation-tools.test.ts` (import
  `runRepoPaths`):

```ts
describe('repo keys: the -C forms of a multi-repo run (spec 2026-10-07 multi-repo R13)', () => {
  const WS = '/Users/u/.termhub/worktrees/P1/TER-903';
  const B = 'TER-903-card';

  it('without keys, every output is the one of a single-repo run', () => {
    expect(runBranchRules(B, null)).toEqual(runBranchRules(B));
    expect(runBranchRules(B, { workspace: WS, keys: [] })).toEqual(runBranchRules(B));
    expect(gitRuleForms('Bash(git log:*)', WS, [])).toEqual(gitRuleForms('Bash(git log:*)', WS));
    expect(automationAllowList(DEFAULT_AUTOMATION_TOOLS, B, { worktree: WS, keys: [] })).toEqual(automationAllowList(DEFAULT_AUTOMATION_TOOLS, B, { worktree: WS }));
    expect(runRepoPaths(null)).toEqual([]);
  });

  it('runBranchRules adds the run branch pushes and fetch from each repo folder, by exact path', () => {
    expect(runBranchRules(B, { workspace: `${WS}/`, keys: ['frontend', 'bff'] })).toEqual([
      ...runBranchRules(B),
      `Bash(git -C ${WS}/frontend push origin ${B})`,
      `Bash(git -C ${WS}/frontend push -u origin ${B})`,
      `Bash(git -C ${WS}/frontend push origin HEAD:refs/heads/${B})`,
      `Bash(git -C ${WS}/frontend push -u origin HEAD:refs/heads/${B})`,
      `Bash(git -C ${WS}/frontend fetch origin ${B})`,
      `Bash(git -C ${WS}/bff push origin ${B})`,
      `Bash(git -C ${WS}/bff push -u origin ${B})`,
      `Bash(git -C ${WS}/bff push origin HEAD:refs/heads/${B})`,
      `Bash(git -C ${WS}/bff push -u origin HEAD:refs/heads/${B})`,
      `Bash(git -C ${WS}/bff fetch origin ${B})`,
    ]);
    expect(runBranchRules(null, { workspace: WS, keys: ['frontend'] })).toEqual([]);
  });

  it('gitRuleForms adds, after today\'s forms, each repo folder by its path and by its key', () => {
    expect(gitRuleForms('Bash(git log:*)', WS, ['frontend'])).toEqual([
      ...gitRuleForms('Bash(git log:*)', WS),
      `Bash(git -C ${WS}/frontend log:*)`,
      `Bash(git -C ${WS}/frontend --no-pager log:*)`,
      `Bash(git --no-pager -C ${WS}/frontend log:*)`,
      'Bash(git -C frontend log:*)',
      'Bash(git -C frontend --no-pager log:*)',
      'Bash(git --no-pager -C frontend log:*)',
    ]);
  });

  it.each(['', '..', '../x', 'a/b', 'a/..', 'a..b', '.git', '-x', 'a b', 'a*', "a'b", 'a(b)', 'a;b', '$HOME'])('gives no rule for the key %j', (key) => {
    expect(runRepoPaths({ workspace: WS, keys: [key] })).toEqual([]);
    expect(runBranchRules(B, { workspace: WS, keys: [key] })).toEqual(runBranchRules(B));
    expect(gitRuleForms('Bash(git log:*)', WS, [key])).toEqual(gitRuleForms('Bash(git log:*)', WS));
  });

  it.each([null, '', 'relative/ws', '/', '/a b/ws', '/a/*/ws', '/a/../ws'])('gives no key rule for the workspace %j', (ws) => {
    expect(runRepoPaths({ workspace: ws, keys: ['frontend'] })).toEqual([]);
    expect(runBranchRules(B, { workspace: ws, keys: ['frontend'] })).toEqual(runBranchRules(B));
    expect(gitRuleForms('Bash(git log:*)', ws, ['frontend'])).toEqual(['Bash(git --no-pager log:*)']);
  });

  it('keeps a valid key next to a bad one, and each key once', () => {
    expect(runRepoPaths({ workspace: WS, keys: ['frontend', '../x', 'frontend', 'api.v2'] })).toEqual([`${WS}/frontend`, `${WS}/api.v2`]);
  });

  it('the allow list of a multi-repo run: exact rules, never a -C with a wildcard, none of them a project rule', () => {
    const list = automationAllowList(DEFAULT_AUTOMATION_TOOLS, B, { worktree: WS, keys: ['frontend', 'bff'] });
    expect(list).toContain(`Bash(git -C ${WS}/frontend push -u origin ${B})`);
    expect(list).toContain(`Bash(git -C ${WS}/bff fetch origin ${B})`);
    expect(list).toContain(`Bash(git -C ${WS}/bff show:*)`);
    expect(list).toContain('Bash(git -C frontend log:*)');
    expect(list.some((r) => /git (--no-pager )?-C [^ ]*\*/.test(r))).toBe(false);
    expect(list.some((r) => r.includes(`-C ${WS}/frontend/`))).toBe(false);
    expect(new Set(list).size).toBe(list.length);
    for (const r of runBranchRules(B, { workspace: WS, keys: ['frontend'] })) expect(unsafeAllowedTool(r), r).toBe(true);
    // the single-repo list is a prefix-free subset: every rule of it is still there
    for (const r of automationAllowList(DEFAULT_AUTOMATION_TOOLS, B, { worktree: WS })) expect(list).toContain(r);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w @termhub/server -- src/control/automation-tools`
Expected: FAIL — `runRepoPaths` is not exported; the key arguments are ignored.

- [ ] **Step 3: Implement** — in `automation-tools.ts`:

```ts
/** The repo folders of a multi-repo run (spec 2026-10-07 multi-repo R11): the workspace root, and one key per repo. */
export interface RunRepos {
  workspace: string | null;
  keys: readonly string[];
}

/** A repo key that can sit in a path and in a rule as is: the charset the guard accepts (no `/`, no `..`). */
const REPO_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safeRepoKey = (key: string) => REPO_KEY.test(key) && !key.includes('..');
const ruleDir = (p: string | null) => {
  const dir = p?.replace(/\/+$/, '') ?? null;
  return safeRulePath(dir) ? dir : null;
};

/** `<workspace>/<key>` of each repo of a run, each once; nothing for an unsafe workspace or key. */
export function runRepoPaths(repos: RunRepos | null | undefined): string[] {
  const dir = ruleDir(repos?.workspace ?? null);
  if (!dir || !repos) return [];
  return [...new Set(repos.keys.filter(safeRepoKey))].map((key) => `${dir}/${key}`);
}
```

(`RULE_PATH` / `safeRulePath` move above these.) `runBranchRules`:

```ts
export function runBranchRules(branch: string | null, repos?: RunRepos | null): string[] {
  const own = [...branchPushRules(branch), ...branchFetchRules(branch)];
  const inRepo = runRepoPaths(repos).flatMap((p) => own.map((r) => r.replace(/^Bash\(git /, `Bash(git -C ${p} `)));
  return [...own, ...inRepo];
}
```

`gitRuleForms`:

```ts
export function gitRuleForms(rule: string, worktree: string | null, keys: readonly string[] = []): string[] {
  const m = /^Bash\(git (?!-)([\s\S]+)\)$/.exec(rule);
  if (!m) return [];
  const dir = ruleDir(worktree);
  const repoPaths = runRepoPaths({ workspace: dir, keys });
  const paths = dir ? [dir, `${dir}/`, '.', ...repoPaths.flatMap((p) => [p, p.slice(dir.length + 1)])] : [];
  …unchanged
}
```

`automationAllowList` passes `forms.keys` to both. Update the three doc comments (the "a subfolder included"
sentence now says: except the run's own repo folders, by exact path).

- [ ] **Step 4: Run and see them pass**

Run: `npm test -w @termhub/server -- src/control/automation-tools src/control/agents src/automation/answers`
Expected: PASS.

- [ ] **Step 5: Commit** — `Automation: -C allow-list forms for the repo folders of a run`.

### Task 3: Agent version gate and release

**Files:**
- Modify: `apps/server/src/terminal/tab-mcp.ts`, `apps/server/src/terminal/tab-mcp.test.ts`
- Modify: `apps/agent/package.json`, `apps/agent/src/version.ts`, `package-lock.json`
- Modify: `docs/automation/runbook.md`

**Interfaces:**
- Produces: `MULTI_REPO_GUARD_MIN_AGENT_VERSION = '0.29.0'`, `multiRepoGuardSupported(machine: Machine): boolean`.

- [ ] **Step 1: Write the failing test** — in `tab-mcp.test.ts`, import both names and add:

```ts
describe('multiRepoGuardSupported (spec 2026-10-07 multi-repo R18)', () => {
  it('for an agent from 0.29.0 on, the connected version first; the plain guard gate is unchanged', () => {
    expect(MULTI_REPO_GUARD_MIN_AGENT_VERSION).toBe('0.29.0');
    expect(multiRepoGuardSupported(machine('ssh'))).toBe(false);
    expect(multiRepoGuardSupported(machine('agent', '0.28.1'))).toBe(false);
    expect(multiRepoGuardSupported(machine('agent', '0.29.0'))).toBe(true);
    expect(multiRepoGuardSupported(machine('agent', null))).toBe(false);
    expect(guardSupported(machine('agent', '0.28.1'))).toBe(true);
    info.mockReturnValue({ agent_version: '0.28.1' });
    expect(multiRepoGuardSupported(machine('agent', '0.29.0'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npm test -w @termhub/server -- src/terminal/tab-mcp` → FAIL (undefined).

- [ ] **Step 3: Implement** — in `tab-mcp.ts`, after `guardSupported`:

```ts
/** First agent release whose guard is version 2 (spec 2026-10-07 multi-repo R13, R18): its push rule takes
 *  `git -C <workspace>/<key> push …`, which a multi-repo run needs. `MIN_AGENT_VERSION` is not raised for it:
 *  a machine below this keeps running single-repo cards. */
export const MULTI_REPO_GUARD_MIN_AGENT_VERSION = '0.29.0';

/** Whether the machine's guard is version 2 (agent 0.29.0+), same reading as `guardSupported`. */
export function multiRepoGuardSupported(machine: Machine): boolean {
  if (machine.type !== 'agent') return false;
  const version = agents.info(machine.id)?.agent_version ?? machine.agent_version;
  return !!version && versionAtLeast(version, MULTI_REPO_GUARD_MIN_AGENT_VERSION);
}
```

Bump `0.28.1` → `0.29.0` in `apps/agent/package.json`, `apps/agent/src/version.ts` and the
`apps/agent` entry of `package-lock.json`. Add to the runbook's hard-lock paragraph: guard v2 (agent
0.29.0+) also takes the run's branch push as `git -C <workspace>/<key> push …`, for multi-repo runs.

- [ ] **Step 4: Verify everything**

Run: `npm run build:packages && npm run prisma:generate`, then
`npm test -w @termhub/machine-ops`, `npm test -w @termhub/agent`,
`npm test -w @termhub/server -- src/control src/terminal src/automation`, `npm run typecheck -w @termhub/server`,
`npm run build -w @termhub/agent`.
Expected: all pass (the agent's `version.test.ts` checks the two version fields agree, and `hooks.test.ts`
that the agent writes this `GUARD_SCRIPT`).

- [ ] **Step 5: Commit** — `Agent 0.29.0: ship guard v2 (MULTI_REPO_GUARD_MIN_AGENT_VERSION)`.

## Impact on other users

Nothing changes for anyone: no run passes keys yet, so every allow list is the one of today, and the guard
decides each command of a single-repo run as before. The only new thing a machine gets is agent 0.29.0 (by
auto-update or the update button), whose guard additionally accepts the run's own branch pushed from a direct
subfolder of its worktree; that form is not in any single-repo allow list. Not a setting: it is inert.
