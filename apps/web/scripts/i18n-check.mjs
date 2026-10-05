#!/usr/bin/env node
/**
 * `npm run i18n:check -w @termhub/web` (spec 2026-10-04 i18n §2). Two jobs:
 *
 * 1. Catalogs. Every literal key in `t('…')`, `t("…")`, `t(`…`)` (no `${}`), `i18n.t('…')`,
 *    `tk('…')` and `<Trans i18nKey="…">` must have an English entry in `src/locales/en/*.json`
 *    (or `_one`/`_other` plural forms, mirrored in `src/locales/pt-BR/*.json`), with the same
 *    `{{placeholders}}` as the key; and every catalog entry must still be used somewhere.
 *
 * 2. Guard. In the files and folders listed in GUARDED (the parts of the app already translated),
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
 * Paths under `src/` the untranslated-copy guard covers: a folder (trailing `/`) or a file. Add a
 * folder or file once every string in it goes through `t()`; at the end, this is every folder.
 */
export const GUARDED = [
  'App.tsx',
  'main.tsx',
  'i18n/',
  'components/Layout.tsx',
  'components/MainNav.tsx',
  'components/Sidebar.tsx',
  'components/SidebarRail.tsx',
  'components/SettingsSidebar.tsx',
  'components/ProfileButton.tsx',
  'components/ProfileView.tsx',
  'components/LanguageSetting.tsx',
  'components/PageHeader.tsx',
  'components/ChatLayout.tsx',
  'components/GroupHeader.tsx',
  'components/ProjectRow.tsx',
  'components/ProjectGroupsMenu.tsx',
  'components/ErrorBoundary.tsx',
  'components/PendingDeletionPage.tsx',
  'components/ViewAsSwitch.tsx',
  'components/Modal.tsx',
  'components/CookieBanner.tsx',
  'components/DeviceRequestBanner.tsx',
  'components/NeedsYouToasts.tsx',
  'components/NicknamePrompt.tsx',
  'lib/toast.tsx',
  'lib/view-as.ts',
  'pages/LoginPage.tsx',
  'pages/SettingsPage.tsx',
  'lib/settings-sections.ts',
  'lib/format.ts',
  // board + projects
  'components/BacklogView.tsx',
  'components/BoardColumnsSettings.tsx',
  'components/CardPullRequests.tsx',
  'components/ProjectAiCard.tsx',
  'components/ProjectCards.tsx',
  'components/ProjectForm.tsx',
  'components/ProjectSettings.tsx',
  'components/SubtaskList.tsx',
  'components/TaskEditor.tsx',
  'components/TasksBoard.tsx',
  'components/TicketsView.tsx',
  'components/TypeBadge.tsx',
  'components/NotesEditor.tsx',
  'components/ProgressPanel.tsx',
  'components/NeedsYouList.tsx',
  'pages/CardPage.tsx',
  'pages/ProjectPage.tsx',
  'pages/HomePage.tsx',
  'lib/board.ts',
  'lib/epic-summary.ts',
  'lib/ticket-link.ts',
  'lib/home-onboarding.ts',
  'lib/project-groups-model.ts',
  'lib/project-groups.tsx',
  'lib/progress.ts',
  'lib/needs-you.ts',
  // chat
  'components/chat/',
  'pages/ChatMemoryPage.tsx',
  'pages/ChatPage.tsx',
  'lib/chat-context.ts',
  'lib/chat-inbox.ts',
  'lib/chat-live.ts',
  'lib/chat-merge.ts',
  'lib/chat-notice.ts',
  'lib/chat-pool.ts',
  'lib/chat-reply.ts',
  'lib/chat-scroll.ts',
  'lib/chat-timeline.ts',
  'lib/chat.tsx',
  'lib/project-chat.tsx',
  'lib/project-chat-prefs.ts',
  'lib/subagents.ts',
  'lib/use-dictation.ts',
  'lib/voice-recorder.ts',
  'lib/voice-store.ts',
  'lib/attachments.ts',
  'lib/code-blocks.ts',
  'lib/markdown.ts',
  // settings + city
  'components/AiAccountsView.tsx',
  'components/ApiTokensView.tsx',
  'components/AutoSwapSettings.tsx',
  'components/ChatGrantsView.tsx',
  'components/DeleteAccountDialog.tsx',
  'components/DevicesView.tsx',
  'components/HardwareView.tsx',
  'components/IntegrationsView.tsx',
  'components/MyCityView.tsx',
  'components/NicknameDialog.tsx',
  'components/ReviewAccountPanel.tsx',
  'components/UploadsView.tsx',
  'components/WaitlistView.tsx',
  'components/AnalyticsGate.tsx',
  'components/RateLimitBanner.tsx',
  'components/PublishControl.tsx',
  'city/',
  'lib/account-deletion.ts',
  'lib/city-link.ts',
  'lib/public-city.ts',
  'lib/consent.ts',
  // machines + terminal + office
  'components/AgentEnrollment.tsx',
  'components/AgentUpdateCard.tsx',
  'components/Avatar.tsx',
  'components/DirectoryBrowser.tsx',
  'components/DropdownMenu.tsx',
  'components/FileView.tsx',
  'components/FloatingWindow.tsx',
  'components/MachineForm.tsx',
  'components/MachinePicker.tsx',
  'components/MonitorHooksCard.tsx',
  'components/OfficeEmptyState.tsx',
  'components/PaneLayer.tsx',
  'components/ProjectMachines.tsx',
  'components/SetupForm.tsx',
  'components/SimulatorSetupCard.tsx',
  'components/SimulatorView.tsx',
  'components/TabBar.tsx',
  'components/Terminal.tsx',
  'components/TerminalsView.tsx',
  'pages/MachinesPage.tsx',
  'pages/OfficePage.tsx',
  'pages/FilePage.tsx',
  'office/',
  'lib/machine-labels.ts',
  'lib/machine-status.ts',
  'lib/terminal-connection.ts',
  'lib/simulator-connection.ts',
  'lib/reconnect.ts',
  'lib/local-machines.ts',
  'lib/md-paths.ts',
  'lib/connect-gate.ts',
  'lib/monitor.tsx',
  'lib/lazy-retry.ts',
];

