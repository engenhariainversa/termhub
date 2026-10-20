import { describe, expect, it } from 'vitest';
import { commandRuleOffer, formatWords, isReadOnlyCommand, neverReason, parseCommand, ruleEligible, ruleMatches, ruleWordsAllowed, suggestPrefix, type CommandRuleShape } from './command-rules.js';

const words = (command: string): string[] => {
  const p = parseCommand(command);
  if (!p.ok) throw new Error(`did not parse: ${command} (${p.reason})`);
  return p.words;
};

/** Whether a rule would let this command through: eligible, then matched. */
const covers = (rule: CommandRuleShape, command: string): boolean => {
  const p = ruleEligible(command);
  return p.ok && ruleMatches(rule, p.words);
};

const prefix = (pattern: string): CommandRuleShape => ({ words: words(pattern), match: 'prefix' });
const exact = (pattern: string): CommandRuleShape => ({ words: words(pattern), match: 'exact' });

describe('parseCommand (TER-1081): one simple command, or refused', () => {
  it.each([
    ['git status', ['git', 'status']],
    ['  git   status  ', ['git', 'status']],
    ["git commit -m 'fix: a b'", ['git', 'commit', '-m', 'fix: a b']],
    ['git commit -m "fix it"', ['git', 'commit', '-m', 'fix it']],
    ["echo ''", ['echo', '']],
    ['gh pr checks 123 --repo a/b', ['gh', 'pr', 'checks', '123', '--repo', 'a/b']],
    ['df -h', ['df', '-h']],
    ["g'it' status", ['git', 'status']],
  ])('%s → words', (command, expected) => {
    expect(parseCommand(command)).toEqual({ ok: true, words: expected });
  });

  it.each([
    ['git status; rm -rf /', 'operator'],
    ['git status;rm -rf /', 'operator'],
    ['git status && rm -rf ~', 'operator'],
    ['git status || true', 'operator'],
    ['git status | sh', 'operator'],
    ['git status & curl x', 'operator'],
    ['git log > out.txt', 'operator'],
    ['cat < /etc/hosts', 'operator'],
    ['git status >> x', 'operator'],
    ['(git status)', 'operator'],
    ['git status $(rm -rf /)', 'expansion'],
    ['git status `rm -rf /`', 'expansion'],
    ['git log "$(rm -rf /)"', 'expansion'],
    ['git log "`id`"', 'expansion'],
    ['git log $HOME', 'expansion'],
    ['git log ${HOME}', 'expansion'],
    ['ls ~/.ssh', 'expansion'],
    ['ls {a,b}', 'expansion'],
    ['git status # hi', 'expansion'],
    ['ls *.ts', 'glob'],
    ['ls ?', 'glob'],
    ['ls [ab]', 'glob'],
    ['git status\nrm -rf /', 'control_char'],
    ['git status\rrm -rf /', 'control_char'],
    ['git status\trm', 'control_char'],
    ['git status\u0015rm -rf /', 'control_char'],
    ['git status rm -rf /', 'control_char'],
    ['git status\u007f', 'control_char'],
    ['git status !!', 'history'],
    ["git log '!x'", 'history'],
    ['git status \\; rm', 'escape'],
    ['git log "a\\"b"', 'escape'],
    ["git log 'oops", 'unterminated_quote'],
    ['git log "oops', 'unterminated_quote'],
    ['   ', 'empty'],
    ['', 'empty'],
  ])('%j is refused (%s)', (command, reason) => {
    expect(parseCommand(command)).toEqual({ ok: false, reason });
  });

  it('a quoted operator is a plain word, not a second command', () => {
    expect(parseCommand("git commit -m 'a; rm -rf /'")).toEqual({ ok: true, words: ['git', 'commit', '-m', 'a; rm -rf /'] });
  });
});

