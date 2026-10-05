import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../scripts/automation/rename-migrations.mjs');
const MIG = 'apps/server/prisma/migrations';
let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const addMigration = (cwd: string, name: string) => {
  mkdirSync(join(cwd, MIG, name), { recursive: true });
  writeFileSync(join(cwd, MIG, name, 'migration.sql'), `-- ${name}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', `add ${name}`);
};
const run = (cwd: string, ...args: string[]) => {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    const err = e as { status: number; stderr: string };
    return { code: err.status, out: err.stderr };
  }
};

/** A remote with main, plus a clone on branch `epic` forked before main moved. */
function setup(name: string, epicMig: string, mainMig: string) {
  const origin = join(root, `${name}-origin.git`);
  const work = join(root, name);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-qb', 'main');
  addMigration(work, '20261001000000_init');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-qb', 'epic');
  addMigration(work, epicMig);
  git(work, 'checkout', '-q', 'main');
  addMigration(work, mainMig);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', 'epic');
  git(work, 'fetch', '-q', 'origin');
  return work;
}
const names = (cwd: string) => readdirSync(join(cwd, MIG)).sort();

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'th-playbook-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('integrator playbook: rename-migrations', () => {
  it('renames the epic migration after the newest on the base, and the merge completes', () => {
    const w = setup('a', '20261009120000_b', '20261010120000_a');
    const r = run(w, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('20261009120000_b -> 20261010120001_b');
    expect(names(w)).toEqual(['20261001000000_init', '20261010120001_b']);
    git(w, 'commit', '-qam', 'rename');
    git(w, 'merge', '--no-edit', 'origin/main');
    const after = names(w);
    expect(after).toEqual(['20261001000000_init', '20261010120000_a', '20261010120001_b']);
    expect(existsSync(join(w, MIG, '20261009120000_b'))).toBe(false);
    expect(git(w, 'status', '--porcelain')).toBe('');
  });

  it('keeps the order of several epic migrations and leaves later ones alone', () => {
    const w = setup('c', '20261009120000_b', '20261010120000_a');
    addMigration(w, '20261009130000_c');
    addMigration(w, '20261011000000_d');
    expect(run(w, 'main').code).toBe(0);
    expect(names(w)).toEqual(['20261001000000_init', '20261010120001_b', '20261010120002_c', '20261011000000_d']);
  });

  it('does nothing when the epic migrations are already after the base', () => {
    const w = setup('d', '20261012000000_b', '20261010120000_a');
    const r = run(w, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('nothing to rename');
    expect(names(w)).toContain('20261012000000_b');
  });

  it('refuses to rename a migration that exists on the base', () => {
    const w = setup('e', '20261009120000_b', '20261010120000_a');
    // The epic already merged main, so the base migration is present locally.
    git(w, 'merge', '--no-edit', 'origin/main');
    const r = run(w, 'main', '20261010120000_a');
    expect(r.code).toBe(1);
    expect(r.out).toContain('exist on the base branch');
    expect(names(w)).toContain('20261010120000_a');
  });

  it('never touches base migrations when none are named, even older than the newest', () => {
    const w = setup('f', '20261009120000_b', '20261010120000_a');
    git(w, 'merge', '--no-edit', 'origin/main');
    expect(run(w, 'main').code).toBe(0);
    expect(names(w)).toEqual(['20261001000000_init', '20261010120000_a', '20261010120001_b']);
  });
});
