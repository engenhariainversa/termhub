/**
 * Runs the real guard script under `sh`, as Claude Code runs a PreToolUse hook: the event JSON on
 * stdin, the run's branch as $1 and its worktree as $2. A denial is printed on stdout as Claude Code's
 * `permissionDecision: "deny"`; an allow prints nothing. Each blocked item of the hard lock (TER-993)
 * has its own case here, and the normal-run cases prove the guard stays silent on them.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUARD_SCRIPT, GUARD_SCRIPT_VERSION, buildGuardSettings } from './guard-script.js';

const BRANCH = 'TER-1-card';
const WORKTREE = '/home/u/.termhub/worktrees/p1/TER-1';

let dir: string;
let script: string;
/** A folder put first on the guard's PATH, holding an `awk` other than the system's (see the TER-1111 cases). */
let awkDir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'th-guard-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  script = join(dir, 'termhub-guard');
  writeFileSync(script, GUARD_SCRIPT);
  chmodSync(script, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The guard's decision for a tool call: 'deny' with the reason, or 'allow' when it printed nothing. */
function decide(tool: string, input: Record<string, unknown>, branch: string | null = BRANCH, worktree = WORKTREE): { deny: boolean; reason: string } {
  const event = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
  const r = spawnSync('sh', [script, branch ?? '', worktree], { input: JSON.stringify(event), env: { PATH: `${awkDir ? `${awkDir}:` : ''}/usr/bin:/bin`, HOME: '/home/u' }, timeout: 5000 });
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

describe('guard v2 — push from a repo folder of the workspace (spec 2026-10-07 multi-repo R13)', () => {
  it('is now version 3 (TER-1111)', () => {
    expect(GUARD_SCRIPT_VERSION).toBe(3);
    expect(GUARD_SCRIPT).toContain('# termhub-guard v3\n');
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

/** The awks the guard may meet: the system's, plus mawk, gawk, BWK and busybox when this host has them. */
const AWKS: Array<[string, string]> = [
  ['system awk', ''],
  ...([['mawk', '/usr/bin/mawk'], ['gawk', '/usr/bin/gawk'], ['bwk awk', '/usr/bin/original-awk'], ['busybox awk', '/usr/bin/busybox'], ['busybox awk', '/bin/busybox']] as Array<[string, string]>).filter(([, p]) => existsSync(p)),
].filter(([label], i, all) => all.findIndex(([l]) => l === label) === i);

describe.each(AWKS)('guard v3 — the whole command is read (TER-1111), with %s', (_label, bin) => {
  beforeEach(() => {
    if (!bin) return;
    awkDir = join(dir, 'awk-bin');
    mkdirSync(awkDir, { recursive: true });
    symlinkSync(bin, join(awkDir, 'awk')); // busybox picks its applet from the name
  });
  afterEach(() => { awkDir = ''; });

  it('denies a push to another ref, docker or gh pr merge hidden after a quote', () => {
    for (const c of [
      'git commit -m "fix" && git push origin main',
      'echo "x" && git push origin main',
      `git commit -m "a \\"quoted\\" message" && git push --force origin ${BRANCH}`,
      'echo "x" && docker ps',
      'git commit -m "x"; docker compose up -d',
      "echo 'x' && gh pr merge 1 --squash",
      'echo "x" && npm publish',
      'git log --format="%h" && ssh jarvis uptime',
    ]) expect(bash(c).deny, c).toBe(true);
  });
  it('reads every simple command: newlines, glued operators, $( ), backticks, subshells, sh -c and eval', () => {
    for (const c of [
      'echo x\ndocker ps',
      'echo x;docker ps',
      'true&&docker ps',
      'echo $(docker ps)',
      'echo "$(gh pr merge 1)"',
      'echo `docker ps`',
      '(docker ps)',
      'cat <(docker ps)',
      'sh -c "docker ps"',
      "bash -lc 'gh pr merge 1'",
      'eval "docker ps"',
      'cat <<EOF\n$(docker ps)\nEOF',
      '/usr/bin/docker ps',
      'sudo docker ps',
    ]) expect(bash(c).deny, c).toBe(true);
  });
  it('leaves quoted text, comments and quoted heredocs alone: they are data', () => {
    for (const c of [
      'git commit -m "Guard: deny docker, ssh and gh pr merge after a quote"',
      'git commit -m "fix the push rule"',
      `gh pr create --title "Guard v3" --body "$(cat <<'EOF'\nRun docker run --rm node:22 first.\ngit push origin main is denied.\nEOF\n)"`,
      'cat <<\'EOF\' > /tmp/x.md\ndocker ps\n$(docker ps)\nEOF',
      'npm test # not docker',
      'grep -rn "process.env.DATABASE_URL" apps/server/src',
      'echo "a;b && c | d"',
    ]) expect(bash(c).deny, c).toBe(false);
  });
  it('allows the run\'s push as the last command, with -q, 2>&1 and | tail -N', () => {
    for (const c of [
      `git add -A && git commit -m "x \\"y\\"" && git push -u origin ${BRANCH}`,
      `git commit -m "fix push" && git push -u origin ${BRANCH}`,
      `git push -u origin ${BRANCH} 2>&1 | tail -5`,
      `git push -u origin ${BRANCH} 2>&1 | tail -n 20`,
      `git push -q origin ${BRANCH}`,
      `git push -u origin ${BRANCH} -q 2>&1 | tail -3`,
      `git push --quiet origin HEAD:refs/heads/${BRANCH}`,
      `npm test; git push -u origin ${BRANCH}`,
      `cd ${WORKTREE} && git push -u origin ${BRANCH}`,
      `git -C ${WORKTREE}/frontend push -u origin ${BRANCH} 2>&1 | tail -5`,
      `cd ${WORKTREE}/frontend && git push -u origin ${BRANCH}`,
    ]) expect(bash(c).deny, c).toBe(false);
  });
  it('denies a push chained in the middle, piped elsewhere, nested or steered', () => {
    for (const c of [
      `git push -u origin ${BRANCH} && echo done`,
      `git push -u origin ${BRANCH}; git push origin main`,
      `git push -u origin ${BRANCH} | tee push.log`,
      `git push -u origin ${BRANCH} 2>&1 | tail -5 && echo ok`,
      `git push -u origin ${BRANCH} 2>&1 | tail -5 | cat`,
      `git push -u origin ${BRANCH} >/dev/null`,
      `cd /home/u/other && git push -u origin ${BRANCH}`,
      `cd .. && git push -u origin ${BRANCH}`,
      `GIT_DIR=/home/u/other/.git git push -u origin ${BRANCH}`,
      `export GIT_WORK_TREE=/x; git push -u origin ${BRANCH}`,
      `(git push -u origin ${BRANCH})`,
      `echo $(git push -u origin ${BRANCH})`,
      `sh -c "git push -u origin ${BRANCH}"`,
      `git push -u origin $(echo ${BRANCH})`,
      `git -C ${WORKTREE} push -u origin ${BRANCH}`,
      `git --no-pager push -u origin ${BRANCH}`,
      'git push -q',
      'xargs git push origin main',
    ]) expect(bash(c).deny, c).toBe(true);
  });
  it('denies git aliases, which can hide a push', () => {
    for (const c of ['git -c alias.p=push p origin main', 'git config alias.p push', 'git -calias.x=push x']) expect(bash(c).deny, c).toBe(true);
  });
  it('says which push form it takes', () => {
    const r = bash('git commit -m "x" && git push origin main');
    expect(r.reason).toContain(`git push -u origin ${BRANCH}`);
    expect(r.reason).toContain('ultimo comando');
    expect(bash('git push origin x', null).reason).toContain('nao tem branch');
  });
  it('denies what it cannot read: an open quote, ANSI-C quoting, a \\u escape that is not a control character', () => {
    for (const c of ['echo "x', "echo 'x", "$'\\x64ocker' ps", 'echo $(docker ps']) expect(bash(c).deny, c).toBe(true);
    const raw = (json: string) => spawnSync('sh', [script, BRANCH, WORKTREE], { input: json, env: { PATH: `${awkDir ? `${awkDir}:` : ''}/usr/bin:/bin`, HOME: '/home/u' }, timeout: 5000 }).stdout.toString();
    expect(raw('{"tool_name":"Bash","tool_input":{"command":"\\u0064ocker ps"}}')).toContain('"permissionDecision":"deny"');
    expect(raw('{"tool_name":"Bash","tool_input":{"command":"echo x\\u000adocker ps"}}')).toContain('"permissionDecision":"deny"');
    expect(raw('{"tool_name":"Bash","tool_input":{"command":"ls -la\\u0009x"}}')).toBe('');
    expect(raw('{"tool_name":"Bash","tool_input":{"description":"run \\"command\\"","command":"docker ps"}}')).toContain('"permissionDecision":"deny"');
  });
  it('denies rm -r after a cd out of the worktree, and on a path it cannot pin', () => {
    for (const c of ['cd / && rm -rf usr', 'cd && rm -rf x', 'rm -rf "$HOME"', 'rm -rf ${HOME}/x', 'echo "x" && rm -rf /home/u']) expect(bash(c).deny, c).toBe(true);
    expect(bash(`cd ${WORKTREE}/apps/web && rm -rf dist`).deny).toBe(false);
  });
  it('finds a credential in a quoted path', () => {
    for (const c of ['cat "$HOME/.ssh/id_ed25519"', 'echo "x" && cat .env', "cat 'apps/server/.env.local'"]) expect(bash(c).deny, c).toBe(true);
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

describe('guard — reports a block to termhub (TER-993)', () => {
  it('posts the tool and reason (never the command) to /guard, in the background', () => {
    // fake curl + tmux on PATH; curl writes its POST body to a log
    const bin = join(dir, 'bin');
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho th-sess\n');
    const log = join(dir, 'curl.log');
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\n# the body is the last arg via --data-binary @-; read stdin\ncat >> ${log}\necho >> ${log}\n`);
    for (const f of ['tmux', 'curl']) chmodSync(join(bin, f), 0o755);
    mkdirSync(join(dir, '.termhub'), { recursive: true });
    writeFileSync(join(dir, '.termhub/hook.env'), "TERMHUB_HOOK_URL='https://app.termhub.dev/api/hooks/events'\nTERMHUB_HOOK_TOKEN='thb_hk_x'\n");
    const r = spawnSync('sh', [script, BRANCH, WORKTREE], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'docker ps' } }),
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TMUX_PANE: '%1' },
      timeout: 5000,
    });
    expect(r.stdout.toString()).toContain('"permissionDecision":"deny"');
    // the background POST may land just after exit; give it a beat
    const until = Date.now() + 2000;
    let body = '';
    while (Date.now() < until) {
      try { body = readFileSync(log, 'utf8'); } catch { body = ''; }
      if (body.includes('/guard') || body.includes('docker')) break;
    }
    try { body = readFileSync(log, 'utf8'); } catch { body = ''; }
    expect(body).toContain('"session":"th-sess"');
    expect(body).toContain('"tool":"Bash"');
    expect(body).not.toContain('docker ps'); // the command never leaves the machine
  });
});