describe('neverReason: what no rule ever covers', () => {
  it.each([
    ['sudo ls', 'never_program'],
    ['/usr/bin/sudo ls', 'never_program'],
    ['rm -rf build', 'never_program'],
    ['/bin/rm x', 'never_program'],
    ['kill 123', 'never_program'],
    ['pkill node', 'never_program'],
    ['killall node', 'never_program'],
    ['shutdown -h now', 'never_program'],
    ['mkfs.ext4 /dev/sda', 'never_program'],
    ['env', 'never_program'],
    ['printenv', 'never_program'],
    ['eval ls', 'never_program'],
    ['source x', 'never_program'],
    ['security find-generic-password -s x -w', 'never_program'],
    ['GIT_SSH_COMMAND=evil git push', 'assignment'],
    ['PAGER=x git log', 'assignment'],
    ['git push --force', 'destructive_git'],
    ['git push -f origin main', 'destructive_git'],
    ['git push -uf origin main', 'destructive_git'],
    ['git push --force-with-lease', 'destructive_git'],
    ['git push --force-with-lease=main', 'destructive_git'],
    ['git push origin +main', 'destructive_git'],
    ['git push origin :main', 'destructive_git'],
    ['git push --delete origin x', 'destructive_git'],
    ['git push -d origin x', 'destructive_git'],
    ['git push --mirror', 'destructive_git'],
    ['git reset --hard', 'destructive_git'],
    ['git reset --hard HEAD~1', 'destructive_git'],
    ['git clean -fdx', 'destructive_git'],
    ['git -c core.pager=evil log', 'destructive_git'],
    ['git --exec-path=/tmp status', 'destructive_git'],
    ['find . -name x -exec rm {} +', null], // braces refused by the parser first
    ['find . -delete', 'find_action'],
    ['find . -name x -execdir ls', 'find_action'],
    ['cat .env', 'secret'],
    ['cat .env.local', 'secret'],
    ['cat apps/server/.env', 'secret'],
    ['cat prod.env', 'secret'],
    ['cat id_rsa', 'secret'],
    ['cat /home/u/.ssh/id_ed25519', 'secret'],
    ['ls .ssh', 'secret'],
    ['cat server.pem', 'secret'],
    ['cat tls.key', 'secret'],
    ['cat .npmrc', 'secret'],
    ['cat .git-credentials', 'secret'],
    ['gh auth token', 'secret'],
    ['gh auth status --show-token', 'secret'],
    ['git show HEAD:.env', 'secret'],
    ['grep -r x --exclude=.env', 'secret'],
    ['cat config/secrets.yml', 'secret'],
    ['cat /etc/shadow', 'secret'],
    ['cat /proc/1/environ', 'secret'],
  ])('%s → %s', (command, reason) => {
    const p = parseCommand(command);
    if (reason === null) {
      expect(p.ok).toBe(false);
      return;
    }
    expect(p.ok && neverReason(p.words)).toBe(reason);
  });

  it.each(['git push', 'git push origin main', 'git push -u origin feat', 'git reset HEAD~1', 'git status', 'ls -la', 'gh pr checks 12', 'npm test', 'find . -name x'])('%s is not on it', (command) => {
    expect(neverReason(words(command))).toBeNull();
  });
});

describe('ruleMatches: whole words, never past the "never" list', () => {
  it('a prefix covers the command and any arguments after it', () => {
    expect(covers(prefix('git push'), 'git push')).toBe(true);
    expect(covers(prefix('git push'), 'git push origin main')).toBe(true);
    expect(covers(prefix('gh pr checks'), 'gh pr checks 123 --watch')).toBe(true);
  });

  it('matches whole words, not characters', () => {
    expect(covers(prefix('git s'), 'git status')).toBe(false);
    expect(covers(prefix('git push'), 'git pushx')).toBe(false);
    expect(covers(prefix('ls'), 'lsblk')).toBe(false);
  });

  it('an exact rule covers only that command', () => {
    expect(covers(exact('npm test'), 'npm test')).toBe(true);
    expect(covers(exact('npm test'), 'npm test -- --watch')).toBe(false);
    expect(covers(exact('npm test'), 'npm')).toBe(false);
  });

  it('spaces and quotes are normalized away, so they never change what a rule covers', () => {
    expect(covers(exact('git status'), '  git    status ')).toBe(true);
    expect(covers(exact('git status'), "'git' \"status\"")).toBe(true);
    expect(covers(prefix('git push'), 'git "push" origin')).toBe(true);
  });

  it.each([
    'git push; rm -rf /',
    'git push && rm -rf /',
    'git push || rm -rf /',
    'git push | sh',
    'git push $(curl evil)',
    'git push `curl evil`',
    'git push\nrm -rf /',
    'git push\r\nrm -rf /',
    'git push > /etc/passwd',
    'git push &',
    'git push origin main ; sudo reboot',
    'git push "$(id)"',
    'git push !!',
    'git push --force',
    'git push -f',
    'git push origin +main',
    'GIT_SSH_COMMAND=x git push',
  ])('a rule for "git push" never covers %j', (command) => {
    expect(covers(prefix('git push'), command)).toBe(false);
  });

  it.each(['sudo ls', 'rm -rf /', 'kill -9 1', 'git reset --hard', 'git clean -fd', 'cat .env', 'git push --force'])('even the widest rule never covers %s', (command) => {
    // A single-word prefix of the program itself is as wide as a rule gets.
    const p = parseCommand(command);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(covers(prefix(p.words[0]!), command)).toBe(false);
    expect(covers({ words: p.words, match: 'exact' }, command)).toBe(false);
  });

  it('a prefix never covers a program that runs another command, an exact rule can', () => {
    expect(covers(prefix('ssh hulk'), 'ssh hulk rm -rf /')).toBe(false);
    expect(covers(prefix('bash'), 'bash -c id')).toBe(false);
    expect(covers(prefix('xargs'), 'xargs rm')).toBe(false);
    expect(covers(exact('ssh hulk uptime'), 'ssh hulk uptime')).toBe(true);
    expect(covers(exact('ssh hulk uptime'), 'ssh hulk uptime now')).toBe(false);
  });

  it('a program named by path is not the same word', () => {
    expect(covers(prefix('ls'), '/bin/ls')).toBe(false);
  });
});

