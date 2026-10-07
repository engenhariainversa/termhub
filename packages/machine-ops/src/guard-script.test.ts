/**
 * Runs the real guard script under `sh`, as Claude Code runs a PreToolUse hook: the event JSON on
 * stdin, the run's branch as $1 and its worktree as $2. A denial is printed on stdout as Claude Code's
 * `permissionDecision: "deny"`; an allow prints nothing. Each blocked item of the hard lock (TER-993)
 * has its own case here, and the normal-run cases prove the guard stays silent on them.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUARD_SCRIPT, buildGuardSettings } from './guard-script.js';

const BRANCH = 'TER-1-card';
const WORKTREE = '/home/u/.termhub/worktrees/p1/TER-1';

let dir: string;
let script: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'th-guard-'));
  script = join(dir, 'termhub-guard');
  writeFileSync(script, GUARD_SCRIPT);
  chmodSync(script, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The guard's decision for a tool call: 'deny' with the reason, or 'allow' when it printed nothing. */
function decide(tool: string, input: Record<string, unknown>, branch: string | null = BRANCH, worktree = WORKTREE): { deny: boolean; reason: string } {
  const event = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
  const r = spawnSync('sh', [script, branch ?? '', worktree], { input: JSON.stringify(event), env: { PATH: '/usr/bin:/bin', HOME: '/home/u' }, timeout: 5000 });
  if (r.error) throw r.error;
  expect(r.status, r.stderr?.toString()).toBe(0);
  const out = r.stdout.toString();
  const deny = out.includes('"permissionDecision":"deny"');
  const m = /"permissionDecisionReason":"([^"]*)"/.exec(out);
  return { deny, reason: m?.[1] ?? '' };
}

const bash = (command: string, branch: string | null = BRANCH, worktree = WORKTREE) => decide('Bash', { command }, branch, worktree);

describe('guard — git push (the auto-mode gap)', () => {
  it('allows the run\'s own branch, in each pre-allowed form', () => {
    expect(bash(`git push -u origin ${BRANCH}`).deny).toBe(false);
    expect(bash(`git push origin ${BRANCH}`).deny).toBe(false);
    expect(bash(`git push -u origin HEAD:refs/heads/${BRANCH}`).deny).toBe(false);
    expect(bash(`git   push   origin   ${BRANCH}`).deny).toBe(false); // extra spaces squashed
  });
  it('denies a push to any other ref or shape', () => {
    for (const c of [
      'git push origin main',
      'git push origin HEAD:main',
      `git push origin ${BRANCH}:main`,
      'git push --force origin ' + BRANCH,
      'git push -f origin ' + BRANCH,
      'git push --mirror origin',
      'git push', // no ref we can see
      `git push upstream ${BRANCH}`,
    ]) expect(bash(c).deny, c).toBe(true);
  });
  it('denies the run\'s push when the run has no branch', () => {
    expect(bash(`git push -u origin ${BRANCH}`, null).deny).toBe(true);
  });
});

describe('guard — blocked programs, each item of the hard lock', () => {
  const cases: Array<[string, string]> = [
    ['merge', 'gh pr merge 401 --merge'],
    ['workflow', 'gh workflow run "CI e Deploy" --ref main'],
    ['release', 'gh release create v1'],
    ['gh api', 'gh api repos/x/y'],
    ['gh secret', 'gh secret set X'],
    ['npm publish', 'npm publish'],
    ['pnpm publish', 'pnpm publish --no-git-checks'],
    ['npm run release', 'npm run release:ota -w @termhub/mobile'],
    ['eas', 'eas build --platform ios'],
    ['npx eas', 'npx eas update'],
    ['fastlane', 'fastlane ios release'],
    ['docker', 'docker ps'],
    ['docker compose', 'docker-compose up -d'],
    ['ssh', 'ssh jarvis uptime'],
    ['scp', 'scp a b:/c'],
    ['rsync', 'rsync -a a b:'],
    ['kubectl', 'kubectl get pods'],
    ['psql', 'psql -c "select 1"'],
  ];
  it.each(cases)('denies %s', (_label, command) => {
    expect(bash(command).deny, command).toBe(true);
  });
});

