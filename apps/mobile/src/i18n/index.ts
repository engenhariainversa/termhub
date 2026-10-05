// The app's translation layer (i18n spec §2, §3). The pt-BR text is the key: `t('Salvar')` shows
// "Salvar" in pt-BR (no catalog needed) and the `en` catalog's entry in English; a missing English
// entry falls back to the pt-BR text, never to a key. The choice lives on this device only (MMKV);
// null means automatic: the phone's language (`Intl`, no native module — this ships over OTA).
//
// Plain module, no React Native: models and viewmodels call `t()` too, and they run in the `logic`
// jest project. Views call `useTranslation()` so they re-render when the language changes.
import i18next, { type TOptions } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { create } from 'zustand';
import { mmkv } from '@/services/storage';
import { ensurePluralRules } from './plural-rules';
import { resources } from './resources';

export type Locale = 'pt-BR' | 'en';
export const LOCALES: Locale[] = ['pt-BR', 'en'];
export const DEFAULT_LOCALE: Locale = 'pt-BR';

/** The MMKV key of the device's explicit choice; absent means automatic. Kept across a wipe. */
export const LOCALE_STORAGE_KEY = 'locale';

function isLocale(value: unknown): value is Locale {
  return value === 'pt-BR' || value === 'en';
}

/**
 * Explicit choice → the system languages in order (first `pt*` → pt-BR, first `en*` → en) →
 * pt-BR. Anything else (Spanish, say) reads pt-BR until there is a catalog for it.
 */
export function resolveLocale(choice: Locale | null, systemLanguages: readonly string[]): Locale {
  if (choice && isLocale(choice)) return choice;
  for (const raw of systemLanguages) {
    const lang = String(raw).toLowerCase();
    if (lang.startsWith('pt')) return 'pt-BR';
    if (lang.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

/**
 * The phone's language, as Hermes' `Intl` reports it. Under Jest, `TERMHUB_TEST_LOCALE` (set by the
 * test setup) stands in for it, so the suite runs in pt-BR whatever the machine's locale is.
 */
export function systemLanguages(): string[] {
  const pinned = typeof process !== 'undefined' ? process.env?.TERMHUB_TEST_LOCALE : undefined;
  if (pinned) return [pinned];
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return [];
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale ? [locale] : [];
  } catch {
    return [];
  }
}

function readChoice(): Locale | null {
  try {
    const stored = mmkv.getString(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeChoice(choice: Locale | null): void {
  try {
    if (choice) mmkv.set(LOCALE_STORAGE_KEY, choice);
    else mmkv.delete(LOCALE_STORAGE_KEY);
  } catch {
    // Storage unavailable: the choice still applies until the app restarts.
  }
}

ensurePluralRules();

const initialChoice = readChoice();
const initialLocale = resolveLocale(initialChoice, systemLanguages());

void i18next.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: LOCALES,
  // The pt-BR text is the key: dots, colons and question marks inside it are plain text.
  keySeparator: false,
  nsSeparator: false,
  // React Native renders text, never HTML.
  interpolation: { escapeValue: false },
  returnNull: false,
  returnEmptyString: false,
  initAsync: false,
  react: { useSuspense: false },
});

interface LocaleState {
  /** The device's explicit choice; null = automatic. */
  choice: Locale | null;
  /** What the app shows now. */
  locale: Locale;
}

/** The language choice as React state (Ajustes → Idioma reads it). Change it with `setLocale`. */
export const useLocaleStore = create<LocaleState>()(() => ({ choice: initialChoice, locale: initialLocale }));

/** Sets the device's choice (null = automatic), persists it and switches the app at once. */
export function setLocale(next: Locale | null): void {
  const choice = next && isLocale(next) ? next : null;
  writeChoice(choice);
  const locale = resolveLocale(choice, systemLanguages());
  useLocaleStore.setState({ choice, locale });
  if (i18next.language !== locale) void i18next.changeLanguage(locale);
}

/** What the app shows now. */
export function currentLocale(): Locale {
  return useLocaleStore.getState().locale;
}

/**
 * Translates outside React (models, viewmodels, notification texts), with the language current at
 * call time. Views use `useTranslation()` instead, so they re-render on a change.
 */
export function t(key: string, options?: TOptions): string {
  return i18next.t(key, options as TOptions) as string;
}

/** Marks a pt-BR key kept in data (a table, a constant) so `i18n:check` finds it; returns it unchanged. */
export const tk = <T extends string>(text: T): T => text;

export { i18next as i18n };
export { useTranslation } from 'react-i18next';