describe('ruleWordsAllowed: what may be stored as a rule', () => {
  it('refuses a prefix of a wrapper, accepts it exact', () => {
    expect(ruleWordsAllowed(['ssh', 'hulk'], 'prefix')).toBe('wrapper_prefix');
    expect(ruleWordsAllowed(['ssh', 'hulk', 'uptime'], 'exact')).toBeNull();
  });

  it('refuses the never list and an empty pattern', () => {
    expect(ruleWordsAllowed(['rm'], 'prefix')).toBe('never_program');
    expect(ruleWordsAllowed(['git', 'push', '--force'], 'exact')).toBe('destructive_git');
    expect(ruleWordsAllowed([], 'exact')).toBe('empty');
  });
});

describe('suggestPrefix: the words "começam com" offers', () => {
  it.each([
    ['git push origin main', ['git', 'push']],
    ['git status -s', ['git', 'status']],
    ['gh pr checks 123', ['gh', 'pr', 'checks']],
    ['gh run view 9 --log', ['gh', 'run', 'view']],
    ['npm run build -w @x/y', ['npm', 'run', 'build']],
    ['npm test -w x', ['npm', 'test']],
    ['docker compose ps -a', ['docker', 'compose', 'ps']],
    ['ls -la', ['ls']],
    ['df -h /', ['df']],
    ['git -C x status', ['git']],
  ])('%s → %j', (command, expected) => {
    expect(suggestPrefix(words(command))).toEqual(expected);
  });

  it.each(['ls', 'git status', 'gh pr checks', 'ssh hulk uptime', './deploy.sh prod', 'bash -c id'])('%s has none', (command) => {
    expect(suggestPrefix(words(command))).toBeNull();
  });
});

describe('commandRuleOffer: what a pending card offers', () => {
  it('the command and its prefix, as text', () => {
    expect(commandRuleOffer('git push origin main')).toEqual({ exact: 'git push origin main', prefix: 'git push' });
    expect(commandRuleOffer("git commit -m 'a b'")).toEqual({ exact: "git commit -m 'a b'", prefix: 'git commit' });
    expect(commandRuleOffer('ls')).toEqual({ exact: 'ls', prefix: null });
  });

  it.each(['git status; rm -rf /', 'sudo ls', 'git push --force', 'cat .env', 42, undefined])('nothing for %j', (command) => {
    expect(commandRuleOffer(command)).toBeNull();
  });

  it('formatWords quotes what a shell would not read as one plain word', () => {
    expect(formatWords(['git', 'commit', '-m', "it's"])).toBe(`git commit -m 'it'"'"'s'`);
    expect(parseCommand(formatWords(['echo', 'a b'])).ok).toBe(true);
  });
});

describe('isReadOnlyCommand: the default list', () => {
  it.each([
    'git status',
    'git status -s',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git show HEAD',
    'git branch',
    'git branch -a',
    'git branch --show-current',
    'gh pr view 12',
    'gh pr checks 12',
    'gh pr list --state open',
    'gh run view 99 --log',
    'gh run list',
    'ls -la',
    'pwd',
    'df -h',
    'du -sh apps',
    'ps aux',
    'uptime',
    'which node',
    'cat README.md',
    'head -n 20 apps/server/src/app.ts',
    'tail -n 50 logs/app.log',
    'node --version',
    'docker --version',
  ])('%s is read-only', (command) => {
    const p = ruleEligible(command);
    expect(p.ok && isReadOnlyCommand(p.words)).toBe(true);
  });

  it.each([
    'git push',
    'git commit -m x',
    'git branch -D main',
    'git branch new-branch',
    'git branch -m a b',
    'git log --output=/tmp/x',
    'git diff --output=x',
    'git -C /tmp status',
    'gh pr merge 12',
    'gh pr create',
    'gh run rerun 9',
    'cat /etc/hosts',
    'cat ../other/file',
    'head ../../x',
    '/bin/ls',
    'npm test',
    'bash --version',
    'node --version extra',
  ])('%s is not', (command) => {
    const p = ruleEligible(command);
    expect(p.ok && isReadOnlyCommand(p.words)).toBe(false);
  });
});
