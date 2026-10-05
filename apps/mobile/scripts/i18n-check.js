#!/usr/bin/env node
/* eslint-disable */
// `npm run i18n:check -w @termhub/mobile` (i18n spec §2): keeps the catalogs and the code in step.
//
// Keys are the pt-BR text, found as literal first arguments of `t('…')`, `i18n.t('…')` and
// `tk('…')` (a label kept in data, translated where it is shown). It fails when:
//   - a key has no `en` entry (a plural key — `t('…', { count })` — needs `_one` and `_other` in
//     both `en` and `pt-BR`);
//   - an entry's `{{placeholders}}` differ from its key's (a plural form may drop `{{count}}`);
//   - a catalog entry is no longer used, or two area files give one key different texts;
//   - in a GUARDED folder, JSX text, a string literal in a text attribute (`title`, `placeholder`,
//     `accessibilityLabel`, `label`…) or an `Alert.alert` argument holds letters outside `t()`.
// A line ending in (or preceded by a line holding only) `// i18n-ignore` is skipped by the guard.
//
// Uses the TypeScript compiler API, so a key spread over lines or written with backticks is read
// exactly as the compiler sees it.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['app', 'src'];

/** Folders (relative to apps/mobile, `/`-separated) the untranslated-copy guard covers. */
const GUARDED = ['app', 'src'];

/** Attributes whose string value is shown to (or read out for) a person. */
const TEXT_ATTRIBUTES = new Set([
  'title',
  'subtitle',
  'placeholder',
  'accessibilityLabel',
  'accessibilityHint',
  'label',
  'hint',
  'description',
  'message',
  'confirmLabel',
  'cancelLabel',
  'emptyText',
  'caption',
  'heading',
  'body',
  'text',
]);

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
const HAS_LETTER = /\p{L}/u;

function listSources(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'locales') continue;
      out.push(...listSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function placeholders(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/\{\{\s*([^}\s,]+)[^}]*\}\}/g)) found.add(m[1]);
  return found;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function loadCatalogs(lang, problems) {
  const dir = path.join(ROOT, 'src', 'locales', lang);
  const merged = new Map();
  if (!fs.existsSync(dir)) return merged;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const rel = `src/locales/${lang}/${file}`;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      problems.push(`${rel}: invalid JSON (${e.message})`);
      continue;
    }
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string') {
        problems.push(`${rel}: "${key}" is not a string`);
        continue;
      }
      const prev = merged.get(key);
      if (prev && prev.value !== value) problems.push(`${rel}: "${key}" is also in ${prev.file} with another text`);
      if (!prev) merged.set(key, { value, file: rel });
    }
  }
  return merged;
}

