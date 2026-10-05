import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION_TOOLS } from './agents.js';
import { branchPushRules, runBranchRules, safeAllowedTools, unsafeAllowedTool } from './automation-tools.js';

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

  it('splits a list into kept and dropped, in order', () => {
    expect(safeAllowedTools(['Bash(npm test:*)', 'Bash', 'WebFetch', 'Bash(git:*)'])).toEqual({ kept: ['Bash(npm test:*)', 'WebFetch'], dropped: ['Bash', 'Bash(git:*)'] });
  });
});
