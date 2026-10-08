import { describe, expect, it } from 'vitest';
import { ELLIPSIS, HINT_MAX, REDACTED, commandHint, fileHint, hintMarkers, permissionHint, redactSecrets } from './permission-hint.js';

describe('redactSecrets', () => {
  it.each([
    ['export TOKEN=abc123', `export TOKEN=${REDACTED}`],
    ['GITHUB_TOKEN="a b c" gh pr list', `GITHUB_TOKEN=${REDACTED} gh pr list`],
    ["DB_PASS='x' npm test", `DB_PASS=${REDACTED} npm test`],
    ['export OPENAI_API_KEY=sk-abc', `export OPENAI_API_KEY=${REDACTED}`],
    ['AWS_SECRET_ACCESS_KEY=abc aws s3 ls', `AWS_SECRET_ACCESS_KEY=${REDACTED} aws s3 ls`],
    ['export TOKEN="unterminated', `export TOKEN=${REDACTED}`],
    ["curl -H 'Authorization: Bearer abc.def' https://x.test", `curl -H 'Authorization: ${REDACTED}' https://x.test`],
    ['curl -H "Cookie: sid=1; a=2" x', `curl -H "Cookie: ${REDACTED}" x`],
    ['curl -u admin:hunter2 https://x.test', `curl -u admin:${REDACTED} https://x.test`],
    ['git clone https://user:p4ss@github.com/o/r.git', `git clone https://user:${REDACTED}@github.com/o/r.git`],
    ['curl "https://x.test/v1?api_key=abc&page=2"', `curl "https://x.test/v1?api_key=${REDACTED}&page=2"`],
    ['tool --token abc --verbose', `tool --token ${REDACTED} --verbose`],
    ['tool --password=abc', `tool --password=${REDACTED}`],
    ['tool --client-secret "a b"', `tool --client-secret ${REDACTED}`],
    ['sshpass -p hunter2 ssh host', `sshpass -p ${REDACTED} ssh host`],
    ['mysql -u root -phunter2 db', `mysql -u root -p${REDACTED} db`],
    [`echo '{"password": "x1", "user": "a"}'`, `echo '{"password": ${REDACTED}, "user": "a"}'`],
    ['gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123', `gh auth login --with-token ${REDACTED}`],
    ['echo ghp_abcdefghijklmnopqrstuvwxyz0123 > f', `echo ${REDACTED} > f`],
    ['echo sk-ant-api03-abcdefghijklmnop', `echo ${REDACTED}`],
    ['aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP', `aws configure set aws_access_key_id ${REDACTED}`],
    ['echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh', `echo ${REDACTED}`],
    ['echo thb_hk_abc-123xyz', `echo ${REDACTED}`],
    ['echo a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8', `echo ${REDACTED}`],
    ['echo -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk', `echo ${REDACTED}`],
  ])('%s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    'npm run build -w @termhub/web',
    'NODE_ENV=test npx vitest run src/chat',
    'git status && git diff --stat',
    'ls -la /home/pedro/projects/termhub/apps/server/src/components',
    'mkdir -p "relatórios de ação"',
    'docker run --rm -v "$PWD:/w" node:22 npm test',
    'some-very-long-package-name-without-digits-at-all',
  ])('leaves an ordinary command alone: %s', (command) => {
    expect(redactSecrets(command)).toBe(command);
  });
});

