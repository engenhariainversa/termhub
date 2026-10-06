import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION_TOOLS } from './agents.js';
import { AUTOMATION_DENIED_TOOLS, AUTOMATION_READ_TOOLS, automationAllowList, branchPushRules, runBranchRules, safeAllowedTools, unsafeAllowedTool } from './automation-tools.js';

describe('unsafeAllowedTool: allow rules too broad for an automatic tab (TER-968, review 1)', () => {
  it.each([
    'Bash',
    'Bash(*)',
    'Bash(:*)',
    'Bash(* --version)',
    'Bash(g*)',
    'Bash(git:*)',
    'Bash(git *)',
    'Bash(git * main)',
    'Bash(git pu*)',
    'Bash(git push:*)',
    'Bash(git push *)',
    'Bash(git push origin HEAD)',
    'Bash(git push -u origin HEAD)',
    'Bash(git push origin HEAD:main)',
    'Bash(git -C:*)',
    'Bash(git -c x:*)',
    'Bash(gh:*)',
    'Bash(gh pr:*)',
    'Bash(gh pr merge 3)',
    'Bash(gh api:*)',
    'Bash(npm:*)',
    'Bash(npm run:*)',
    'Bash(npm run release:ota)',
    'Bash(npm publish)',
    'Bash(docker ps)',
    'Bash(docker:*)',
    'Bash(rm:*)',
    'Bash(rm -rf dist)',
    'Bash(eas build)',
    'Bash(npx:*)',
    'Bash(npx eas update)',
    'Bash(sh -c:*)',
    'Bash(bash:*)',
    'Bash(env:*)',
    'Bash(xargs:*)',
    'Bash(timeout 30 *)',
    '*',
    'B*',
    'not a rule(',
    // review 2
    'Bash()',
    'Bash( )',
    'Bash(npm exec:*)',
    'Bash(npm x:*)',
    'Bash(pnpm exec:*)',
    'Bash(pnpm dlx:*)',
    'Bash(yarn dlx:*)',
    'Bash(bunx:*)',
    'Bash(/usr/bin/git status:*)',
    'Bash(./node_modules/.bin/eas:*)',
    "Bash('git' push)",
    'Bash("git" status:*)',
    'Bash(g\\it push)',
    'Bash(GIT push:*)',
    'Bash(Git Push origin main)',
    'Bash(DOCKER ps)',
    'Bash(git -C /w push origin main)',
    'Bash(git subtree push --prefix x origin main)',
    'Bash(git send-pack origin main)',
    'Bash(git -c core.sshCommand=x fetch)',
    'Bash(git fetch --upload-pack=x .)',
    'Bash(git gh-pages push)',
    'Bash(gh workflow:*)',
    'Bash(gh release create v1)',
    'Bash(gh repo:*)',
    // review 3: only the exact fetch rules
    'Bash(git fetch:*)',
    'Bash(git fetch *)',
    'Bash(git fetch origin:*)',
    'Bash(git fetch origin *)',
    'Bash(git f*)',
    'Bash(git fetch*)',
  ])('%s is refused', (rule) => {
    expect(unsafeAllowedTool(rule)).toBe(true);
  });

  it.each(['Bash(npm test:*)', 'Bash(npm run build:*)', 'Bash(git status:*)', 'Bash(git merge:*)', 'Bash(gh pr view:*)', 'Bash(npx prisma generate)', 'Bash(git)', 'Bash(ls *)', 'Bash(git fetch)', 'Bash(git fetch origin main)', 'Bash(npm exec)', 'Bash(git diff --stat:*)', 'WebFetch', 'Edit', 'Read(src/**)', 'mcp__x__y'])(
    '%s is kept',
    (rule) => {
      expect(unsafeAllowedTool(rule)).toBe(false);
    },
  );

  it('keeps the whole default list and none of the run\'s own push rules would pass as a project rule', () => {
    expect(safeAllowedTools(DEFAULT_AUTOMATION_TOOLS)).toEqual({ kept: DEFAULT_AUTOMATION_TOOLS, dropped: [] });
    for (const own of branchPushRules('TER-1-card')) expect(unsafeAllowedTool(own), own).toBe(true);
    expect(runBranchRules('TER-1-card')).toContain('Bash(git fetch origin TER-1-card)');
  });

  it.each(['Bash(ssh:*)', 'Bash(ssh host ls)', 'Bash(scp:*)', 'Bash(rsync -a:*)', 'Bash(kubectl get:*)', 'Bash(kubectl:*)'])('drops %s from a project allow list (remote reach)', (rule) => {
    expect(unsafeAllowedTool(rule)).toBe(true);
  });

  it('denies ssh, scp, rsync and kubectl, and no deny covers a default rule', () => {
    for (const r of ['Bash(ssh:*)', 'Bash(scp:*)', 'Bash(rsync:*)', 'Bash(kubectl:*)']) expect(AUTOMATION_DENIED_TOOLS).toContain(r);
    for (const rule of DEFAULT_AUTOMATION_TOOLS) expect(unsafeAllowedTool(rule), rule).toBe(false);
  });

  it('splits a list into kept and dropped, in order', () => {
    expect(safeAllowedTools(['Bash(npm test:*)', 'Bash', 'WebFetch', 'Bash(git:*)'])).toEqual({ kept: ['Bash(npm test:*)', 'WebFetch'], dropped: ['Bash', 'Bash(git:*)'] });
  });
});

describe('automationAllowList: the whole allow list of an automatic tab (TER-989)', () => {
  it('every read rule would pass as a project rule too', () => {
    for (const rule of AUTOMATION_READ_TOOLS) expect(unsafeAllowedTool(rule), rule).toBe(false);
  });

  it('keeps the read rules under a project list of its own, drops what is too broad and adds the run branch, each once', () => {
    const list = automationAllowList(['Bash(make check)', 'Bash', 'Bash(grep:*)'], 'TER-1-card');
    for (const rule of AUTOMATION_READ_TOOLS) expect(list).toContain(rule);
    expect(list).toContain('Bash(make check)');
    expect(list).not.toContain('Bash');
    expect(list).toContain('Bash(git push -u origin TER-1-card)');
    expect(list.filter((r) => r === 'Bash(grep:*)')).toHaveLength(1);
  });

  it('allows no push, publish, deploy or store command beyond the run branch', () => {
    const list = automationAllowList(DEFAULT_AUTOMATION_TOOLS, null);
    expect(list.some((r) => /git push|publish|release|eas|docker|fastlane|gh pr merge|gh workflow/.test(r))).toBe(false);
  });

  it('denies the options of the read commands that run a program or write a file', () => {
    for (const r of ['Bash(find *-exec*)', 'Bash(find *-delete*)', 'Bash(rg *--pre*)', 'Bash(git grep *-O*)', 'Bash(git show *--ext*)', 'Bash(sort *-o*)']) expect(AUTOMATION_DENIED_TOOLS).toContain(r);
  });
});
