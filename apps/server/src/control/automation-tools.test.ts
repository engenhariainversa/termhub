import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION_TOOLS } from './agents.js';
import { branchPushRules, safeAllowedTools, unsafeAllowedTool } from './automation-tools.js';

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
  ])('%s is refused', (rule) => {
    expect(unsafeAllowedTool(rule)).toBe(true);
  });

  it.each(['Bash(npm test:*)', 'Bash(npm run build:*)', 'Bash(git status:*)', 'Bash(git merge:*)', 'Bash(gh pr view:*)', 'Bash(npx prisma generate)', 'Bash(git)', 'Bash(ls *)', 'WebFetch', 'Edit', 'Read(src/**)', 'mcp__x__y'])(
    '%s is kept',
    (rule) => {
      expect(unsafeAllowedTool(rule)).toBe(false);
    },
  );

  it('keeps the whole default list and none of the run\'s own push rules would pass as a project rule', () => {
    expect(safeAllowedTools(DEFAULT_AUTOMATION_TOOLS)).toEqual({ kept: DEFAULT_AUTOMATION_TOOLS, dropped: [] });
    for (const own of branchPushRules('TER-1-card')) expect(unsafeAllowedTool(own), own).toBe(true);
  });

  it('splits a list into kept and dropped, in order', () => {
    expect(safeAllowedTools(['Bash(npm test:*)', 'Bash', 'WebFetch', 'Bash(git:*)'])).toEqual({ kept: ['Bash(npm test:*)', 'WebFetch'], dropped: ['Bash', 'Bash(git:*)'] });
  });
});