function isGuarded(rel) {
  return GUARDED.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** A template with substitutions still holds copy in its fixed parts. */
function templateHasLetters(node) {
  if (!ts.isTemplateExpression(node)) return false;
  return HAS_LETTER.test(node.head.text) || node.templateSpans.some((s) => HAS_LETTER.test(s.literal.text));
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function hasCountOption(arg) {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && p.name.getText() === 'count');
}

function scanFile(file, keys, problems) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split('\n');
  const guarded = isGuarded(rel);

  const ignored = (node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if ((lines[line] || '').includes('i18n-ignore')) return true;
    const prev = (lines[line - 1] || '').trim();
    return /^(\/\/|\{\/\*|\/\*).*i18n-ignore/.test(prev);
  };
  const where = (node) => `${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const flag = (node, what, value) => {
    if (!ignored(node)) problems.push(`${where(node)}: untranslated ${what}: ${JSON.stringify(value.trim().slice(0, 80))}`);
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === 't' || name === 'tk') {
        const key = literalText(node.arguments[0]);
        if (key !== null) {
          const plural = name === 't' && hasCountOption(node.arguments[1]);
          const prev = keys.get(key);
          keys.set(key, { plural: plural || (prev ? prev.plural : false), at: prev ? prev.at : where(node) });
        }
      }
      if (guarded && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'alert' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Alert') {
        for (const arg of node.arguments.slice(0, 2)) {
          const value = literalText(arg);
          if (value !== null && HAS_LETTER.test(value)) flag(arg, 'Alert text', value);
          else if (templateHasLetters(arg)) flag(arg, 'Alert text', arg.getText(source));
        }
      }
    }
    if (guarded) {
      if (ts.isJsxText(node) && HAS_LETTER.test(node.text)) flag(node, 'JSX text', node.text);
      if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
        const value = literalText(node.expression);
        if (value !== null && HAS_LETTER.test(value)) flag(node, 'JSX text', value);
        else if (templateHasLetters(node.expression)) flag(node, 'JSX text', node.expression.getText(source));
      }
      if (ts.isJsxAttribute(node) && node.initializer) {
        const attr = node.name.getText(source);
        if (TEXT_ATTRIBUTES.has(attr)) {
          const init = node.initializer;
          let value = literalText(init);
          if (value === null && ts.isJsxExpression(init) && init.expression) {
            value = literalText(init.expression);
            if (value === null && templateHasLetters(init.expression)) value = init.expression.getText(source);
          }
          if (value !== null && HAS_LETTER.test(value)) flag(node, `${attr}=`, value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function baseOfPlural(key) {
  for (const suffix of PLURAL_SUFFIXES) if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  return null;
}

/** Runs every check; returns the problems (empty when all is well) and what it saw. */
function checkI18n() {
  const problems = [];
  const keys = new Map();
  for (const dir of SOURCE_DIRS) for (const file of listSources(path.join(ROOT, dir))) scanFile(file, keys, problems);

  const en = loadCatalogs('en', problems);
  const pt = loadCatalogs('pt-BR', problems);

  for (const [key, info] of keys) {
    const keyVars = placeholders(key);
    if (info.plural) {
      for (const [lang, catalog] of [['en', en], ['pt-BR', pt]]) {
        for (const suffix of ['_one', '_other']) {
          const entry = catalog.get(key + suffix);
          if (!entry) {
            problems.push(`${info.at}: plural key ${JSON.stringify(key)} has no ${lang} entry "${key}${suffix}"`);
            continue;
          }
          const allowed = new Set([...keyVars, 'count']);
          for (const v of placeholders(entry.value)) {
            if (!allowed.has(v)) problems.push(`${entry.file}: "${key}${suffix}" uses {{${v}}}, which the key does not have`);
          }
        }
      }
      continue;
    }
    const entry = en.get(key);
    if (!entry) {
      problems.push(`${info.at}: no en entry for ${JSON.stringify(key)}`);
      continue;
    }
    if (!sameSet(keyVars, placeholders(entry.value))) {
      problems.push(`${entry.file}: placeholders of "${key}" differ: key {${[...keyVars].join(', ')}} vs en {${[...placeholders(entry.value)].join(', ')}}`);
    }
  }

  for (const [lang, catalog] of [['en', en], ['pt-BR', pt]]) {
    for (const [key, entry] of catalog) {
      const used = keys.get(key);
      if (used && !used.plural && lang === 'en') continue;
      const base = baseOfPlural(key);
      if (base !== null && keys.has(base) && keys.get(base).plural) continue;
      if (used && used.plural) {
        problems.push(`${entry.file}: "${key}" is used as a plural key; give it _one/_other forms instead`);
        continue;
      }
      problems.push(`${entry.file}: unused entry "${key}"`);
    }
  }

  return { problems, keys: keys.size, en: en.size, pt: pt.size, guarded: GUARDED };
}

module.exports = { checkI18n, GUARDED, TEXT_ATTRIBUTES };

if (require.main === module) {
  const result = checkI18n();
  if (result.problems.length) {
    for (const p of result.problems) console.error(p);
    console.error(`\ni18n:check — ${result.problems.length} problem(s).`);
    process.exit(1);
  }
  console.log(`i18n:check — ${result.keys} keys, ${result.en} en entries, ${result.pt} pt-BR plural entries; guard on ${result.guarded.join(', ')}.`);
}
