# Translating the web (pt-BR → en)

Spec: `docs/superpowers/specs/2026-10-04-i18n-english-design.md` (its §6 glossary is binding for
English wording). pt-BR is the source language: **the pt-BR text is the key**. A missing English
entry shows the pt-BR text, never a key.

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

Use `count` and give the key in its plural form. The entry goes into **both** catalogs, with
i18next suffixes:

```ts
t('{{count}} usuários', { count: n })
```

```jsonc
// src/locales/en/<area>.json
"{{count}} usuários_one": "{{count}} user",
"{{count}} usuários_other": "{{count}} users"
// src/locales/pt-BR/<area>.json (pt-BR catalogs hold only plural forms)
"{{count}} usuários_zero": "{{count}} usuários",
"{{count}} usuários_one": "{{count}} usuário",
"{{count}} usuários_other": "{{count}} usuários"
```

Portuguese counts 0 as "one" (`0 usuário`); add `_zero` when the zero form should read as plural.

## Catalogs

`src/locales/en/<area>.json`, one area per folder of the source tree (`shell.json` for the
chrome, `common.json` for words every screen uses: Salvar, Cancelar, Excluir, Carregando…). Areas
are merged at load, so parallel PRs do not touch the same file; the same key in two files must
have the same translation. Keep each file sorted by key.

## Dates and numbers

Never pass `'pt-BR'` to `toLocale*` or `Intl`. Use `lib/format.ts`: `formatDate`,
`formatDateTime`, `formatTime`, `formatNumber`, `dateTimeFormat`, `relativeTime`.

## Check and guard

`npm run i18n:check -w @termhub/web` (also a vitest test, so CI runs it) fails on:

- a used key with no English entry, or with different `{{placeholders}}`;
- a catalog entry nothing uses any more (delete it with the string);
- a plural without `_one`/`_other` in both catalogs;
- in a **guarded** file: JSX text, or a `title`, `placeholder`, `aria-label`, `alt`, `label`,
  `confirmLabel`, `message`, `subtitle` attribute, holding letters outside `t()`.

When a folder (or file) is fully translated, add it to `GUARDED` in `scripts/i18n-check.mjs`
(a folder with a trailing `/`, e.g. `'components/chat/'`), so it stays translated.

A literal that must stay as is (a brand, code, a symbol word) takes an `i18n-ignore` comment on
its line or the line above: `// i18n-ignore` in code, `{/* i18n-ignore */}` in JSX text, or
`/* i18n-ignore */` between JSX attributes. Product names (termhub, Claude, Codex, tmux…) inside a
translated sentence need nothing: they are just part of the key.

## Tests

Tests run in pt-BR (`src/test-setup.ts` pins it), so they keep querying Portuguese text. To test
a screen in English: `i18n.changeLanguage('en')` in `beforeEach`, back to `'pt-BR'` in
`afterEach` (see `pages/LoginPage.en.test.tsx`).
