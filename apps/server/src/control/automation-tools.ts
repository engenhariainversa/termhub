import { GIT_BRANCH_RE } from '@termhub/agent-protocol';

/**
 * The rules that bound an automatic tab (TER-968, spike R5): the fixed deny list, the run's own push rules
 * and the filter that keeps a project's allow list from reopening what the deny list leaves to the allow
 * list. No dependency on the rest of the server, so the setup schema can use it too.
 */

/**
 * termhub MCP tools an automatic tab never calls (TER-993), from the person's own `termhub` MCP when their
 * Claude config loads it: what would let a run reach past its card — change what automation may do, drive or
 * close other tabs, start agents, answer the person's cards, touch machines, repositories, integrations or
 * external tickets, delete cards. Not on the tab's line (a resume line is typed whole and has no room for
 * them): the server never answers yes to them (`permissionAllowed`).
 */
export const AUTOMATION_MCP_DENIED_TOOLS: readonly string[] = [
  'set_automation_policy', 'resume_automation', 'resume_automation_run', 'escalate_automation_run', 'set_machine_automation',
  'start_agent', 'open_tab', 'close_tab', 'send_input', 'send_key', 'run_command', 'answer_tab_question',
  'link_project_machine', 'unlink_project_machine', 'set_project_machine_cwd', 'set_project_repo',
  'create_integration', 'push_ticket_status', 'delete_task',
].map((t) => `mcp__termhub__${t}`);

/**
 * What an automatic tab never does, whatever its project allows (TER-968, spec R5): fixed here, not
 * editable per project, passed as `--disallowedTools` on every automatic line and applied again by the
 * server's `permissionAllowed`, where it beats any `allowed_tools` entry.
 *
 * Claude Code's rule syntax (https://code.claude.com/docs/en/permissions, read 2026-10-05): rules are
 * evaluated deny → ask → allow and "an allow rule can't carve an exception out of a deny rule", so a
 * generic `Bash(git push:*)` here would also block the run's own branch. Pushes are closed instead by the
 * allow list (only `branchPushRules`; any other push asks and the server escalates it, never "allow"), and
 * the forms that can never be the run's own branch push (force, delete, mirror, a `+` refspec) are denied
 * outright. `*` matches anywhere in a Bash rule and `X:*` equals `X *`, which needs a space after `X`:
 * `npm run release*` (no space) is what covers `release:ota`. Read and Edit rules are gitignore patterns
 * (`~/` is the home dir, `//` the filesystem root, `**` any depth): the `.env` rules start with `//`, since
 * without it the pattern is anchored at the session's cwd (the worktree) and would miss the main checkout
 * next to it.
 * A Read deny also blocks `cat`/`head`/… on that path in Bash.
 */