describe('guard — rm -rf', () => {
  it('allows rm -rf inside the worktree or /tmp', () => {
    expect(bash(`rm -rf ${WORKTREE}/node_modules`).deny).toBe(false);
    expect(bash('rm -rf /tmp/scratch').deny).toBe(false);
    expect(bash('rm -rf dist').deny).toBe(false); // relative to the worktree cwd
  });
  it('denies rm -rf reaching outside the worktree', () => {
    for (const c of ['rm -rf /', 'rm -rf /home/u', 'rm -rf ~/x', 'rm -rf $HOME/x', 'rm -rf ../other', `rm -rf ${WORKTREE}/../other`, 'rm -rf /etc/passwd']) {
      expect(bash(c).deny, c).toBe(true);
    }
  });
});

describe('guard — credential files', () => {
  it('denies reading a credential, however the command reaches it', () => {
    for (const c of ['cat .env', 'cat apps/server/.env.local', 'head ~/.npmrc', 'cat ~/.netrc', 'cat ~/.git-credentials', 'cat ~/.ssh/id_ed25519', 'cat ~/.termhub/config.json', 'cat ~/.claude/.credentials.json']) {
      expect(bash(c).deny, c).toBe(true);
    }
  });
  it('denies a file tool on a credential path', () => {
    expect(decide('Read', { file_path: `${WORKTREE}/.env` }).deny).toBe(true);
    expect(decide('Edit', { file_path: '/home/u/.npmrc' }).deny).toBe(true);
    expect(decide('Read', { file_path: '/home/u/.ssh/config' }).deny).toBe(true);
  });
});

describe('guard — writes outside the worktree', () => {
  it('allows reads anywhere non-secret and edits inside the worktree or /tmp', () => {
    expect(decide('Read', { file_path: '/etc/hosts' }).deny).toBe(false);
    expect(decide('Edit', { file_path: `${WORKTREE}/apps/web/src/x.ts` }).deny).toBe(false);
    expect(decide('Write', { file_path: 'apps/web/src/y.ts' }).deny).toBe(false); // relative = worktree
    expect(decide('Write', { file_path: '/tmp/out.txt' }).deny).toBe(false);
  });
  it('denies an edit or write outside the worktree', () => {
    expect(decide('Write', { file_path: '/home/u/other/x.ts' }).deny).toBe(true);
    expect(decide('Edit', { file_path: '/etc/hosts' }).deny).toBe(true);
    expect(decide('Write', { file_path: `${WORKTREE}/../escape.ts` }).deny).toBe(true);
  });
});

describe('guard — normal run, stays silent', () => {
  it('allows the everyday commands and tools', () => {
    for (const c of ['git status', 'git diff --stat', 'git log --oneline -5', 'git add -A', 'git commit -m "x"', 'npm test -w @termhub/server', 'npm run build -w @termhub/web', 'grep -rn foo apps/web/src', 'gh pr create --fill', 'gh pr checks 1', 'gh pr view 1', 'node scripts/x.mjs']) {
      expect(bash(c).deny, c).toBe(false);
    }
    expect(decide('Read', { file_path: `${WORKTREE}/README.md` }).deny).toBe(false);
    expect(decide('Bash', { command: 'ls -la' }).deny).toBe(false);
  });
  it('denies a Bash call whose command it cannot read', () => {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };
    const r = spawnSync('sh', [script, BRANCH, WORKTREE], { input: JSON.stringify(event), env: { PATH: '/usr/bin:/bin', HOME: '/home/u' }, timeout: 5000 });
    expect(r.stdout.toString()).toContain('"permissionDecision":"deny"');
  });
});

describe('buildGuardSettings', () => {
  it('registers the guard as a PreToolUse hook for every tool, with branch and worktree in argv', () => {
    const s = JSON.parse(buildGuardSettings(BRANCH, WORKTREE)) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; type: string }> }> } };
    const entry = s.hooks.PreToolUse[0]!;
    expect(entry.matcher).toBe('*');
    expect(entry.hooks[0]!.command).toBe(`"$HOME/.termhub/bin/termhub-guard" '${BRANCH}' '${WORKTREE}'`);
  });
  it('quotes a branch and worktree that hold odd characters, and an empty branch', () => {
    const cmd = (JSON.parse(buildGuardSettings(null, "/w/it's")) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }).hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(cmd).toBe(`"$HOME/.termhub/bin/termhub-guard" '' '/w/it'\\''s'`);
  });
});
