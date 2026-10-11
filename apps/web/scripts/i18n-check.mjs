#!/usr/bin/env node
/**
 * `npm run i18n:check -w @termhub/web` (spec 2026-10-04 i18n §2). Two jobs:
 *
 * 1. Catalogs. Every literal key in `t('…')`, `t("…")`, `t(`…`)` (no `${}`), `i18n.t('…')`,
 *    `tk('…')` and `<Trans i18nKey="…">` must have an entry in every translated language
 *    (`src/locales/en/*.json`, `src/locales/es/*.json`; or `_one`/`_other` plural forms, mirrored
 *    in `src/locales/pt-BR/*.json`), with the same
 *    `{{placeholders}}` as the key; and every catalog entry must still be used somewhere.
 *
 * 2. Guard. In the files and folders listed in GUARDED (the whole app: a source file outside it is a
 *    problem too, so a new top-level folder cannot slip by untranslated),
 *    JSX text and the copy attributes below may not hold letters outside `t()`. A legit literal (a
 *    brand, code, a symbol word) is allowed with an `i18n-ignore` comment on its line or the line
 *    above (`// i18n-ignore`, or `{/* i18n-ignore *\/}` inside JSX).
 *
 * How to translate a screen and add it here: src/i18n/README.md.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Paths under `src/` the untranslated-copy guard covers: a folder (trailing `/`) or a file. The whole
 * app is translated, so this is every top-level folder and file; a new one goes here too.
 */
export const GUARDED = ['App.tsx', 'main.tsx', 'test-commit.ts', 'city/', 'components/', 'i18n/', 'lib/', 'office/', 'pages/'];

/** JSX attributes that carry copy a person reads (or hears). */
export const COPY_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'confirmLabel', 'message', 'subtitle']);

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
/** The languages translated from pt-BR (the first is the reference for the summary line). */
const TARGET_LOCALES = ['en', 'es'];
const LETTER = /\p{L}/u;
const IGNORE = 'i18n-ignore';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, '..');

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'locales' ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || name.endsWith('.d.ts') || name === 'test-setup.ts') return [];
    return [path];
  });
}

const posix = (p) => p.split(sep).join('/');

function isGuarded(rel, guarded) {
  return guarded.some((g) => (g.endsWith('/') ? rel.startsWith(g) : rel === g));
}

export function placeholders(text) {
  return new Set([...text.matchAll(/{{\s*([\w.]+)[^}]*}}/g)].map((m) => m[1]));
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** Literal text a JSX expression would put on screen without passing through a call (t() or other). */
function bareLiterals(expr, out) {
  if (!expr) return;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    out.push({ node: expr, text: expr.text });
  } else if (ts.isTemplateExpression(expr)) {
    out.push({ node: expr, text: [expr.head.text, ...expr.templateSpans.map((s) => s.literal.text)].join(' ') });
    for (const span of expr.templateSpans) bareLiterals(span.expression, out);
  } else if (ts.isConditionalExpression(expr)) {
    bareLiterals(expr.whenTrue, out);
    bareLiterals(expr.whenFalse, out);
  } else if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) bareLiterals(expr.right, out);
    else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
      bareLiterals(expr.left, out);
      bareLiterals(expr.right, out);
    }
  } else if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression?.(expr)) {
    bareLiterals(expr.expression, out);
  }
}

function keyCallee(callee) {
  if (ts.isIdentifier(callee)) return callee.text === 't' || callee.text === 'tk';
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 't';
  return false;
}

function tagName(node) {
  const name = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return name.getText();
}

/** Scans one file: the keys it uses, and (when guarded) the copy it shows outside t(). */
export function scanSource(path, text, { guarded }) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split('\n');
  const keys = [];
  const problems = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const ignored = (pos) => {
    const l = lineOf(pos);
    return lines[l]?.includes(IGNORE) || (l > 0 && lines[l - 1]?.includes(IGNORE));
  };
  const flag = (pos, what, value) => {
    if (ignored(pos)) return;
    problems.push(`${path}:${lineOf(pos) + 1}: ${what} outside t(): ${JSON.stringify(value.trim().replace(/\s+/g, ' '))}`);
  };
  const checkExpr = (expr, what) => {
    const found = [];
    bareLiterals(expr, found);
    for (const f of found) if (LETTER.test(f.text)) flag(f.node.getStart(sf), what, f.text);
  };

  const visit = (node) => {
    if (ts.isCallExpression(node) && keyCallee(node.expression) && node.arguments.length > 0) {
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        // `{ context: 'x' }` picks the en entry `key_x` (one pt-BR word, two English meanings); pt-BR shows the key itself
        const opts = node.arguments[1];
        const ctx = opts && ts.isObjectLiteralExpression(opts)
          ? opts.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'context')
          : undefined;
        const suffix = ctx && ts.isStringLiteral(ctx.initializer) ? `_${ctx.initializer.text}` : '';
        if (ctx && !suffix) problems.push(`${path}:${lineOf(ctx.getStart(sf)) + 1}: context must be a string literal`);
        keys.push({ key: arg.text + suffix, where: `${path}:${lineOf(arg.getStart(sf)) + 1}` });
      }
      else if (ts.isTemplateExpression(arg)) problems.push(`${path}:${lineOf(arg.getStart(sf)) + 1}: a key built with \${} cannot be translated; use {{placeholders}}`);
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) && tagName(node) === 'Trans') {
      const attrs = (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties;
      for (const a of attrs) {
        if (ts.isJsxAttribute(a) && a.name.getText() === 'i18nKey' && a.initializer && ts.isStringLiteral(a.initializer)) {
          keys.push({ key: a.initializer.text, where: `${path}:${lineOf(a.getStart(sf)) + 1}` });
        }
      }
    }
    if (guarded) {
      if (ts.isJsxText(node) && LETTER.test(node.text)) {
        flag(node.pos + node.getFullText(sf).search(/\S/), 'JSX text', node.text);
      } else if (ts.isJsxAttribute(node) && COPY_ATTRIBUTES.has(node.name.getText()) && node.initializer) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) {
          if (LETTER.test(init.text)) flag(init.getStart(sf), `${node.name.getText()}=`, init.text);
        } else if (ts.isJsxExpression(init)) checkExpr(init.expression, `${node.name.getText()}=`);
      } else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
        checkExpr(node.expression, 'JSX text');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { keys, problems };
}

