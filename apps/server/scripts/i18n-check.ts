/**
 * `npm run i18n:check -w @termhub/server` (also run as a vitest test, src/i18n/catalog-check.test.ts).
 *
 * Scans the server's source for literal pt-BR keys — `t(locale, '…')`, `msg('…')`, `tk('…')`, the
 * error helpers (`badRequest('…')`, `notFound`, `unauthorized`, `forbidden`, `conflict`), and the
 * error classes (`new HttpError(status, '…')`, `new ControlError(code, '…')`, the repository rule
 * errors) — and fails when:
 *  - a key has no English or Spanish entry (plural keys: `_one`/`_other` in every catalog, pt-BR included);
 *  - an entry's `{{placeholders}}` differ from its key's;
 *  - a catalog entry is no longer used;
 *  - a message is a template literal with `${…}` (use `msg('… {{x}} …', { x })`) or a concatenation;
 *  - a catalog file on disk is not loaded by `src/i18n/catalog.ts` (or a key is in two files).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(SERVER_ROOT, 'src');
const LOCALES_DIR = path.join(SRC, 'i18n', 'locales');

/** Callee → how many arguments come before the message. */
const CALLEES: Record<string, number> = {
  t: 1,
  msg: 0,
  tk: 0,
  badRequest: 0,
  notFound: 0,
  unauthorized: 0,
  forbidden: 0,
  conflict: 0,
  'new HttpError': 1,
  'new ControlError': 1,
  'new TaskRuleError': 1,
  'new ProjectRuleError': 1,
  'new ProjectGroupRuleError': 1,
  sendError: 3,
};
const CALL_RE = new RegExp(
  `(?<![\\w.$])(${Object.keys(CALLEES)
    .map((c) => c.replace(' ', '\\s+'))
    .join('|')})\\(`,
  'g',
);

/** Files that define the helpers rather than use them. */
const SKIP = new Set([path.join(SRC, 'i18n', 'index.ts')]);

export interface Usage {
  key: string;
  file: string;
  line: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !SKIP.has(full)) {
      out.push(full);
    }
  }
  return out;
}

function unescape(body: string): string {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e: string) => {
    if (e.startsWith('u{')) return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e.startsWith('u') && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e.startsWith('x') && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\n': '' } as Record<string, string>)[e] ?? e;
  });
}

/** Reads a string literal starting at `i` (a quote); returns its raw body and the index after it. */
function readString(src: string, i: number): { body: string; end: number } {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
  return { body: src.slice(i + 1, j), end: j + 1 };
}

/** Skips one argument (balanced brackets, strings) and returns the index of the `,` or `)` after it. */
function skipArg(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = readString(src, i).end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (c === ',' && depth === 0) return i;
    i++;
  }
  return i;
}

function skipSpace(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith('//', i)) i = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (src.startsWith('/*', i)) i = src.indexOf('*/', i) + 2;
    else return i;
  }
}

export function scanSource(src: string, file: string): { usages: Usage[]; problems: string[] } {
  const usages: Usage[] = [];
  const problems: string[] = [];
  const lineOf = (i: number) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(CALL_RE)) {
    const callee = m[1].replace(/\s+/, ' ');
    let i = m.index! + m[0].length;
    for (let n = 0; n < CALLEES[callee]; n++) {
      i = skipArg(src, i);
      if (src[i] !== ',') break;
      i++;
    }
    i = skipSpace(src, i);
    const c = src[i];
    if (c !== "'" && c !== '"' && c !== '`') continue; // a variable, a call or nothing: not a literal key
    const { body, end } = readString(src, i);
    const where = `${path.relative(SERVER_ROOT, file)}:${lineOf(i)}`;
    if (c === '`' && body.includes('${')) {
      problems.push(`${where}: ${callee}() with an interpolated template literal; use msg('… {{x}} …', { x })`);
      continue;
    }
    const after = src[skipSpace(src, end)];
    if (after === '+') {
      problems.push(`${where}: ${callee}() with a message built from parts; use one literal key with {{placeholders}}`);
      continue;
    }
    if (after !== ',' && after !== ')') continue; // an expression that starts with a literal (`'x' in y ? …`): not a key
    usages.push({ key: unescape(body), file: where, line: lineOf(i) });
  }
  return { usages, problems };
}