export const AUTOMATION_DENIED_TOOLS: readonly string[] = [
  'Bash(git push --force*)',
  'Bash(git push * --force*)',
  'Bash(git push -f*)',
  'Bash(git push * -f*)',
  'Bash(git push --delete*)',
  'Bash(git push * --delete*)',
  'Bash(git push -d*)',
  'Bash(git push * -d*)',
  'Bash(git push --mirror*)',
  'Bash(git push * --mirror*)',
  'Bash(git push * +*)',
  // git options that run a program or reach outside the worktree, on the subcommands the allow list names
  // (TER-968 review 2: `git fetch --upload-pack='…' .` runs any command)
  'Bash(git -c*)',
  'Bash(git * -c *)',
  'Bash(git *--config-env*)',
  // git's subcommand options take any unambiguous prefix (`git fetch --upload-p=cmd .` runs cmd), so each
  // deny is the shortest prefix no other option of those commands shares: `--upl` (fetch: `--update-*`),
  // `--rece` (push: `--recurse-submodules`), `--ext` (diff: `--exit-code`); a push's `--exec` (an alias of
  // `--receive-pack`) from `--e`. Global options (`-c`, `--config-env`, `--exec-path`) are parsed whole.
  'Bash(git *--upl*)',
  'Bash(git *--rece*)',
  'Bash(git *--exec*)',
  'Bash(git push *--e*)',
  'Bash(git diff *--ext*)',
  'Bash(git log *--ext*)',
  'Bash(git diff *--output*)',
  'Bash(git log *--output*)',
  'Bash(git diff *--no-index*)',
  'Bash(git merge -s*)',
  'Bash(git merge * -s*)',
  'Bash(git merge *--str*)',
  // options that run a program or write a file, on the read commands `AUTOMATION_READ_TOOLS` allows (TER-989)
  'Bash(find *-exec*)',
  'Bash(find *-ok*)',
  'Bash(find *-delete*)',
  'Bash(find *-fprint*)',
  'Bash(find *-fls*)',
  'Bash(rg *--pre*)',
  'Bash(git grep *-O*)',
  'Bash(git grep *--open*)',
  'Bash(git show *--ext*)',
  'Bash(git show *--output*)',
  'Bash(sort *-o*)',
  'Bash(sort *--comp*)',
  'Bash(gh pr merge:*)',
  'Bash(gh api:*)',
  'Bash(gh secret:*)',
  'Bash(gh workflow:*)',
  'Bash(gh release:*)',
  'Bash(gh repo:*)',
  'Bash(npm publish:*)',
  'Bash(pnpm publish:*)',
  'Bash(yarn publish:*)',
  'Bash(npm run release*)',
  'Bash(eas:*)',
  'Bash(eas-cli:*)',
  'Bash(npx eas*)',
  'Bash(fastlane:*)',
  'Bash(docker:*)',
  'Bash(psql:*)',
  'Bash(security:*)',
  // reaching other machines or clusters from an automatic tab (TER-968)
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(rsync:*)',
  'Bash(kubectl:*)',
  'Bash(rm -rf:*)',
  'Bash(rm -fr:*)',
  'Bash(rm -r:*)',
  'Bash(rm -R:*)',
  'Read(//**/.env*)',
  'Edit(//**/.env*)',
  'Read(~/.ssh/**)',
  'Edit(~/.ssh/**)',
  'Read(~/.config/gh/**)',
  'Edit(~/.config/gh/**)',
  'Read(~/.claude*/.credentials.json)',
  'Edit(~/.claude*/.credentials.json)',
  'Read(~/.aws/**)',
  'Edit(~/.aws/**)',
  // credentials a free `cat` could reach outside the worktree (TER-989): the machine agent's own config, the
  // hook's env, other tabs' MCP tokens, npm/git/docker logins. Read only: acceptEdits never edits outside it.
  'Read(~/.termhub/config.json)',
  'Read(~/.termhub/hook.env)',
  'Read(~/.termhub/tabs/**)',
  'Read(~/.npmrc)',
  'Read(~/.netrc)',
  'Read(~/.git-credentials)',
  'Read(~/.docker/config.json)',
];

/**
 * The git denies of `AUTOMATION_DENIED_TOOLS` again, in the forms `gitRuleForms` allows (TER-991):
 * `git -C <worktree> log --ext-diff` and `git --no-pager diff --output=x` start with neither `git log` nor
 * `git diff`. Only for the `:*` rules: a push form is exact, so no option can be added to it. Kept apart
 * from the fixed list because a line typed whole has no room for them (`gitRuleForms`); the server's
 * `permissionAllowed` always applies them.
 */
export const AUTOMATION_FORM_DENIED_TOOLS: readonly string[] = [
  ...['--ext', '--output', '--no-index'].flatMap((o) => [`Bash(git -C *${o}*)`, `Bash(git --no-pager *${o}*)`]),
  ...['merge -s*', 'merge * -s*', 'merge *--str*', 'grep *-O*', 'grep *--open*'].flatMap((rest) =>
    ['-C * ', '--no-pager ', '--no-pager -C * '].map((p) => `Bash(git ${p}${rest})`),
  ),
];