function loadCatalog(dir, problems) {
  const merged = {};
  if (!existsSync(dir)) return merged;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const file = join(dir, name);
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`${file}: not valid JSON (${e.message})`);
      continue;
    }
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== 'string' || v === '') problems.push(`${file}: "${k}" must be a non-empty string`);
      else if (k in merged && merged[k] !== v) problems.push(`${file}: "${k}" is translated differently in another file ("${merged[k]}")`);
      else merged[k] = v;
    }
  }
  return merged;
}

const pluralBase = (k) => {
  const s = PLURAL_SUFFIXES.find((x) => k.endsWith(x));
  return s ? k.slice(0, -s.length) : null;
};

/** Runs both checks; returns the problems found (empty = pass). */
export function runCheck({ root = DEFAULT_ROOT, guarded = GUARDED } = {}) {
  const src = join(root, 'src');
  const problems = [];
  const used = new Map();
  for (const file of sourceFiles(src)) {
    const rel = posix(relative(src, file));
    const isG = isGuarded(rel, guarded);
    if (!isG) problems.push(`${posix(relative(root, file))}: not under GUARDED; add its top-level folder or file to GUARDED in scripts/i18n-check.mjs`);
    const r = scanSource(posix(relative(root, file)), readFileSync(file, 'utf8'), { guarded: isG });
    problems.push(...r.problems);
    for (const k of r.keys) if (!used.has(k.key)) used.set(k.key, k.where);
  }

  // Every language but pt-BR (the keys' own language) has a full catalog.
  const targets = TARGET_LOCALES.map((lang) => [lang, loadCatalog(join(src, 'locales', lang), problems)]);
  const en = targets[0][1];
  const pt = loadCatalog(join(src, 'locales', 'pt-BR'), problems);

  for (const [key, where] of used) {
    const isPlural = targets.some(([, cat]) => PLURAL_SUFFIXES.some((s) => `${key}${s}` in cat));
    if (isPlural) {
      for (const [lang, cat] of [...targets, ['pt-BR', pt]]) {
        if (!(`${key}_one` in cat && `${key}_other` in cat)) problems.push(`${where}: plural "${key}" needs ${lang} "_one" and "_other"`);
      }
      const allowed = new Set([...placeholders(key), 'count']);
      for (const [, cat] of [...targets, ['pt-BR', pt]]) {
        for (const s of PLURAL_SUFFIXES) {
          const v = cat[`${key}${s}`];
          if (v && ![...placeholders(v)].every((p) => allowed.has(p))) problems.push(`${where}: "${key}${s}" uses a placeholder the key does not have`);
        }
      }
      continue;
    }
    for (const [lang, cat] of targets) {
      if (!(key in cat)) {
        problems.push(`${where}: missing ${lang} entry for "${key}"`);
        continue;
      }
      if (!sameSet(placeholders(key), placeholders(cat[key]))) problems.push(`${where}: placeholders differ between "${key}" and its ${lang} entry "${cat[key]}"`);
    }
  }

  for (const [lang, cat] of [...targets, ['pt-BR', pt]]) {
    for (const k of Object.keys(cat)) {
      const base = pluralBase(k);
      if (used.has(k) && lang !== 'pt-BR') continue;
      if (base !== null && used.has(base)) continue;
      if (lang === 'pt-BR' && base === null) problems.push(`src/locales/pt-BR: "${k}" is not a plural form; pt-BR catalogs only hold plurals (the key is the pt-BR text)`);
      else problems.push(`src/locales/${lang}: "${k}" is not used anywhere`);
    }
  }
  return { problems, keys: used.size, entries: Object.keys(en).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { problems, keys, entries } = runCheck();
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\ni18n:check failed: ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log(`i18n:check ok: ${keys} keys, ${entries} en entries, ${GUARDED.length} guarded paths.`);
}