const PLURAL = /_(zero|one|two|few|many|other)$/;
/** The languages translated from pt-BR; each has a full catalog under locales/<lang>/. */
const TARGET_LOCALES = ['en', 'es'] as const;
const LANGUAGE_NAMES: Record<string, string> = { en: 'English', es: 'Spanish' };
const placeholders = (s: string) => new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]));
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Every `locales/<lang>/*.json` merged per language, with duplicate keys reported. */
export function readCatalogFiles(dir = LOCALES_DIR): { catalogs: Record<string, Record<string, string>>; problems: string[] } {
  const catalogs: Record<string, Record<string, string>> = {};
  const problems: string[] = [];
  for (const lang of fs.readdirSync(dir)) {
    if (!fs.statSync(path.join(dir, lang)).isDirectory()) continue;
    const merged: Record<string, string> = {};
    for (const f of fs.readdirSync(path.join(dir, lang)).filter((f) => f.endsWith('.json'))) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, lang, f), 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        if (k in merged) problems.push(`locales/${lang}/${f}: "${k}" is already in another ${lang} file`);
        if (typeof v !== 'string' || v.trim() === '') problems.push(`locales/${lang}/${f}: "${k}" has an empty translation`);
        merged[k] = v;
      }
    }
    catalogs[lang] = merged;
  }
  return { catalogs, problems };
}

export function checkI18n(loaded?: Record<string, Record<string, string>>): { problems: string[]; keys: number } {
  const problems: string[] = [];
  const used = new Map<string, Usage>();
  for (const file of walk(SRC)) {
    const r = scanSource(fs.readFileSync(file, 'utf8'), file);
    problems.push(...r.problems);
    for (const u of r.usages) if (!used.has(u.key)) used.set(u.key, u);
  }
  const files = readCatalogFiles();
  problems.push(...files.problems);
  const pt = files.catalogs['pt-BR'] ?? {};
  // Every language but pt-BR (the keys' own language) must translate every key.
  const targets = TARGET_LOCALES.map((lang) => [lang, files.catalogs[lang] ?? {}] as const);
  const isPlural = (key: string) => targets.some(([, cat]) => Object.keys(cat).some((k) => PLURAL.test(k) && k.replace(PLURAL, '') === key));

  for (const [key, u] of used) {
    const keyVars = placeholders(key);
    if (isPlural(key)) {
      for (const [lang, cat] of [...targets, ['pt-BR', pt] as const]) {
        for (const suffix of ['_one', '_other']) {
          const v = cat[key + suffix];
          if (v === undefined) problems.push(`${u.file}: plural key "${key}" has no ${lang} entry "${key}${suffix}"`);
          else if (![...placeholders(v)].every((p) => keyVars.has(p) || p === 'count'))
            problems.push(`${u.file}: ${lang} "${key}${suffix}" uses placeholders the key does not have`);
        }
      }
      continue;
    }
    for (const [lang, cat] of targets) {
      const v = cat[key];
      if (v === undefined) problems.push(`${u.file}: no ${LANGUAGE_NAMES[lang]} (${lang}) entry for "${key}"`);
      else if (!sameSet(placeholders(v), keyVars)) problems.push(`${u.file}: placeholders of the ${lang} entry differ from the key "${key}"`);
    }
  }
  for (const [lang, cat] of Object.entries(files.catalogs)) {
    for (const k of Object.keys(cat)) {
      if (!used.has(k) && !used.has(k.replace(PLURAL, ''))) problems.push(`locales/${lang}: "${k}" is not used anywhere`);
    }
  }
  if (loaded) {
    for (const [lang, cat] of Object.entries(files.catalogs)) {
      const missing = Object.keys(cat).filter((k) => loaded[lang]?.[k] === undefined);
      if (missing.length > 0) problems.push(`locales/${lang}: ${missing.length} entries on disk are not loaded by src/i18n/catalog.ts (add the file there)`);
    }
  }
  return { problems, keys: used.size };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { CATALOGS } = await import('../src/i18n/catalog.js');
  const { problems, keys } = checkI18n(CATALOGS as Record<string, Record<string, string>>);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`\ni18n:check: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`i18n:check: ${keys} keys, all translated`);
}
