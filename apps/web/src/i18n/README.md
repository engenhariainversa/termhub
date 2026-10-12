# Translating the web (pt-BR → en, es)

Spec: `docs/superpowers/specs/2026-10-04-i18n-english-design.md` (its §6 glossary is binding for
English wording, §8 for Spanish). pt-BR is the source language: **the pt-BR text is the key**. Every
key has an English entry (`src/locales/en/`) and a Spanish one (`src/locales/es/`), added in the same
PR. A missing entry shows the pt-BR text, never a key.

## Wrap a string

```tsx
import { useTranslation } from '../i18n';

export function Thing({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <button title={t('Excluir projeto')} aria-label={t('Excluir {{name}}', { name })}>
      {t('Excluir')}
    </button>
  );
}
```

- Keys are literal strings: `t('…')`, `t("…")` or `` t(`…`) `` without `${}`. Values go in
  `{{placeholders}}` (`t('Projeto {{name}} criado', { name })`), never concatenated: English
  word order differs.
- Outside a component (a helper in `lib/`, an event handler that has no hook), use
  `i18n.t('…')` from `../i18n`. It reads the language at call time, so call it when the text is
  shown, not at module load.
- A sentence with markup inside: `<Trans i18nKey="Código enviado para <0>{{email}}</0>." values={{ email }} components={[<strong key="e" />]} />`.
  The key must be a string literal on the element (`i18nKey="…"`), so a sentence that changes
  with state is two `<Trans>`s in a conditional, not a conditional key.
- Keep the pt-BR text exactly as it was (tests query it), unless it was wrong.

## Labels kept in data: `tk()`

A table of labels (sections, enum names, error messages by code) keeps the pt-BR key with
`tk('…')`, which returns its argument unchanged but lets the checker find it; the place that shows
it translates with `t(item.label)`:

```ts
const SECTIONS = [{ key: 'profile', label: tk('Perfil') }];
// …
<NavLink>{t(section.label)}</NavLink>
```

Any other `t(variable)` is a bug: the checker cannot see the key, and nobody translates it. Text
that comes from the server or the user (project names, group names, server error messages) is
shown as is, never through `t()`.

## Plurals

Use `count` and give the key in its plural form. The entry goes into **every** catalog (en, es and
pt-BR), with i18next suffixes:

```ts
t('{{count}} usuários', { count: n })
```

```jsonc
// src/locales/en/<area>.json
"{{count}} usuários_one": "{{count}} user",
"{{count}} usuários_other": "{{count}} users"
// src/locales/es/<area>.json
"{{count}} usuários_one": "{{count}} usuario",
"{{count}} usuários_other": "{{count}} usuarios"
// src/locales/pt-BR/<area>.json (pt-BR catalogs hold only plural forms)
"{{count}} usuários_zero": "{{count}} usuários",
"{{count}} usuários_one": "{{count}} usuário",
"{{count}} usuários_other": "{{count}} usuários"
```

Portuguese counts 0 as "one" (`0 usuário`); add `_zero` when the zero form should read as plural.
Spanish has a `many` form (a million and up); it reads the `_other` entry, so `_one`/`_other` are enough.

## One pt-BR word, two English meanings: `context`

When the same pt-BR text means two things in English ("Atualizar" is *Update* for the agent and
*Refresh* for a list), keep the key and add a literal `context`: `t('Atualizar', { context: 'refresh' })`.
pt-BR shows the key; English reads the entry `"Atualizar_refresh": "Refresh"` (and Spanish
`"Atualizar_refresh": "Actualizar"` in its catalog). The checker
requires that entry, and it refuses one key translated two ways in two catalogs.

## Catalogs

`src/locales/en/<area>.json` and `src/locales/es/<area>.json` (same files, same keys), one area per folder of the source tree (`shell.json` for the
chrome, `common.json` for words every screen uses: Salvar, Cancelar, Excluir, Carregando…). Areas
are merged at load, so parallel PRs do not touch the same file; the same key in two files must
have the same translation. Keep each file sorted by key.

The public city build loads only `city.json`, `office.json` and `common.json`
(`src/i18n/catalogs-city.ts`), so a key used under `city/` or `office/` must have its entry in one
of those; `city/bundle.test.ts` checks it.

## Dates and numbers

Never pass `'pt-BR'` to `toLocale*` or `Intl`. Use `lib/format.ts`: `formatDate`,
`formatDateTime`, `formatTime`, `formatNumber`, `dateTimeFormat`, `relativeTime`.

## Check and guard

`npm run i18n:check -w @termhub/web` (also a vitest test, so CI runs it) fails on:

- a used key with no English or Spanish entry, or with different `{{placeholders}}`;
- a catalog entry nothing uses any more (delete it with the string);
- a plural without `_one`/`_other` in every catalog;
- JSX text, or a `title`, `placeholder`, `aria-label`, `alt`, `label`, `confirmLabel`,
  `message`, `subtitle` attribute, holding letters outside `t()`;
- a source file outside `GUARDED`.

`GUARDED` in `scripts/i18n-check.mjs` lists every top-level folder and file of `src/` (a folder
with a trailing `/`), so the whole app stays translated. A new top-level folder or file goes there.

The guard reads JSX only. Copy kept elsewhere (a label table, a `toast()`, `setError()`,
`confirm()`, `document.title`) is up to you: wrap it in `t()`/`i18n.t()`, or keep it as a `tk()`
key and translate it where it is shown.

A literal that must stay as is (a brand, code, a symbol word) takes an `i18n-ignore` comment on
its line or the line above: `// i18n-ignore` in code, `{/* i18n-ignore */}` in JSX text, or
`/* i18n-ignore */` between JSX attributes. Product names (termhub, Claude, Codex, tmux…) inside a
translated sentence need nothing: they are just part of the key.

## Tests

Tests run in pt-BR (`src/test-setup.ts` pins it), so they keep querying Portuguese text. To test
a screen in English: `i18n.changeLanguage('en')` in `beforeEach`, back to `'pt-BR'` in
`afterEach` (see `pages/LoginPage.en.test.tsx`).