/**
 * What every automatic tab may run without asking, whatever its project's allow list says (TER-989): reading
 * and searching the code and git's read commands. Fixed here like the deny list, since an agent's first move
 * is a search, and a run whose `grep` asks stops for the person seconds after it starts. Only commands that
 * cannot write or run another program: the options of these that could (`find -exec`, `rg --pre`,
 * `git grep -O`, `sort -o`…) are in `AUTOMATION_DENIED_TOOLS`, read before any allow rule. No `sed`, `awk`,
 * `xargs` or `echo` (sed's `e` and awk's `system` run commands; a redirect writes). Claude Code splits a
 * piped or chained command and checks each part, so `rg x | head -40` passes; a command with more than one
 * `cd` always asks (the prompt says to avoid it). Files inside the worktree are written by `acceptEdits`.
 */
export const AUTOMATION_READ_TOOLS: readonly string[] = [
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(find:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(sort:*)',
  'Bash(diff:*)',
  'Bash(pwd)',
  'Bash(git show:*)',
  'Bash(git grep:*)',
  'Bash(git blame:*)',
  'Bash(git rev-parse:*)',
  'Bash(git ls-files:*)',
  'Bash(git merge-base:*)',
  'Bash(git branch)',
  'Bash(git branch --show-current)',
  'Bash(git remote -v)',
];

/**
 * termhub's own MCP tools an automatic tab may call (TER-993), from the person's `termhub` MCP when their
 * Claude config loads it: reading and adding cards. The server answers yes to their permission requests
 * (`permissionAllowed`); they are not on the tab's line, which has no room left. The tab MCP's tools
 * (`termhub_tab`) come pre-allowed with its `--mcp-config`. Exact names only: `mcp__termhub__*` would cover
 * `AUTOMATION_MCP_DENIED_TOOLS`. Moving or editing a card (`move_task`, `update_task`) is left to the mode.
 */
export const AUTOMATION_MCP_TOOLS: readonly string[] = [
  'find', 'search_memory', 'get_automation_policy', 'get_project_setup', 'get_ticket', 'list_tasks', 'list_tickets', 'list_projects',
  'list_project_groups', 'list_machines', 'list_tabs', 'list_automation_events', 'list_automation_queue', 'read_attachment',
  'create_task', 'add_subtasks', 'record_lesson',
].map((t) => `mcp__termhub__${t}`);

/**
 * The pushes an automatic run may send without asking (TER-968, spec R5): exact rules naming its own
 * branch — the card's branch, the PR's branch for a fixer, the epic branch for an integrator. A name the
 * agent's charset refuses (`GIT_BRANCH_RE`: no space, `*`, `:` or `+`) gives no rule, so every push asks.
 */
export function branchPushRules(branch: string | null): string[] {
  if (!branch || !GIT_BRANCH_RE.test(branch)) return [];
  return [
    `Bash(git push origin ${branch})`,
    `Bash(git push -u origin ${branch})`,
    `Bash(git push origin HEAD:refs/heads/${branch})`,
    `Bash(git push -u origin HEAD:refs/heads/${branch})`,
  ];
}

/**
 * The fetch an automatic run may send for its own branch, next to the default list's exact `git fetch` and
 * `git fetch origin` (which brings the base and the epic branch too). Exact on purpose: `git fetch:*`
 * would cover `--upload-pack=<command>`.
 */
export function branchFetchRules(branch: string | null): string[] {
  if (!branch || !GIT_BRANCH_RE.test(branch)) return [];
  return [`Bash(git fetch origin ${branch})`];
}

/** Every rule an automatic run gets from its own branch: its pushes and its fetch. */
export function runBranchRules(branch: string | null): string[] {
  return [...branchPushRules(branch), ...branchFetchRules(branch)];
}

/**
 * A worktree path that can sit inside a rule as is: absolute, and none of the characters that would change
 * what the rule means to Claude Code (`*`, a space, `(`/`)`, quotes, shell operators) or a `..` segment.
 */
const RULE_PATH = /^\/[A-Za-z0-9._@%+=,~/-]*[A-Za-z0-9._@%+=,~-]$/;
const safeRulePath = (p: string | null): p is string => !!p && RULE_PATH.test(p) && !p.split('/').includes('..');

/**
 * The same git rule in the equivalent forms an agent writes (TER-991): `git --no-pager <sub>` and, with the
 * run's worktree, `git -C <worktree> <sub>` (the path as is, with a trailing `/` and as `.`, since the tab's
 * cwd is the worktree), alone or with `--no-pager` on either side. Claude Code matches a rule on the
 * command's text, so `Bash(git log:*)` misses `git -C <worktree> log`. Only the run's own worktree: a `-C`
 * anywhere else (a subfolder included, since a `*` would also take `../..`) still asks. `-c core.pager=cat`
 * stays denied with every `-c`, and nothing covers `GIT_PAGER=cat git …`: the Bash tool has no pager.
 */
export function gitRuleForms(rule: string, worktree: string | null): string[] {
  const m = /^Bash\(git (?!-)([\s\S]+)\)$/.exec(rule);
  if (!m) return [];
  const dir = worktree?.replace(/\/+$/, '') ?? null;
  const paths = safeRulePath(dir) ? [dir, `${dir}/`, '.'] : [];
  const prefixes = ['--no-pager', ...paths.flatMap((p) => [`-C ${p}`, `-C ${p} --no-pager`, `--no-pager -C ${p}`])];
  return prefixes.map((p) => `Bash(git ${p} ${m[1]})`);
}

/**
 * The whole allow list of an automatic tab (TER-989): the fixed read rules, the project's list less what is
 * too broad (`safeAllowedTools`) and the run's own branch rules, each once. With `forms` (TER-991), every git
 * rule also comes in the forms of `gitRuleForms` for the run's worktree; the line must then carry
 * `AUTOMATION_FORM_DENIED_TOOLS` too (`automationDenyList`). The tab's line and the server's
 * `permissionAllowed` both use it, so they never disagree.
 */
export function automationAllowList(allowed: readonly string[], branch: string | null, forms?: { worktree: string | null } | null): string[] {
  const base = [...AUTOMATION_READ_TOOLS, ...safeAllowedTools(allowed).kept, ...runBranchRules(branch)];
  return [...new Set(forms ? [...base, ...base.flatMap((r) => gitRuleForms(r, forms.worktree))] : base)];
}

/** The deny list of a line: the fixed one, plus the denies of the git forms when the line allows them. */
export function automationDenyList(forms: boolean): readonly string[] {
  return forms ? [...AUTOMATION_DENIED_TOOLS, ...AUTOMATION_FORM_DENIED_TOOLS] : AUTOMATION_DENIED_TOOLS;
}

/**
 * Command families an allow rule must never reach: every `git push` (only `branchPushRules` may allow one)
 * and the start of every denied Bash command (`AUTOMATION_DENIED_TOOLS`, text before its first `*`).
 */
const DANGER_FAMILIES: readonly Family[] = [
  { text: 'git push', glued: false },
  ...AUTOMATION_DENIED_TOOLS.flatMap((r) => {
    const m = /^Bash\((.*)\)$/.exec(r);
    if (!m) return [];
    const glob = m[1]!.replace(/:\*$/, ' *');
    // only a deny whose one `*` ends it names a family; `git * -c *` is about an option, not a command
    if (glob.indexOf('*') !== glob.length - 1) return glob.includes('*') ? [] : [{ text: squash(glob).toLowerCase(), glued: false }];
    const before = glob.slice(0, -1);
    // a git option deny (`git merge -s*`) is enforced by the CLI whatever the allow list says; as a family
    // it would drop `git merge:*` itself. Every `git push` is a family on its own, above.
    if (/^git( \S+)* -/.test(before)) return [];
    // `npm run release*`: the `*` is glued to the word, so `npm run release:ota` is in the family too
    return [{ text: squash(before).toLowerCase(), glued: before !== '' && !before.endsWith(' ') }];
  }),
];

/** A command family: its leading text, and whether it reaches past the last word (`glued`, no space before the `*`). */
interface Family {
  text: string;
  glued: boolean;
}

/**
 * Commands that run another command given as their argument: a wildcard after them reaches anything,
 * `sh -c 'git push origin main'` included. An exact rule naming one (`npx prisma generate`) stays.
 */
const RUNNERS: readonly string[] = [
  'sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'eval', 'exec', 'sudo', 'xargs', 'timeout', 'nice', 'nohup', 'time', 'stdbuf', 'command', 'builtin',
  'npx', 'npm exec', 'npm x', 'pnpm exec', 'pnpm dlx', 'yarn dlx', 'bunx',
];

/** git words that send to a remote (`git -C x push`, `git subtree push`, `git send-pack`) or set a program (global options). */
const GIT_SENDS = new Set(['push', 'send-pack', 'subtree']);
const GIT_PROGRAM_OPTION = /^(-c|--config-env|--exec-path|--exec|--upload-pack|--receive-pack)(=|$)/;

function squash(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** The rule's text is the family's or lies inside it (on a word boundary, or anywhere after a glued family). */
const inFamily = (literal: string, family: string, glued = false) => literal === family || literal.startsWith(glued ? family : `${family} `);

/**
 * Whether an allow rule is too broad for an automatic tab (TER-968, review 1): Claude Code reads deny before
 * allow, and pushes are not denied (an allow could not carve the run's own branch back out), so a project's
 * `Bash`, `Bash(*)`, `Bash(git:*)`, `Bash(git *)` or `Bash(git push:*)` would let any push run without a
 * question. Refused: a tool-name wildcard, a bare `Bash`, a Bash rule that could match any `git push` or a
 * denied command (its text before the first `*` starts one of them, or it sits inside one), a wildcard
 * after a git global option (`git -C x push`) or after a command runner (`sh -c`, `env`, `npx`…).
 */
export function unsafeAllowedTool(rule: string): boolean {
  const m = /^([^()\s]+)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
  if (!m) return true;
  const [, tool, spec] = m;
  if (tool!.includes('*')) return true;
  if (tool !== 'Bash') return false;
  // `Bash` and `Bash()` both mean every command
  if (spec === undefined || spec.trim() === '') return true;
  const glob = squash(spec.endsWith(':*') ? `${spec.slice(0, -2)} *` : spec);
  // a program named by path, quoted or escaped (`/usr/bin/git`, `'git'`, `g\it`) hides what it is
  if (/[/'"\\`]/.test(glob.split(' ')[0]!)) return true;
  const wild = glob.includes('*');
  // compared in lower case: on a case-insensitive file system `GIT` runs git
  const literal = (wild ? glob.slice(0, glob.indexOf('*')) : glob).toLowerCase();
  const head = literal.trimEnd();
  if (DANGER_FAMILIES.some((f) => inFamily(head, f.text, f.glued) || (wild && f.text.startsWith(literal)))) return true;
  const words = head.split(' ');
  if (words[0] === 'git' && words.slice(1).some((w) => GIT_SENDS.has(w) || GIT_PROGRAM_OPTION.test(w))) return true;
  if (!wild) return false;
  if (/^git -/.test(literal)) return true;
  // only the exact fetch rules (`git fetch`, `git fetch origin`, the run's branch): a wildcard reaches its options
  if (inFamily(head, 'git fetch') || 'git fetch'.startsWith(literal)) return true;
  return RUNNERS.some((r) => inFamily(head, r) || r.startsWith(literal));
}

/** A project's allow list split into what an automatic tab gets and what it drops (`unsafeAllowedTool`). */
export function safeAllowedTools(tools: readonly string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const t of tools) (unsafeAllowedTool(t) ? dropped : kept).push(t);
  return { kept, dropped };
}