/** JSX attributes that carry copy a person reads (or hears). */
export const COPY_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'confirmLabel', 'message', 'subtitle']);

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
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
    const r = scanSource(posix(relative(root, file)), readFileSync(file, 'utf8'), { guarded: isGuarded(rel, guarded) });
    problems.push(...r.problems);
    for (const k of r.keys) if (!used.has(k.key)) used.set(k.key, k.where);
  }

  const en = loadCatalog(join(src, 'locales', 'en'), problems);
  const pt = loadCatalog(join(src, 'locales', 'pt-BR'), problems);

  for (const [key, where] of used) {
    const forms = PLURAL_SUFFIXES.filter((s) => `${key}${s}` in en);
    if (forms.length > 0) {
      if (!(`${key}_one` in en && `${key}_other` in en)) problems.push(`${where}: plural "${key}" needs en "_one" and "_other"`);
      if (!(`${key}_one` in pt && `${key}_other` in pt)) problems.push(`${where}: plural "${key}" needs pt-BR "_one" and "_other"`);
      const allowed = new Set([...placeholders(key), 'count']);
      for (const cat of [en, pt]) {
        for (const s of PLURAL_SUFFIXES) {
          const v = cat[`${key}${s}`];
          if (v && ![...placeholders(v)].every((p) => allowed.has(p))) problems.push(`${where}: "${key}${s}" uses a placeholder the key does not have`);
        }
      }
      continue;
    }
    if (!(key in en)) {
      problems.push(`${where}: missing en entry for "${key}"`);
      continue;
    }
    if (!sameSet(placeholders(key), placeholders(en[key]))) problems.push(`${where}: placeholders differ between "${key}" and its en entry "${en[key]}"`);
  }

  for (const [lang, cat] of [['en', en], ['pt-BR', pt]]) {
    for (const k of Object.keys(cat)) {
      const base = pluralBase(k);
      if (used.has(k) && lang === 'en') continue;
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