describe('commandHint', () => {
  it('is the first line, whole when it fits', () => {
    expect(commandHint('npm test')).toBe('npm test');
  });

  it("stops at a heredoc's first line: the body never travels", () => {
    expect(commandHint("cat <<'EOF' > .env\nTOKEN=abc\nPASSWORD=x\nEOF")).toBe(`cat <<'EOF' > .env${ELLIPSIS}`);
  });

  it('skips leading blank lines and marks the lines after', () => {
    expect(commandHint('\n\n  git add -A\ngit commit -m x')).toBe(`git add -A${ELLIPSIS}`);
  });

  it(`cuts at ${HINT_MAX} code points, after redacting, never splitting an accent or an emoji`, () => {
    const long = `echo ${'ação '.repeat(20)}`;
    const hint = commandHint(long)!;
    expect(Array.from(hint)).toHaveLength(HINT_MAX + 1);
    expect(hint.endsWith(ELLIPSIS)).toBe(true);
    expect(hint).toContain('ação');
    expect(commandHint(`echo ${'x'.repeat(HINT_MAX - 6)}🙂🙂`)).toBe(`echo ${'x'.repeat(HINT_MAX - 6)}🙂${ELLIPSIS}`);
  });

  it('recognises a secret that straddles the cut', () => {
    const hint = commandHint(`${'x'.repeat(50)} ghp_abcdefghijklmnopqrstuvwxyz0123`)!;
    expect(hint).not.toContain('ghp_');
    expect(hint).toContain(REDACTED);
  });

  it('keeps accents, NFC, and drops controls and bidi characters', () => {
    expect(commandHint('echo "café" \u001b[31mred‮')).toBe('echo "café" [31mred');
    expect(commandHint('a\tb')).toBe('a b');
  });

  it('is null for a blank command', () => {
    expect(commandHint(' \n\t\n')).toBeNull();
  });
});

describe('fileHint', () => {
  it("is relative to the session's directory, as the dialog names it", () => {
    expect(fileHint('/home/dev/app/src/ação.ts', '/home/dev/app')).toBe('src/ação.ts');
    expect(fileHint('/home/dev/app/src/a.ts', '/home/dev/app/')).toBe('src/a.ts');
  });

  it('stays absolute outside it, or without one, and never matches a sibling prefix', () => {
    expect(fileHint('/etc/hosts', '/home/dev/app')).toBe('/etc/hosts');
    expect(fileHint('/home/dev/app2/a.ts', '/home/dev/app')).toBe('/home/dev/app2/a.ts');
    expect(fileHint('/x/a.ts', null)).toBe('/x/a.ts');
  });

  it('keeps the tail of a long path, where the name is', () => {
    const hint = fileHint(`/${'d/'.repeat(60)}name.ts`, null)!;
    expect(hint.startsWith(ELLIPSIS)).toBe(true);
    expect(hint.endsWith('/name.ts')).toBe(true);
    expect(Array.from(hint)).toHaveLength(HINT_MAX);
  });
});

describe('permissionHint', () => {
  it('reads the command of Bash and the file of the file tools', () => {
    expect(permissionHint('Bash', { command: 'npm test', description: 'd' }, '/w')).toBe('npm test');
    expect(permissionHint('Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }, '/w')).toBe('a.ts');
    expect(permissionHint('Write', { file_path: '/w/b.ts', content: 'TOKEN=1' }, '/w')).toBe('b.ts');
    expect(permissionHint('MultiEdit', { file_path: '/w/c.ts', edits: [] }, '/w')).toBe('c.ts');
    expect(permissionHint('NotebookEdit', { notebook_path: '/w/n.ipynb' }, '/w')).toBe('n.ipynb');
  });

  it('is null for any other tool or a malformed input', () => {
    expect(permissionHint('WebFetch', { url: 'https://x.test' }, '/w')).toBeNull();
    expect(permissionHint('Bash', { command: 3 }, '/w')).toBeNull();
    expect(permissionHint('Bash', 'npm test', '/w')).toBeNull();
    expect(permissionHint('Bash', ['npm test'], '/w')).toBeNull();
    expect(permissionHint('Edit', {}, '/w')).toBeNull();
  });
});

describe('hintMarkers', () => {
  it("is a file's last segment", () => {
    expect(hintMarkers('Edit', 'src/ação.ts')).toEqual(['ação.ts']);
    expect(hintMarkers('Write', `${ELLIPSIS}d/name.ts`)).toEqual(['name.ts']);
  });

  it("is a command's runs between redactions and cuts", () => {
    expect(hintMarkers('Bash', `export TOKEN=${REDACTED} && npm ${ELLIPSIS}`)).toEqual(['export TOKEN=', ' && npm ']);
    expect(hintMarkers('Bash', 'npm test')).toEqual(['npm test']);
  });
});
