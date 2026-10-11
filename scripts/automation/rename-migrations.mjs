#!/usr/bin/env node
// Renames the epic's own new Prisma migrations so they sort after the newest migration on the base branch.
// Usage: node scripts/automation/rename-migrations.mjs <base> [folder...]
// Only folders that do NOT exist on origin/<base> are ever renamed: a migration on the base is applied in
// production and must never change. Naming a folder that is on the base is refused (exit 1).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = 'apps/server/prisma/migrations';
const NAME = /^(\d{14})_(.+)$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const ok = (...args) => {
  try { git(...args); return true; } catch { return false; }
};

/** The base ref to compare against: origin/<base> when it exists, else the local branch. */
export function baseRef(base) {
  for (const ref of [`origin/${base}`, base]) if (ok('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) return ref;
  throw new Error(`base branch not found: ${base}`);
}

const stamp = (ts) => {
  const d = new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14)));
  return d;
};
const format = (d) => d.toISOString().replace(/\D/g, '').slice(0, 14);
const plusSecond = (ts) => format(new Date(stamp(ts).getTime() + 1000));

/** Pure planner: which of `local` must be renamed, and to what. `onBase` are the folders already on the base. */
export function plan(onBase, local, only = null) {
  const baseSet = new Set(onBase);
  const refused = (only ?? []).filter((n) => baseSet.has(n));
  if (refused.length) throw new Error(`refusing to rename migrations that exist on the base branch: ${refused.join(', ')}`);
  let cursor = onBase.map((n) => NAME.exec(n)?.[1]).filter(Boolean).sort().pop() ?? '00000000000000';
  const moves = [];
  const mine = local.filter((n) => !baseSet.has(n) && NAME.test(n) && (!only || only.includes(n))).sort();
  for (const name of mine) {
    const [, ts, rest] = NAME.exec(name);
    if (ts > cursor) { cursor = ts; continue; }
    cursor = plusSecond(cursor);
    moves.push({ from: name, to: `${cursor}_${rest}` });
  }
  return moves;
}

function main() {
  const [base, ...only] = process.argv.slice(2);
  if (!base) throw new Error('usage: rename-migrations.mjs <base> [folder...]');
  const ref = baseRef(base);
  const onBase = git('ls-tree', '--name-only', `${ref}:${MIGRATIONS}/`).split('\n').filter((n) => NAME.test(n));
  const local = existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS).filter((n) => NAME.test(n)) : [];
  const moves = plan(onBase, local, only.length ? only : null);
  for (const { from, to } of moves) {
    git('mv', join(MIGRATIONS, from), join(MIGRATIONS, to));
    console.log(`renamed ${from} -> ${to}`);
  }
  if (!moves.length) console.log('nothing to rename');
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
