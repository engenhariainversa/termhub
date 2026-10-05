import { GIT_BRANCH_RE } from '@termhub/agent-protocol';

/**
 * The rules that bound an automatic tab (TER-968, spike R5): the fixed deny list, the run's own push rules
 * and the filter that keeps a project's allow list from reopening what the deny list leaves to the allow
 * list. No dependency on the rest of the server, so the setup schema can use it too.
 */

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
  'Bash(gh pr merge:*)',
  'Bash(gh api:*)',
  'Bash(gh secret:*)',
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
];

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
 * Command families an allow rule must never reach: every `git push` (only `branchPushRules` may allow one)
 * and the start of every denied Bash command (`AUTOMATION_DENIED_TOOLS`, text before its first `*`).
 */
const DANGER_FAMILIES: readonly Family[] = [
  { text: 'git push', glued: false },
  ...AUTOMATION_DENIED_TOOLS.flatMap((r) => {
    const m = /^Bash\((.*)\)$/.exec(r);
    if (!m) return [];
    const before = m[1]!.replace(/:\*$/, ' *').split('*')[0]!;
    // `npm run release*`: the `*` is glued to the word, so `npm run release:ota` is in the family too
    return [{ text: squash(before), glued: before !== '' && !before.endsWith(' ') && m[1]!.includes('*') }];
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
const RUNNERS: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'eval', 'exec', 'sudo', 'xargs', 'npx', 'timeout', 'nice', 'nohup', 'time', 'stdbuf', 'command', 'builtin'];

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
  if (spec === undefined) return true;
  const glob = squash(spec.endsWith(':*') ? `${spec.slice(0, -2)} *` : spec);
  const wild = glob.includes('*');
  const literal = wild ? glob.slice(0, glob.indexOf('*')) : glob;
  const head = literal.trimEnd();
  if (DANGER_FAMILIES.some((f) => inFamily(head, f.text, f.glued) || (wild && f.text.startsWith(literal)))) return true;
  if (!wild) return false;
  if (/^git -/.test(literal)) return true;
  return RUNNERS.some((r) => inFamily(head, r) || r.startsWith(literal));
}

/** A project's allow list split into what an automatic tab gets and what it drops (`unsafeAllowedTool`). */
export function safeAllowedTools(tools: readonly string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const t of tools) (unsafeAllowedTool(t) ? dropped : kept).push(t);
  return { kept, dropped };
}
